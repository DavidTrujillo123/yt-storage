'use client';

import { useState } from 'react';
import { api } from '@/lib/api';

/**
 * The capture, as one paste.
 *
 * Every other way of getting a jar asks for something first: a browser inside
 * the image (600MB), a process on your machine, an extension, yt-dlp and a
 * Python to run it. This asks for nothing, because the browser already holds
 * the cookies and DevTools already shows them: the `cookie:` request header on
 * any youtube.com request is the whole session, `HttpOnly` cookies and all,
 * which is exactly what no page and no bookmarklet can read.
 *
 * The instructions name the header because that is what people find once they
 * know where to look, and the screenshot is there because the words alone were
 * not enough — the first attempt landed on a `gstatic.com` row, which carries
 * no cookies at all and therefore shows no `cookie:` line, and that reads as
 * broken instructions rather than as the wrong row. A **Copy as cURL** of the
 * right row is accepted too, and its URL is what lets the server name the host
 * when someone copies the wrong one.
 *
 * The server checks the paste against YouTube before storing it, so a header
 * copied from a signed-out tab fails here rather than on the day a file has to
 * come back.
 */
export function CookiePaste({
  accountId,
  accountLabel,
  onDone,
}: {
  accountId: string;
  accountLabel: string;
  onDone: () => Promise<void> | void;
}) {
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const stored = await api<{
        kept: number;
        dropped: number;
        account: string | null;
      }>(`/accounts/${accountId}/cookies/header`, {
        method: 'POST',
        body: JSON.stringify({ header: paste }),
      });

      setResult(
        `Stored ${stored.kept} cookies${stored.account ? `, signed in as ${stored.account}` : ''}` +
          (stored.dropped ? `; discarded ${stored.dropped} from unrelated domains` : ''),
      );
      // The paste is a live session in plain text. It has served its purpose.
      setPaste('');
      await onDone();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="small muted">
        Nothing to install. It has to be the browser signed in as{' '}
        <strong>the same Google account you authorised in step 3</strong> — the jar and the OAuth
        token have to belong to one account, or the app will upload as one channel and be unable to
        read back what it stored.
      </p>
      <ol className="small muted" style={{ margin: '0 0 0.6rem 1.1rem', lineHeight: 1.7 }}>
        <li>
          Open a <strong>private window</strong> and sign in to <span className="mono">youtube.com</span>{' '}
          there as that account. An ordinary window works too, but see the note below — this is what
          makes the jar last
        </li>
        <li>
          Press F12 for developer tools, open <strong>Network</strong>, and reload the page
        </li>
        <li>
          Filter by <strong>Doc</strong> and click one of the rows — <span className="mono">you</span>,{' '}
          <span className="mono">persist_identity</span> or the page itself all carry it
        </li>
        <li>
          In <strong>Headers</strong>, scroll to <strong>Request Headers</strong> and copy the whole
          value of <span className="mono">cookie:</span> — it is long, several lines on screen, one
          line of text
        </li>
        <li>Paste it below and save</li>
        <li>
          Close that private window <strong>without signing out</strong> — signing out ends the
          session on Google&apos;s side and takes this jar with it
        </li>
      </ol>
      <p className="small muted">
        Saving tells you which account the jar turned out to hold. If that is not the account behind{' '}
        <strong>{accountLabel}</strong>, switch account in the browser and copy again — a jar for the
        wrong one stores cleanly and then fails to download anything.
      </p>

      <figure style={{ margin: '0 0 0.8rem' }}>
        <img
          src="/cookie-header.png"
          alt="DevTools Network panel: the Doc filter selected, the you and persist_identity rows, and the Headers tab"
          style={{ width: '100%', maxWidth: '46rem', borderRadius: '6px', display: 'block' }}
        />
        <figcaption className="small muted" style={{ marginTop: '0.3rem' }}>
          The <span className="mono">cookie:</span> value belongs in the grey area on the right; it is
          painted out here because a real one is a live session.
        </figcaption>
      </figure>

      <textarea
        value={paste}
        onChange={(event) => setPaste(event.target.value)}
        placeholder="SID=…; HSID=…; SAPISID=…; __Secure-1PSID=…; LOGIN_INFO=…"
        rows={4}
        spellCheck={false}
        style={{ width: '100%', fontFamily: 'var(--mono, monospace)', fontSize: '0.8rem' }}
      />

      <div className="row" style={{ marginTop: '0.4rem' }}>
        <button className="primary" onClick={() => void save()} disabled={busy || !paste.trim()}>
          {busy ? 'Checking with YouTube…' : 'Save these cookies'}
        </button>
        {result && <span className="small" style={{ color: 'var(--ok)' }}>{result}</span>}
      </div>

      {error && <p className="small" style={{ color: 'var(--bad)' }}>{error}</p>}

      <p className="small muted">
        If a row has no <span className="mono">cookie:</span> at all, it went to another domain —{' '}
        <span className="mono">gstatic.com</span>, <span className="mono">ggpht.com</span>,{' '}
        <span className="mono">googlevideo.com</span> — and your browser sends those no YouTube
        cookies. Stay on rows whose name is <span className="mono">youtube.com</span>. A{' '}
        <strong>Copy → Copy as cURL</strong> of that same row is accepted here too, if that is
        easier. The console is not: <span className="mono">document.cookie</span> cannot see{' '}
        <span className="mono">HttpOnly</span> cookies, and those are the ones that authenticate.
      </p>
      <p className="small muted">
        The row has to be from <span className="mono">youtube.com</span> in its own tab. A video
        embedded in another site sends only its cross-site cookies — a header of{' '}
        <span className="mono">__Secure-3P…</span> and <span className="mono">ST-…</span> and no{' '}
        <span className="mono">SID</span> — which YouTube reads as signed out, and every private
        video then reports itself as private rather than as a session problem.
      </p>
      <p className="small" style={{ color: 'var(--warn)' }}>
        Why the private window: a header copied from the window you keep browsing in is a snapshot of
        a session that browser goes on using, and Google rotates session cookies as they are used —
        measured here at roughly twenty and five minutes before the copy stopped working. A private
        window you sign into once and then close is a session nothing ever touches again, so the jar
        keeps working. Either way, paste it here promptly: an old copy is usually a dead one.
      </p>
    </>
  );
}
