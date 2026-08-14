/**
 * The whole client-server contract, such as it is.
 *
 * Every call is same-origin against the /api rewrite, so the session cookie
 * travels on its own and there is no token to store, refresh or leak.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    // Nest puts the useful sentence in `message`; it is often a list.
    const body = (await response.json().catch(() => null)) as { message?: string | string[] } | null;
    const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
    throw new ApiError(response.status, message || `request failed (${response.status})`);
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export type FileStatus =
  | 'PENDING'
  | 'ENCODING'
  | 'UPLOADING'
  | 'PROCESSING'
  | 'VERIFYING'
  | 'READY'
  | 'FAILED';

export interface StoredFile {
  id: string;
  name: string;
  size: number;
  sha256: string;
  status: FileStatus;
  error: string | null;
  /** Null once verification has released the local copy; the bytes then live only on YouTube. */
  sourcePath: string | null;
  videoId: string | null;
  progress: number;
  verifyAttempts: number;
  lastCheckedAt: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

export interface Account {
  id: string;
  label: string;
  clientId: string;
  connected: boolean;
  hasCookies: boolean;
  cookieHealth: 'MISSING' | 'OK' | 'STALE';
  cookieCheckedAt: string | null;
  quota: { used: number; remaining: number; uploadsLeft: number };
  ready: boolean;
  createdAt: string;
}

export interface Status {
  accounts: Account[];
  canUpload: boolean;
  uploadsLeftToday: number;
  files: Partial<Record<FileStatus, number>>;
}

export interface TarEntry {
  name: string;
  size: number;
  offset: number;
}

export function entryUrl(id: string, index: number, inline = false): string {
  return `/api/files/${id}/entries/${index}/download${inline ? '?inline=1' : ''}`;
}

/**
 * Uploads over XHR rather than fetch, which cannot report upload progress.
 * The files here are large enough that a form with no feedback is unusable.
 *
 * Several files go in one request and come back as one archive, because an
 * upload costs 1,600 quota units whatever it weighs — six a day, total. Sending
 * a folder file by file would spend the whole day's budget on six photos.
 */
/**
 * Reads every file into memory before a byte is sent.
 *
 * Handing a `File` straight to XHR does not copy anything: the browser keeps a
 * reference and reads from disk *while* uploading. If that read fails part way
 * — the file moved or was renamed since it was picked, it lives on a network
 * share, or, the usual one on macOS, it is an iCloud placeholder that was never
 * downloaded — the browser aborts its own request and reports a network error.
 * Chrome and Brave call it `net::ERR_UPLOAD_FILE_CHANGED`. The server sees
 * nothing at all, which makes it look like the app is broken.
 *
 * Reading first turns that into a plain error naming the file, and the upload
 * then streams from memory where nothing can change underneath it. The cost is
 * holding the selection in the tab, which is why the UI caps a bundle well
 * below what a browser can hold.
 */
async function readAll(files: File[], onProgress: (percent: number) => void): Promise<File[]> {
  const total = files.reduce((sum, file) => sum + file.size, 0) || 1;
  const loaded: File[] = [];
  let done = 0;

  for (const file of files) {
    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      throw new ApiError(
        0,
        `the browser could not read "${file.name}". It may have been moved or renamed since you picked it, ` +
          'or it is in iCloud and not downloaded to this Mac — open it once in Finder to fetch it, then try again.',
      );
    }

    if (bytes.byteLength !== file.size) {
      throw new ApiError(
        0,
        `"${file.name}" changed while it was being read (${bytes.byteLength} bytes, expected ${file.size})`,
      );
    }

    loaded.push(new File([bytes], file.name, { type: file.type }));
    done += file.size;
    // The read is real work for a large selection; report it as progress
    // rather than leaving the button dead.
    onProgress(Math.round((done / total) * 50));
  }

  return loaded;
}

export async function uploadFiles(
  original: File[],
  onProgress: (percent: number) => void,
): Promise<StoredFile> {
  // Paths live on the original handles; the in-memory copies keep only names.
  const paths = original.map((file) => file.webkitRelativePath || file.name);
  const files = await readAll(original, onProgress);

  return new Promise((resolve, reject) => {
    const body = new FormData();
    files.forEach((file, index) => {
      // The third argument is the entry's path inside the archive. A folder
      // picked with webkitdirectory reports its structure in
      // webkitRelativePath and nowhere else — without it the server would see
      // a flat pile of basenames.
      body.append('file', file, paths[index]);
    });

    const total = files.reduce((sum, file) => sum + file.size, 0);
    let sent = 0;

    const request = new XMLHttpRequest();
    request.open('POST', '/api/files');
    request.upload.addEventListener('progress', (event) => {
      // Kept so a failure can say how far it got. "Nothing left the browser"
      // and "it died at 90%" are different bugs in different places.
      sent = event.loaded;
      // The first half of the bar was the read; this is the second half.
      if (event.lengthComputable) onProgress(50 + Math.round((event.loaded / event.total) * 50));
    });

    // Every path out of here settles the promise. An earlier version parsed
    // JSON straight inside this handler, so a response that was not JSON threw
    // inside an event listener: the promise never settled, the caller's
    // `finally` never ran, and the file input stayed disabled with no error on
    // screen. It looked exactly like the app refusing to accept the file.
    request.addEventListener('load', () => {
      let body: { message?: string | string[] } | null = null;
      try {
        body = JSON.parse(request.responseText || '{}') as { message?: string | string[] };
      } catch {
        body = null;
      }

      if (request.status >= 200 && request.status < 300) {
        if (body && 'id' in body) resolve(body as unknown as StoredFile);
        else reject(new ApiError(request.status, 'the server accepted the file but answered with something else'));
        return;
      }

      const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
      reject(
        new ApiError(
          request.status,
          message ||
            (request.status === 413
              ? 'that file is larger than MAX_UPLOAD_BYTES'
              : `upload failed (${request.status})`),
        ),
      );
    });
    request.addEventListener('error', () =>
      reject(
        new ApiError(
          0,
          sent === 0
            ? `the request never left the browser — 0 of ${formatBytes(total)} was sent. Nothing reached the server, so this is the browser refusing to read or send the files.`
            : `the connection dropped after ${formatBytes(sent)} of ${formatBytes(total)}`,
        ),
      ),
    );
    request.addEventListener('abort', () => reject(new ApiError(0, 'upload cancelled')));
    request.addEventListener('timeout', () => reject(new ApiError(0, 'upload timed out')));
    request.send(body);
  });
}

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | null;

const KINDS: Record<string, PreviewKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio',
  pdf: 'pdf',
  txt: 'text', md: 'text', log: 'text', csv: 'text', json: 'text', xml: 'text', yml: 'text', yaml: 'text',
};

/**
 * What the file can be shown as, from its name. Null means there is nothing
 * useful to render — most of what this system stores is archives and binaries,
 * and a wall of mojibake is worse than an honest "download it".
 */
export function previewKind(name: string): PreviewKind {
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return KINDS[extension] ?? null;
}

/** The bytes themselves, rendered in the page rather than saved. */
export function inlineUrl(id: string): string {
  return `/api/files/${id}/download?inline=1`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}
