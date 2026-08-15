/**
 * Puts the container's browser on the page, without putting it on the network.
 *
 * x11vnc listens on the loopback interface inside the container and nothing
 * else can reach it — no published port, no password, because there is nothing
 * to protect it from. The only way in is this proxy, and the only way through
 * this proxy is a valid session cookie. A viewer that is not signed in gets a
 * 401 before a single byte of the VNC handshake.
 *
 * It lives outside Nest's router because a WebSocket upgrade never reaches a
 * controller: it is an event on the HTTP server, so guards and interceptors do
 * not run and the session has to be resolved by hand here.
 */
import { Logger } from '@nestjs/common';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { AuthService, SESSION_COOKIE } from '../auth/auth.service';
import { VNC_PORT } from './remote-browser';

/** Where the page connects; noVNC is handed this as its `path`. */
export const VNC_PATH = '/api/vnc';

export function attachVncProxy(server: Server, auth: AuthService): void {
  const log = new Logger('VncProxy');
  const sockets = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    // Anything else upgrading on this server is not ours to answer; leaving it
    // untouched is what lets another handler take it.
    const path = (request.url ?? '').split('?')[0];
    if (path !== VNC_PATH) return;

    void (async () => {
      const token = readCookie(request.headers.cookie, SESSION_COOKIE);
      const user = token ? await auth.resolve(token) : null;
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      sockets.handleUpgrade(request, socket, head, (client) => pipeToVnc(client, log));
    })();
  });

  log.log(`VNC proxy ready on ${VNC_PATH} for signed-in viewers`);
}

/**
 * Two byte streams glued together: the WebSocket the page opened and a TCP
 * connection to x11vnc. Nothing interprets the RFB protocol in between — noVNC
 * and x11vnc talk to each other, and this only carries the bytes.
 */
function pipeToVnc(client: WebSocket, log: Logger): void {
  const upstream = connect(VNC_PORT, '127.0.0.1');

  const close = () => {
    upstream.destroy();
    if (client.readyState === client.OPEN) client.close();
  };

  upstream.on('data', (chunk) => {
    if (client.readyState === client.OPEN) client.send(chunk);
  });
  upstream.on('error', (error) => {
    log.warn(`VNC upstream: ${error.message}`);
    close();
  });
  upstream.on('close', close);

  client.on('message', (data: Buffer) => upstream.write(data));
  client.on('close', close);
  client.on('error', close);
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of header?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
