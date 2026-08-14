/**
 * A browser's cookie jar is not a YouTube credential — it is every credential.
 *
 * Exporting from a real profile yields thousands of cookies across hundreds of
 * domains: banks, payment providers, work SSO. None of that belongs in this
 * app's database, encrypted or not, so every jar is reduced to the domains
 * yt-dlp actually needs before it is stored.
 */
const ALLOWED_DOMAINS = new Set([
  '.youtube.com',
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  '.google.com',
  'google.com',
  'www.google.com',
  'accounts.google.com',
  '.googlevideo.com',
  '.ytimg.com',
]);

/** Cookies that must survive the filter for the jar to authenticate at all. */
const REQUIRED = ['__Secure-3PSID', '__Secure-1PSID', 'SAPISID', 'SID'];

const HTTP_ONLY = '#HttpOnly_';

function domainOf(line: string): string {
  const body = line.startsWith(HTTP_ONLY) ? line.slice(HTTP_ONLY.length) : line;
  return body.split('\t')[0] ?? '';
}

function nameOf(line: string): string {
  const body = line.startsWith(HTTP_ONLY) ? line.slice(HTTP_ONLY.length) : line;
  return body.split('\t')[5] ?? '';
}

export interface FilterResult {
  jar: Buffer;
  kept: number;
  dropped: number;
  domains: string[];
}

export function filterCookieJar(raw: Buffer): FilterResult {
  const lines = raw.toString('utf8').split(/\r?\n/);

  const entries = lines.filter(
    (line) => line.trim() !== '' && (!line.startsWith('#') || line.startsWith(HTTP_ONLY)),
  );
  const kept = entries.filter((line) => ALLOWED_DOMAINS.has(domainOf(line)));

  if (kept.length === 0) {
    throw new Error('no youtube.com or google.com cookies in that file');
  }

  const names = new Set(kept.map(nameOf));
  if (!REQUIRED.some((name) => names.has(name))) {
    throw new Error(
      'that jar has no Google session cookie - export it while signed in to YouTube, and do not log out afterwards',
    );
  }

  return {
    jar: Buffer.from(`# Netscape HTTP Cookie File\n${kept.join('\n')}\n`, 'utf8'),
    kept: kept.length,
    dropped: entries.length - kept.length,
    domains: [...new Set(kept.map(domainOf))].sort(),
  };
}

/** A jar without one of these cannot authenticate; refuse to store it. */
export function hasSessionCookie(raw: Buffer): boolean {
  const names = new Set(
    raw
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && (!line.startsWith('#') || line.startsWith(HTTP_ONLY)))
      .map(nameOf),
  );
  return REQUIRED.some((name) => names.has(name));
}
