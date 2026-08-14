# yt-storage

A self-hosted cloud that keeps its bytes on YouTube. Files are encoded as
black-and-white block video, uploaded as private videos, and decoded back
byte-for-byte on the way out.

```
packages/codec   the part that can actually fail - encoder, decoder, ECC
api              NestJS: HTTP API + BullMQ workers, and it serves the UI
web              the UI: a Next.js static export, no server of its own
```

## Getting it running

With Docker — three containers, nothing to install but Docker itself:

```bash
cp api/.env.example .env            # set SECRET_KEY
docker compose up -d --build
```

Everything is on <http://localhost:3000>: the UI at `/`, the API under `/api`.

Or natively, which is faster to iterate on:

```bash
pnpm install && pnpm rebuild -r     # -r builds the native addons
pnpm run redis:up                   # Redis on 6380
cp api/.env.example api/.env        # then set SECRET_KEY
pnpm run build
pnpm run api                        # terminal 1
pnpm run worker                     # terminal 2
```

`pnpm run build` builds the UI too, and the API process serves it: one port,
one origin, the UI at `/` and the API under `/api`. That is not a packaging
preference — the session cookie is `httpOnly`, so nothing in the page can carry
it by hand, and a second origin would mean CORS or a proxy to make it work at
all. `pnpm run web` rebuilds only the UI after a change to it.

`/accounts/callback` is deliberately outside the `/api` prefix: it is the OAuth
redirect URI registered in every user's Google Cloud project, and moving it
would break every account already connected.

Natively you also need Node 25+, `ffmpeg`, `ffprobe`, `yt-dlp` and `deno`
(`brew install yt-dlp deno`). The image ships all of them. deno is not
optional — see the note on YouTube's `n` parameter below.

```bash
pnpm test                           # node:test, no framework
```

The codec suite includes a real round trip through a VP9 re-encode: a file in,
byte-identical file out at 1080p, and a loud failure at 810p. It needs ffmpeg
and takes about six seconds; without ffmpeg it skips rather than fails. The API
suite runs against `dist`, so `pnpm -F @yt-storage/api test` builds first.

Kill stray processes with `pkill -f "node dist/"` — they run as `node
dist/worker.js`, so a pattern containing the full path matches nothing and you
end up with several workers competing for the same jobs.

`SECRET_KEY` encrypts every YouTube credential at rest — client secrets, refresh
tokens, cookie jars:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Registration is open while the instance has no users, then closes. Set
`ALLOW_REGISTRATION=true` to let more people in.

## How accounts work

Each user brings their **own** Google Cloud project and YouTube channel. No
shared quota, no shared ban risk, no shared anything.

Both halves are needed because **quota is charged per Cloud project, not per
channel** — a second channel only adds capacity if it brings its own project.
That is why client credentials live on the account row rather than in the
environment.

Per account, once:

1. Google Cloud: new project → enable *YouTube Data API v3* → *Google Auth
   Platform* → Web application client with redirect URI
   `http://localhost:3000/accounts/callback`. Scopes `youtube.upload` and
   `youtube.readonly`.

   Set publishing status to **In production**, not Testing. In Testing, Google
   expires refresh tokens after 7 days and the account silently dies every week.
   Unverified production is fine — click through the warning screen.

2. `POST /accounts` with the label, client id and client secret.
3. `GET /accounts/:id/connect` — the OAuth round trip.
4. Cookies. API-uploaded videos are locked to private, and a private video can
   only be fetched by an authenticated session:
   - open a **private window**, log into YouTube with that channel's account
   - export cookies with a Netscape-format extension
   - `POST /accounts/:id/cookies` with the file
   - close the private window **without logging out** — logging out kills the
     session server-side and the exported jar dies with it

   Or skip the extension entirely:

   ```bash
   pnpm run cookies
   ```

   That opens your browser against a **brand new throwaway profile**, waits for
   you to sign in, extracts the jar and deletes the profile. Disposability is
   the point — nothing ever opens that profile again, so no second client rotates
   the session behind the app's back. It runs on the machine with the browser and
   talks to the API over HTTP, so it works against a container too.

   A private window cannot be read at all: its cookies live only in memory and
   never touch disk. And `POST /accounts/:id/cookies/from-browser` reads your
   *live* profile, which is quicker and dies within minutes — measured twice
   here, at roughly twenty and five.

After that the jar maintains itself: yt-dlp rotates cookies as it runs, the app
re-seals the rotated jar after every download, and a twice-daily check per
account flags it `STALE` before you find out the hard way. Access is serialised
through a Redis lock, because two concurrent rotations of one jar — the worker
verifying while the API serves a restore — invalidate the session outright.

> A cookie jar authenticates **every Google service**, not just YouTube. Anyone
> holding one can read Gmail and change the account password without needing the
> password or a second factor. Use dedicated throwaway accounts that are not the
> recovery address for anything.

## Pipeline

```
POST /files      →  ENCODING    codec CLI, out-of-process
                 →  UPLOADING   picks an account with quota, uploads private
                 →  PROCESSING  waiting for YouTube to make a 1080p rendition
                 →  VERIFYING   download it back, decode, compare sha256
                 →  READY       only now are the local copies deleted
```

Nothing is trusted until it has been read back. A file that YouTube mangles
fails at VERIFYING while the original is still on disk, so a bad upload costs
nothing but time.

