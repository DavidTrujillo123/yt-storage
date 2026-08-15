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

With Docker — three containers, nothing to install but Docker itself, and
nothing to prepare:

```bash
docker compose up -d --build
```

Everything is on <http://localhost:3000>: the UI at `/`, the API under `/api`.
Sign in with the account it creates for itself:

```
admin@yt-storage.com
Abcd1234
```

**Change it immediately.** The password above is printed in this file, so an
instance still using it can be signed into by anyone who can reach the machine —
over Tailscale, over the LAN — and this app stores cookie jars that authenticate
every Google service on the accounts you connect, not just YouTube. Changing it
is the first step of `/setup`, where the login lands you while the default is
still in place.

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before the first boot to seed your own
instead, or `SEED_ADMIN=false` for none at all. The account is created only when
that email has none; an existing password is never overwritten by a restart.

`SECRET_KEY` is likewise optional now: with none set, one is generated on first
boot and written to `$DATA_DIR/secret.key` inside the data volume. It encrypts
every credential the app holds, so back it up with the database — and set it
explicitly if you would rather it not live there.

Or natively, which is faster to iterate on:

```bash
pnpm install && pnpm rebuild -r     # -r builds the native addons
pnpm run redis:up                   # Redis on 6380
cp api/.env.example api/.env        # optional: nothing in it is required
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
tokens, cookie jars. One is generated on first boot if you set none; to bring
your own:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The API and the worker are separate processes on one data directory and must
agree on the key, so whichever starts first writes `secret.key` and the other
reads it. Deleting that file makes every stored credential undecryptable.

Registration is open while the instance has no users, then closes. Set
`ALLOW_REGISTRATION=true` to let more people in. Passwords are at least 8
characters; the rule is enforced when one is set, never when one is entered, so
a short password gets "wrong email or password" like any other wrong one.

## Putting it on another machine

A version tag is the deploy. `.github/workflows/release.yml` builds the image on
push of a `v*` tag and publishes it to GHCR:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The image tags drop the `v`, so `v0.1.0` publishes `:0.1.0`, `:0.1` and
`:latest`. Pull `:0.1.0`.

Bump `version` in the root, `api`, `web` and `packages/codec` package files in
the commit you tag, and keep all four the same. The UI prints `web`'s next to
Sign out, so a mismatch there is what someone reads off the screen when they
report which version they are on. It comes from the file rather than from `git
describe` because the release image is built from a copied tree with no
repository in it.

amd64 and arm64 are built on runners of their own architecture rather than one
under emulation — the image compiles `better-sqlite3` and the Reed-Solomon addon
from C++, and QEMU turns that from minutes into most of an hour. Both land under
one name, so a pull gets the right one either way.

**The published package starts private**, and a public repository does not
change that — GHCR defaults every package pushed with `GITHUB_TOKEN` to private,
so an anonymous pull answers 404 rather than "unauthorized". Either flip it once
at *Packages → yt-storage → Package settings → Change visibility → Public*, or
leave it private and authenticate on each machine with a token that has
`read:packages`:

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u DavidTrujillo123 --password-stdin
```

On the target machine nothing needs cloning. Take `docker-compose.release.yml`,
which pulls instead of building:

```bash
curl -O https://raw.githubusercontent.com/DavidTrujillo123/yt-storage/main/docker-compose.release.yml
YTS_IMAGE=ghcr.io/davidtrujillo123/yt-storage:latest \
  docker compose -f docker-compose.release.yml up -d
```

Then <http://localhost:3000>, sign in as `admin@yt-storage.com` / `Abcd1234`,
and change it — see above for why that matters.

### The address, and the three places it has to match

This is the one setting a deployment gets wrong, and it fails late: everything
works until the OAuth consent screen, which then refuses with
`redirect_uri_mismatch`. It reads like a broken Cloud project and is not.

Three values have to name the **same address you type in the browser**:

| Where | What |
|---|---|
| `PORT` in the environment | the host port published by compose |
| `GOOGLE_REDIRECT_URI` in the environment | `<that address>/accounts/callback` |
| *Authorized redirect URIs* in each Google Cloud project | the identical string |

`PORT` is only the **host** side of the mapping — the container always listens
on 3000, and `PORT=8080` publishes `8080:3000`. So the port in
`GOOGLE_REDIRECT_URI` is the one you browse to, never the internal 3000.
(Running natively, without Docker, `PORT` *is* the listening port.)

Worked examples — one `.env` next to the compose file:

```bash
# Local trial. Nothing to set: these are the defaults.
PORT=3000
GOOGLE_REDIRECT_URI=http://localhost:3000/accounts/callback

# Reached over the LAN.
PORT=3000
GOOGLE_REDIRECT_URI=http://192.168.1.50:3000/accounts/callback

# Reached over Tailscale, published on another port.
PORT=8080
GOOGLE_REDIRECT_URI=http://nas.tail1234.ts.net:8080/accounts/callback

# Behind a reverse proxy terminating TLS on 443.
PORT=3000
GOOGLE_REDIRECT_URI=https://yts.example.com/accounts/callback
```

`/setup` compares `GOOGLE_REDIRECT_URI` against the address the browser is
actually on and says so, in red, before you get as far as Google — so if the
wizard is quiet, these agree.

Two more things worth setting deliberately:

- **`SECRET_KEY`**, if you would rather it not live in the data volume. Moving
  an instance means carrying that key and the `data` volume together; either
  alone is useless.
- **TLS.** The session cookie is issued without the `secure` flag, because this
  is expected to run over plain HTTP on a home network and a secure-only cookie
  would simply never be sent — login would appear to fail silently. If you put
  it behind TLS, turn `secure` on in `api/src/auth/auth.controller.ts`.

Upgrading is the same command with a newer tag:

