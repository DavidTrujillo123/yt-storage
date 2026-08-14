import { safeEntryName } from './tar';

/**
 * How many files one upload may bundle.
 *
 * Not a storage limit — a video holds ~15 GiB either way — but a bound on the
 * multipart request and on the number of temp files open at once.
 */
export const MAX_BUNDLE_ENTRIES = 500;

export interface UploadedPart {
  originalname: string;
  path: string;
  size: number;
}

/**
 * Turns the parts of a multipart upload into tar entries.
 *
 * The name of each part is whatever the browser put in the Content-Disposition,
 * which for a folder upload is the `webkitRelativePath` — client-controlled
 * text that ends up inside an archive somebody will extract later, so it goes
 * through `safeEntryName` first. Duplicates are suffixed rather than dropped:
 * two files quietly becoming one is the kind of data loss nobody notices until
 * it matters.
 */
export function toEntries(uploads: UploadedPart[]) {
  const seen = new Set<string>();

  return uploads.map((upload, index) => {
    let name = safeEntryName(upload.originalname, `file-${index + 1}`);
    if (seen.has(name)) {
      const dot = name.lastIndexOf('.');
      const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      let attempt = 2;
      while (seen.has(`${stem}-${attempt}${extension}`)) attempt++;
      name = `${stem}-${attempt}${extension}`;
    }
    seen.add(name);
    return { name, path: upload.path, size: upload.size };
  });
}

/**
 * What to call the archive.
 *
 * A folder upload has a common first segment — the folder the user picked — and
 * using it means the stored file is called `holiday.tar` rather than something
 * anonymous. A loose selection of files has no such name, so it gets the date.
 */
export function bundleName(entryNames: string[], requested?: string, now = new Date()): string {
  if (requested?.trim()) {
    // The last segment only, and only characters that are a filename anywhere:
    // this becomes the stored name and ends up in a Content-Disposition.
    const name = (requested.trim().split('/').pop() ?? '')
      .replace(/[^\w.\- ]+/g, '')
      .replace(/^\.+/, '')
      .trim();
    if (name) return name.toLowerCase().endsWith('.tar') ? name : `${name}.tar`;
  }

  const roots = new Set(entryNames.map((name) => (name.includes('/') ? name.split('/')[0] : '')));
  const [root] = [...roots];
  if (roots.size === 1 && root) return `${root}.tar`;

  return `bundle-${now.toISOString().slice(0, 10)}.tar`;
}