Restoring a file is the expensive direction — a whole video downloaded and
decoded — so restored bytes are kept in `data/cache`, named by sha256, and
re-served until evicted under `CACHE_MAX_BYTES`. Verification seeds it for free,
since it has just decoded the file to check the hash. The cache is disposable
and is never the copy of record: deleting the directory costs one slow read.
Responses carry the hash as an `ETag`, so a browser that already has the bytes
gets a 304 and no download happens at all.

The account is chosen at upload time, not at ingest — an account can run out of
quota, lose its cookies, or be deleted while a file sits in the queue.

## Many files at once

An upload costs 1,600 quota units whatever it weighs, so **six uploads a day** is
the entire budget while one video holds ~15 GiB. Sending a folder of photos one
file per upload is not slow, it is impossible.

So several files in one request are written into a single tar — `writeTar` in
`api/src/files/tar.ts`, no dependency — and stored as one video. Folder
structure survives, because the browser reports it in `webkitRelativePath` and
multer runs with `preservePath` so busboy does not strip it. Entry names are
sanitised on the way in: they are client-controlled text that ends up in an
archive somebody will extract.

Reading one back does not mean downloading all of it. `GET /files/:id/entries`
walks the 512-byte tar headers and seeks past the data, so listing a 10 GiB
archive reads kilobytes, and `GET /files/:id/entries/:n/download` serves that
entry as a byte range. The restore cache means the archive is pulled off YouTube
once, no matter how many entries you then open.

Every route below is under `/api`, except `GET /accounts/callback` — Google's
redirect URI, which keeps its address.

| Route | |
|---|---|
| `POST /auth/register` `/login` `/logout`, `GET /auth/me` | session in an httpOnly cookie |
| `GET/POST /accounts`, `DELETE /accounts/:id` | YouTube accounts |
| `GET /accounts/:id/connect` | start OAuth for that account |
| `POST /accounts/:id/cookies` | store its cookie jar |
| `POST /accounts/:id/cookies/from-browser` | read a local browser profile (see the warning above) |
| `POST /files` | multipart upload; several parts become one archive |
| `GET /files` | your catalogue with status and progress |
| `GET /files/:id/entries` | what is inside a bundle |
| `GET /files/:id/entries/:n/download` | one file out of a bundle |
| `GET /files/:id/download` | local copy if present, otherwise fetch and decode |
| `GET /files/:id/download?source=youtube` | always fetch and decode, even with a local copy |
| `GET /files/:id/formats` | what YouTube is currently serving for that video |
| `GET /status` | every account's health plus today's upload budget |

## What it costs

| | |
|---|---|
| Throughput | 1.29 GiB of data per hour of video |
| Video bloat | ~4.4x the payload |
| Encode speed | ~0.64 MiB/s |
| Per video | ~15 GiB (YouTube's 12-hour cap) |
| Per account per day | 6 uploads (10,000 quota units, 1,600 each) ≈ 90 GiB |

## Things worth knowing before trusting it

- **Downloads must be 1080p or better.** The decoder needs ~3.3 pixels per 4-px
  block; 900p round-trips cleanly and 810p fails outright. Every yt-dlp call
  pins a minimum height with no fallback, because a silent drop to 720p would
  produce an unrecoverable file. YouTube Studio's own download button often
  serves 720p — do not use it to recover data.
- **Run it on a residential connection.** YouTube treats datacenter IP ranges
  very differently; from a VPS you will hit "Sign in to confirm you're not a
  bot" constantly, which means failed *retrievals*. A machine at home reachable
  over Tailscale gets you remote access without the bot checks.
- **Back up `api/data/yt-storage.db`.** It maps files to video ids. Losing it is
  survivable — the filename and hash are written into each video's description
  and into the container header inside the video itself — but rebuilding is slow.
- **Multiple Cloud projects to multiply quota is what Google calls quota
  circumvention.** Two or three personal accounts is noise; twenty is a pattern.
- **This is against YouTube's Terms of Service.** The realistic risk is not
  privacy but pattern: long, high-bitrate, visually noisy uploads in volume is
  what storage-abuse detection looks for. Keep a real backup of anything you
  cannot lose.
- Two processes on purpose. Encoding pins a CPU core for minutes; running the
  processors in the HTTP process would hang every request. SQLite runs in WAL
  mode so they do not deadlock on the same file.
- **yt-dlp needs a JavaScript runtime, or YouTube serves nothing.** Fetching a
  video means computing YouTube's `n` parameter, which means running a piece of
  its own player JavaScript. Without a runtime *and* the solver script, YouTube
  offers no video formats at all and yt-dlp reports "Requested format is not
  available" — indistinguishable, from the outside, from a video that has not
  finished transcoding. The image ships `deno` and `yt-dlp-ejs`; running
  natively you need both too (`brew install deno`). deno rather than the node
  already installed because that JavaScript comes from YouTube and deno runs it
  sandboxed.
- **A plain `GET /files/:id/download` is not a test of retrieval.** While a file
  still has a local copy — which is the entire time before it reaches `READY` —
  that route answers off the disk and never invokes yt-dlp. Add
  `?source=youtube` to force the real round trip.

See `packages/codec/README.md` for how the codec survives the re-encode and the
measurements behind the 900p floor.
