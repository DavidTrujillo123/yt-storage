'use client';

/**
 * The server's own browser, embedded.
 *
 * Behind the iframe is noVNC talking to a Chromium running on a virtual display
 * inside the API process's container, over a WebSocket that only opens for a
 * signed-in session. It is a real browser window with your keyboard and mouse
 * going to it, which is what a Google sign-in needs — Google refuses one from a
 * browser being driven by automation.
 *
 * Sized to the display the server allocates (1280x800) and scaled down to fit,
 * so the aspect ratio is right and nothing is cropped.
 */
export function RemoteBrowser({ url }: { url: string }) {
  return (
    <div
      style={{
        margin: '0.75rem 0',
        border: '1px solid var(--line, #333)',
        borderRadius: '6px',
        overflow: 'hidden',
        // 1280x800 is 8:5. A fixed ratio keeps the panel from collapsing while
        // the display is still coming up and the iframe has nothing to show.
        aspectRatio: '8 / 5',
        background: '#000',
      }}
    >
      <iframe
        src={url}
        title="Sign in to Google"
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        // The remote screen is useless without them, and it is same-origin.
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
