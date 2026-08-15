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

/**
 * Turns a browser's `cookie:` request header into a jar.
 *
 * This is what makes the last setup step need nothing installed anywhere. The
 * session cookies are `HttpOnly`, so no page and no bookmarklet can read them —
 * but DevTools shows them: Network, any request to youtube.com, Request
 * Headers, the `cookie:` line. That single line carries the whole set for that
 * host, and pasting it here is the entire capture.
 *
 * One host at a time, always. `SID` exists for `.google.com` and `.youtube.com`
 * with different values, and a jar mixing both is a set Google rejects outright
 * with `accounts.google.com/CookieMismatch`. A youtube.com header alone is
 * enough: measured against `youtube.com/account`, which answered
 * `"LOGGED_IN":true` for exactly that subset.
 *
 * A header carries no expiry, so one is invented a year out. It is not a lie
 * anyone acts on — yt-dlp only needs the line not to look expired, and the
 * session's real lifetime is decided by Google, not by this file.
 */
/**
 * What someone actually pastes, reduced to a cookie header.
 *
 * The header is easy to describe and hard to find: it only exists on requests
 * to youtube.com itself, so anyone who clicks the wrong row in DevTools — a
 * `gstatic.com` script, a `googlevideo.com` chunk — sees no `cookie:` line at
 * all and concludes the instructions are wrong. **Copy as cURL** on that same
 * row is one gesture, carries the cookies, and is what this mostly receives.
 *
 * The URL comes back too, when there is one, so the caller can say *which*
 * request was copied rather than "that does not look like a cookie header".
 *
 * Four shapes, in this order: a cURL command, a `cookie:` line, a bare header,
 * and anything else — which is left to `jarFromHeader` to reject.
 */
export function cookieHeaderFromPaste(text: string): { header: string; url: string | null } {
  const trimmed = text.trim();

  if (/^curl\s/i.test(trimmed)) {
    return { header: cookiesFromCurl(trimmed), url: urlFromCurl(trimmed) };
  }

  // The Headers panel copies the name with it.
  const line = trimmed.replace(/^cookie:\s*/i, '');
  return { header: line, url: null };
}

/**
 * Quoted strings as every browser's "Copy as cURL" writes them.
 *
 * Chromium uses `$'…'` when a value contains something a plain single-quoted
 * string cannot hold, and escapes an embedded quote as `'\''`. Windows copies
 * with double quotes instead. Getting this wrong truncates a cookie value in
 * the middle, which produces a jar that looks complete and authenticates
 * nothing — the worst possible failure here.
 */
function unquote(raw: string): string {
  const body = raw.startsWith("$'") ? raw.slice(2, -1) : raw.slice(1, -1);
  return body.replace(/'\\''/g, "'").replace(/\\(['"\\])/g, '$1');
}

function cookiesFromCurl(command: string): string {
  // -b and --cookie are where Chromium puts them; Firefox and Safari send a
  // plain -H 'Cookie: …' instead.
  const flag = command.match(/(?:^|\s)(?:-b|--cookie)\s+(\$?'(?:[^']|'\\'')*'|"(?:[^"\\]|\\.)*")/);
  if (flag) return unquote(flag[1]);

  const header = command.match(
    /(?:^|\s)-H\s+(\$?'\s*cookie:(?:[^']|'\\'')*'|"\s*cookie:(?:[^"\\]|\\.)*")/i,
  );
  return header ? unquote(header[1]).replace(/^\s*cookie:\s*/i, '') : '';
}

function urlFromCurl(command: string): string | null {
  const quoted = command.match(/(?:^|\s)(?:--url\s+)?(\$?'https?:\/\/[^']*'|"https?:\/\/[^"]*")/);
  if (quoted) return unquote(quoted[1]);

  const bare = command.match(/(?:^|\s)(https?:\/\/\S+)/);
  return bare ? bare[1] : null;
}

export function jarFromHeader(header: string, domain = '.youtube.com'): Buffer {
  const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  const lines = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('='))
    .map((part) => {
      const at = part.indexOf('=');
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    })
    .filter(([name]) => name !== '')
    // Session cookies are HttpOnly in the browser and yt-dlp expects to see
    // that; the prefix is how the Netscape format carries the flag.
    .map(([name, value]) => `${HTTP_ONLY}${domain}\tTRUE\t/\tTRUE\t${expires}\t${name}\t${value}`);

  if (lines.length === 0) {
    throw new Error('that does not look like a cookie header - expected name=value; name=value');
  }

  return Buffer.from(`# Netscape HTTP Cookie File\n${lines.join('\n')}\n`, 'utf8');
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