```bash
YTS_IMAGE=ghcr.io/davidtrujillo123/yt-storage:0.2.0 \
  docker compose -f docker-compose.release.yml up -d --pull always
```

The database migrates itself (`DB_SYNC`) and the data volume is untouched, so
accounts and files survive. Back up the `data` volume before a version you have
not run before — there are no down migrations.

Both compose files name their containers, so a released stack and a
built-from-source one cannot run side by side on the same host. On a machine
that only deploys, that is what you want; to run both, override
`container_name` and `PORT`.

## How accounts work

Each user brings their **own** Google Cloud project and YouTube channel. No
shared quota, no shared ban risk, no shared anything.

Both halves are needed because **quota is charged per Cloud project, not per
channel** — a second channel only adds capacity if it brings its own project.
That is why client credentials live on the account row rather than in the
environment.

`/setup` in the UI walks all of this, reading each step's state back from the
API so you can leave and return. What it does, spelled out:

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

   Or paste it. Step 4 of `/setup` and **Capture cookies** on `/accounts` ask for
   one thing: the `cookie:` header your browser already sends to YouTube.

   1. Open `youtube.com` in the browser signed in as **the same account you
      authorised in step 3** — jar and OAuth token have to be one account, or the
      app uploads as one channel and cannot read back what it stored
   2. F12 → **Network** → reload
   3. Filter by **Doc** and click a row: `you`, `persist_identity` or the page
      itself
   4. Under **Request Headers**, copy the whole value of `cookie:`, paste it in
      and save

   The page carries a screenshot of that panel, because the words alone sent the
   first attempt to a `gstatic.com` row — another domain, so the browser sends it
   no YouTube cookies and there is no `cookie:` line on it at all, which reads as
   broken instructions rather than as the wrong row. A **Copy → Copy as cURL** of
   the right row is accepted too, and its URL is what lets the server answer
   *"that request went to www.gstatic.com, which receives no YouTube cookies"*.

   Saving reports which account the jar turned out to hold, so a jar for the
   wrong Google account is caught there rather than on the first download.

   Nothing is installed on either side — no browser in the image, no process on
   your machine, no Python. The console is no use for this (`document.cookie`
   cannot see `HttpOnly` cookies, and those are the ones that authenticate) but
   DevTools shows them, and a header from `youtube.com` alone is enough: measured
   against `youtube.com/account`, which answered `"LOGGED_IN":true` for exactly
   that subset. The server checks that before storing, so a header copied from a
   signed-out tab fails there rather than on the day a file has to come back, and
   it names the account the jar turned out to be.

   A jar built this way copies the session your browser keeps using, so Google
   can rotate it away — an account you do not browse with is what avoids that.

   **When the API runs natively** it can also read the browser profiles on its
   own machine: the same panel lists the ones already signed in to YouTube and
   copies whichever you pick, with no paste at all. `/status` says
   `cookieCapture.available` for that, and `false` with a `reason` under Docker,
   where the paste is the way.

   One thing neither path can do is pick a **secondary Google account**. A
   profile signed in to several is listed with all of them, but yt-dlp has no
   account switch and `X-Goog-AuthUser` was measured here to change nothing, so a
   jar authenticates as that profile's effective account and no other. Give an
   account its own browser profile to use it.

   The same capture also runs from your own machine, which is what to use when
   the API is somewhere without either:

   ```bash
   pnpm run cookies
   YTS_API=http://your-host:3000 YTS_ACCOUNT=<account id> pnpm run cookies
   ```

   That opens your browser against a **brand new throwaway profile**, waits for
   you to sign in, extracts the jar and deletes the profile. Disposability is
   the point — nothing ever opens that profile again, so no second client rotates
   the session behind the app's back. It runs on the machine with the browser and
   talks to the API over HTTP, so it works against a container too.

   `YTS_API` is the origin you would open in a browser, not the API root — the
   `/api` prefix is added for you. `YTS_ACCOUNT` skips the account prompt;
   `/setup` prints the whole line with both already filled in. `YTS_EMAIL` and
   `YTS_PASSWORD` skip the sign-in prompts.

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

An upload counts as one whatever it weighs, so **a hundred uploads a day** is the
entire budget while one video holds ~15 GiB. Sending a folder of a thousand
photos one file per upload is not slow, it is impossible.

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
| `POST /auth/password` | change it; every other session is dropped |
| `GET /auth/bootstrap` | unauthenticated: is registration open, is the shipped password still in use |
| `GET/POST /accounts`, `DELETE /accounts/:id` | YouTube accounts |
| `GET /accounts/:id/connect?return=setup` | start OAuth for that account |
| `POST /accounts/:id/cookies` | store its cookie jar |
| `POST /accounts/:id/cookies/header` | turn a pasted `cookie:` header into the jar, after checking it against YouTube |
| `GET /accounts/:id/cookies/capture/profiles` | browser profiles on the API's machine that are signed in to Google (native only) |
| `POST/GET/DELETE /accounts/:id/cookies/capture` | take the jar from `{ profile }`, or drive a throwaway browser here without one: start, poll, cancel |
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
| Per account per day | 100 uploads ≈ 1.5 TiB |

Note that this is **not** the limit the YouTube Data API documents. The published
model is a 10,000-unit daily budget with `videos.insert` at 1,600 units, which
would cap an account at six uploads. Measured against a live project, nine
uploads in one day all succeeded while the Cloud Console's `Queries per day`
counter stayed at 0 and `Video Uploads per day` counted every one — so the
count is what binds, and it is the count this app tracks.

The day here is Google's, not yours: the allowance clears at midnight US
Pacific, so an account emptied in the evening is full again long before your own
morning if you are east of it. The counter is local — it counts what this server
uploaded and never asks Google — so it is right only for uploads this server
made.

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
