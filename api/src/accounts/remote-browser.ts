/**
 * A browser inside the container, shown in the page that asked for it.
 *
 * The capture flow needs someone to sign in to Google by hand, and a browser to
 * hold the profile that sign-in writes. When the API runs natively those are
 * the same browser you are reading this in. Under Docker — which is how this is
 * meant to be deployed — the API has no screen, and the browser on your desk is
 * unreachable from inside the container in both directions: it cannot be
 * launched from here, and its cookie database cannot be decrypted here either,
 * because on macOS the key lives in the Keychain.
 *
 * So the container brings its own. Chromium runs against a virtual X display,
 * x11vnc exposes that display on the loopback interface only, and the API
 * proxies it to the page over an authenticated WebSocket. What you get is the
 * real browser window, rendered in a panel, with your keyboard and mouse going
 * to it — a sign-in like any other, and no command to run anywhere.
 *
 * Deliberately not a headless browser driven by automation: Google refuses to
 * accept a sign-in from one ("this browser or app may not be secure"). Nothing
 * here drives the browser at all. It is an ordinary Chromium receiving ordinary
 * X input events, which is what makes the sign-in work.
 */
import { Logger } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Socket } from 'node:net';

/** One capture at a time, so one display and one port are enough. */
const DISPLAY = ':99';
const SCREEN = '1280x800x24';
export const VNC_PORT = 5900;

/** Where Debian puts them; overridable for anyone assembling this differently. */
const CHROMIUM = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium';
const XVFB = '/usr/bin/Xvfb';
const X11VNC = '/usr/bin/x11vnc';
export const NOVNC_DIR = process.env.NOVNC_DIR ?? '/usr/share/novnc';

/** Whether this image was built with the remote-browser stack in it. */
export function remoteAvailable(): boolean {
  return [CHROMIUM, XVFB, X11VNC, NOVNC_DIR].every((path) => existsSync(path));
}

export interface RemoteBrowser {
  /** The Chromium process, so the caller can close it to flush cookies. */
  browser: ChildProcess;
  /** Kills everything this started, in the order that avoids orphans. */
  stop: () => void;
}

/**
 * Brings up the display, the browser and the VNC server, in that order, and
 * hands back the browser so the capture can close it cleanly later.
 */
export async function startRemoteBrowser(
  profileDir: string,
  url: string,
  log: Logger,
): Promise<RemoteBrowser> {
  const started: ChildProcess[] = [];

  const spawnQuiet = (command: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess => {
    const child = spawn(command, args, { stdio: 'ignore', env: { ...process.env, ...env } });
    child.on('error', (error) => log.warn(`${command}: ${error.message}`));
    started.push(child);
    return child;
  };

  const stop = () => {
    // Reverse order: the VNC server first so nothing is watching a display
    // being torn down, the X server last so its clients are already gone.
    for (const child of started.reverse()) child.kill('SIGKILL');
  };

  try {
    spawnQuiet(XVFB, [DISPLAY, '-screen', '0', SCREEN, '-nolisten', 'tcp']);
    await waitFor(() => existsSync(`/tmp/.X11-unix/X${DISPLAY.slice(1)}`), 10_000, 'the X display');

    const browser = spawnQuiet(
      CHROMIUM,
      [
        `--user-data-dir=${profileDir}`,
        // Chromium's own sandbox needs privileges a container does not grant by
        // default. The browser is still confined by the container itself, and
        // it is thrown away with the profile.
        '--no-sandbox',
        // Containers get a 64MB /dev/shm and Chromium will exhaust it.
        '--disable-dev-shm-usage',
        // No keyring in here. Without this Chromium picks an encryption backend
        // at random depending on what it detects, and yt-dlp then cannot read
        // the cookies back.
        '--password-store=basic',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=TranslateUI',
        '--window-position=0,0',
        `--window-size=${SCREEN.split('x').slice(0, 2).join(',')}`,
        url,
      ],
      { DISPLAY },
    );

    spawnQuiet(X11VNC, [
      '-display', DISPLAY,
      '-rfbport', String(VNC_PORT),
      // Loopback only. The API proxies this behind a session check; nothing
      // reaches it from outside the container, and there is no password on it
      // precisely because nothing can.
      '-localhost',
      '-nopw',
      // Survives the viewer closing the tab, which is not the end of a capture.
      '-forever',
      '-shared',
      '-quiet',
      '-noxdamage',
    ]);

    await waitFor(() => portOpen(VNC_PORT), 10_000, 'the VNC server');
    log.log('remote browser up: chromium on a virtual display, viewable over VNC');

    return { browser, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

async function waitFor(ready: () => boolean | Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${what} did not come up`);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}
