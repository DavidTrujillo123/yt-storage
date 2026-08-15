# yt-storage — handoff

Written for whoever picks this up next, human or model, with no memory of how it
got here. It covers what the system is, what is finished, what is not, and the
non-obvious things that cost hours to learn. Read `README.md` first for how to
run it; this file is about *why* it is shaped the way it is.

---

## 1. What the system does

Stores arbitrary files on YouTube. A file is encoded into a black-and-white
block video, uploaded as a private video, and decoded back byte-for-byte when
retrieved. YouTube is the disk; the app is the filesystem in front of it.

It is self-hosted and multi-user, where each user brings their own Google Cloud
project and YouTube channel. Nothing is shared between users — not quota, not
credentials, not ban risk.

**It violates YouTube's Terms of Service.** That was a deliberate, informed
choice by the project owner. The realistic risk is not privacy but pattern
detection: long, high-bitrate, visually noisy uploads in volume. Do not
"improve" the system by uploading more aggressively.

---

## 2. Technology

| Layer | Choice | Why this one |
|---|---|---|
| Runtime | Node 25 | Native TypeScript stripping runs the codec CLI straight from `.ts` |
| API | NestJS 11 (CommonJS) | Owner's choice; DI + modules suit the job-heavy shape |
| ORM | TypeORM 1.x | Owner explicitly rejected Prisma mid-build. Do not reintroduce it |
| Database | SQLite via `better-sqlite3` | Single-user-scale, one file to back up. WAL mode |
| Queue | BullMQ 6 + Redis 7 | Durable jobs across restarts |
| Auth | Argon2id + opaque session cookie | No JWT: logout is a row delete |
| Codec | Standalone ESM TS package | Runs as a **child process**, never in-process |
| Video | ffmpeg (libx264), yt-dlp | The Data API cannot download video; yt-dlp is the only way back |
| JS runtime | deno + `yt-dlp-ejs` | yt-dlp must run YouTube's player JS to get any video format at all; deno sandboxes it |
| UI | Next.js, exported static | No frontend server: the API process serves it, so the httpOnly session cookie is same-origin by construction |
| Container | Multi-stage Docker, compose | api + worker share one image, different command |

Package manager is **pnpm** with a workspace. `npm` is blocked on the owner's
machine.

### Repository layout

```
packages/codec/     ESM TypeScript. Encoder, decoder, Reed-Solomon, ffmpeg pipes.
                    Has its own README with the physical-layer design.
api/                NestJS. Two entry points: src/main.ts (HTTP), src/worker.ts (jobs).
web/                Next.js UI, exported static. The API process serves it.
scripts/            browser cookie capture for a desktop: lib/capture.mjs is the
                    capture itself, get-cookies.mjs runs it once from a terminal.
Dockerfile          Multi-stage; compiles native addons, ships ffmpeg + yt-dlp.
docker-compose.yml  redis + api + worker.
```

---

## 3. How it works

### The pipeline

```
POST /files  →  PENDING
             →  ENCODING     codec CLI child process; file → .mp4
             →  UPLOADING    picks an account with quota; videos.insert, private
             →  PROCESSING   polling: has YouTube produced a ≥1080p rendition?
             →  VERIFYING    download it back, decode, compare sha256
             →  READY        only now are the local copies deleted
```

The ordering rule that matters: **local copies are never deleted until the file
has been read back off YouTube and its hash matched.** A mangled upload costs
time, never data. Do not "optimise" by deleting earlier.

### Why the codec survives YouTube's re-encode

Four layers, each covering the one below. Full detail and measurements in
`packages/codec/README.md`.

1. **Block alignment.** Bits are 4×4 blocks on a 1920×1080 canvas, upscaled
   nearest-neighbour to 3840×2160. Each bit becomes an 8×8 square aligned to the
   codec's transform grid, so VP9 encodes it as one DC coefficient — nearly free
   and nearly exact. Grayscale only; colour dies to 4:2:0 chroma subsampling.
2. **Adaptive threshold.** A checkerboard border gives the decoder real black and
   white levels per frame, and makes it resolution-independent.
3. **Soft-decision repair.** CRC32 per frame plus per-block confidence; on a CRC
   failure the least-confident bits are flipped and retested.
4. **Erasure coding.** 24 data + 6 parity frames per group. The CRC turns
   corruption into an *erasure*, which is what Reed-Solomon handles best.

**The one hard dependency: downloads must be ≥1080p.** Measured, not guessed —
900p round-trips cleanly, 810p fails outright. Every yt-dlp call pins the floor
with no lower fallback. Never add one.

### Accounts

Quota is charged **per Google Cloud project**, not per channel. A second channel
adds capacity only if it brings its own project. So an account row holds both
halves: client id/secret *and* refresh token *and* cookie jar. All secrets are
AES-256-GCM encrypted with `SECRET_KEY` and marked `select: false` in TypeORM so
a careless `find()` cannot leak them.

The daily allowance is 100 uploads per account, counted per Cloud project and
cleared at midnight US Pacific. Not 10,000 quota units at 1,600 per upload as
the API docs describe — see `DAILY_UPLOAD_LIMIT` in
`api/src/youtube/constants.ts` for the measurement that settled it.

### Onboarding, and the tradeoff it makes

A fresh `docker compose up` has to reach a usable app with nothing prepared, so
two things happen on first boot:

- **`SECRET_KEY` is generated if unset** and written to `$DATA_DIR/secret.key`.
  The api and worker are separate processes on one data directory and must agree
  on the key, so the write uses an exclusive create (`wx`) and the loser of that
  race reads back the winner's key. Nothing else in the app knows this happened —
  `resolveSecretKey` runs before Nest and puts the result on the environment.
- **An administrator is seeded** — `admin@yt-storage.com` / `Abcd1234` by
  default — keyed on the email, never on the table being empty. An existing
  password is never overwritten, so restarting is not destructive, and deleting
  the account brings it back.

The tradeoff is real and deliberate: a documented password on a box reachable
over Tailscale means anyone who finds it owns the cookie jars, which authenticate
every Google service. It is bounded rather than ignored — changing the password
is step 1 of `/setup`, the login page advertises the credential *only* while the
`auth.defaultAdmin` setting says it is still in use, the API warns on every boot
until then, and `SEED_ADMIN=false` opts out. `POST /auth/password` drops every
other session for that user, because a shipped credential is one somebody else
may already have used.

The password minimum is 8, enforced when a password is **set** and never when one
is **entered**: a login DTO that validates length locks out older accounts and
tells an attacker the policy. Short passwords get `wrong email or password` like
any other wrong one.

`/setup` itself stores nothing. Each step is derived from `/status` and
`/auth/bootstrap`, so it cannot disagree with the instance, and returning from
Google's consent screen lands where the instance actually is. That return path
rides in the OAuth `state` as `<accountId>|<target>` where target is one of two
allowlisted values — `state` is data that leaves the app and comes back under
someone else's control, so it selects a fixed path or it selects nothing.

### Cookies, and why they are the fragile part

API-uploaded videos from an unaudited project are **locked private forever**.
Private videos need an authenticated session to download, and OAuth tokens do
not work for playback URLs — only browser cookies do. Hence the jar.

Three rules learned the hard way, all of them enforced in code:

- **Filter the jar.** A browser export is ~1,300 cookies across ~400 domains,
  including banks and payment providers. `cookie-jar.ts` reduces it to
  google/youtube domains before storage. Never store a raw export.
- **Serialise access.** yt-dlp rotates session cookies on every run and writes
  them back. Two concurrent rotations of one jar invalidate the Google session
  outright. `CookieLock` (Redis) makes this exclusive across the api and worker
  processes.
- **A jar copied from a live profile is rotated by two clients at once** and can
  die within minutes — observed twice, at roughly twenty and five. That is the
  known cost of the in-app picker, chosen deliberately by the owner: it lists the
  browser profiles already signed in to YouTube and copies one, so nobody signs
  in again. `scripts/get-cookies.mjs` remains the durable path — a **throwaway
  profile** deleted after extraction, which nothing ever rotates again. A
  private/incognito window cannot be read at all: its cookies never touch disk.
- **A Google session is not a YouTube session.** A profile signed in to Search or
  Cloud Console carries `__Secure-3PSID` and friends while YouTube stays signed
  out, and that jar authenticates nothing here. `LOGIN_INFO` in the cookie
  database is the local tell; `identifySession()` confirms it by fetching
  `youtube.com/account` and looking for `"LOGGED_IN":true`.
- **Build the cookie header per host, never from the whole jar.** `SID` exists
  for `.google.com` and for `.youtube.com` with different values, and a header
  carrying both gets `accounts.google.com/CookieMismatch` — every auth check
  built on it then reads as "signed out". An hour went into that.
- **One jar cannot be pointed at a secondary Google account.** A profile may hold
  several (`?authuser=N` enumerates them, and the app lists them), but yt-dlp has
  no account switch and `X-Goog-AuthUser` was measured to change nothing. One
  browser profile per account is the answer.

---

## 4. What is done

Everything below was exercised end to end against a real YouTube account, not
just compiled.

- **Codec.** Byte-identical round-trip. Survives VP9 crf 63 at 1080p (3 frames
  repaired, 1 rebuilt from parity — inside budget). ~1.29 GiB of data per hour
  of video, ~4.4× bloat, ~0.64 MiB/s encode.
- **Pipeline.** Files reaching `READY`, local copies released, download endpoint
  reconstructing from YouTube with matching sha256. Verified at 256 KiB and
  6 MiB.
- **Auth.** Registration open only until the first user exists, sessions, guard,
  timing-equalised login. Cross-user isolation checked: user B gets 404 on user
  A's files and accounts.
- **Accounts.** CRUD, per-account OAuth with `state`, encrypted secrets,
  quota-aware selection at upload time.
- **Resilience.** `ReconcileService` re-queues interrupted files on boot —
  verified by SIGKILLing the worker mid-encode and watching the file complete.
- **Docker.** Three containers, multi-stage build, non-root user, tini for
  reaping ffmpeg/yt-dlp children. Encode and upload confirmed working inside the
  container.
- **Retrieval.** Files that had been stuck since the last handoff now verify and
  reach `READY`: downloaded from YouTube, decoded, sha256 matched, local copies
  released. See 5.1 for what was actually wrong.
- **Bundles.** Several files, or a whole folder, arrive in one request and are
  written into one tar — so one video and one upload, which is what the quota
  actually limits. Verified with four files across two directory levels: the
  archive was named after the folder, the structure survived, one entry came
  back byte-identical through the range route, and the system `tar` reads the
  archives this code writes.
- **Restore cache.** Bytes pulled back from YouTube are kept, named by sha256,
  and re-served until evicted under a budget. Measured: 5.18 s cold, 0.01 s
  warm. Verification seeds it for free, since it has just decoded the file.

---

## 5. What is NOT done

### 5.1 The verify bug — solved

**Cause: no JavaScript runtime in the container.**

Fetching a video from YouTube means computing its `n` parameter, and computing
that means executing a piece of YouTube's own player JavaScript. yt-dlp needs
two things to do it: a JS runtime, and the EJS solver script. The image had
neither. Without them YouTube answers with **no video formats at all** — the
stderr says `Only images are available for download` — and yt-dlp reports
`Requested format is not available`, which is exactly what a video that has not
finished transcoding looks like from the outside. Hence months of looking at
YouTube's transcoder, at rate limits, and at the format selector.

The fix is two lines in the Dockerfile: `pip3 install yt-dlp yt-dlp-ejs`, and
the deno binary copied from `denoland/deno:bin`. Node was already in the image
and yt-dlp supports it (`--js-runtimes node`), but deno is what yt-dlp enables
by default and the reason holds: the script comes from YouTube, deno runs it
sandboxed, and this process keeps a Google cookie jar on disk while yt-dlp runs.

Result: both stuck files verified within seconds of the worker starting, with
**0 frames repaired and 0 rebuilt from parity**. YouTube had been serving a
perfect 1080p rendition the whole time; the app could not ask for it.

Two things made this take as long as it did, and both are now fixed:

- **`--no-warnings` on the download.** The `n challenge solving failed` message
  is a *warning*, not an error. It was being suppressed, and the one line left
  said "Requested format is not available".
- **The stderr was flattened to its first line** at every call site, so even
  when the warnings were present they never reached a log.

**The "but it works by hand" evidence was also wrong.** This section used to
claim `GET /files/:id/download` returned both files correctly while the worker
failed on them, and concluded the difference had to be environmental. That route
short-circuits on `file.sourcePath` and streams the **local copy**, which exists
until verification passes — so for any file in `VERIFYING` it always answered
off the disk, with the right hash, without ever invoking yt-dlp. Use
`?source=youtube` to force the real round trip; `GET /files/:id/formats` reports
what YouTube is actually serving. Both go through `withCookies`, so no jar ever
leaves the app.

Five other real bugs were found and fixed along the way. None of them was the
cause:

1. **Split format selectors.** The readiness probe and the fetch used different
   selectors, so the probe could pass while the fetch failed. Unified into one
   `format` field.
2. **No audio track.** The encoder produced silent video, and yt-dlp runs its
   default `bestvideo+bestaudio` selector even for `-J`, aborting before it could
   report anything — from a code path with no logging, which is why this stayed
   invisible for so long. The encoder now muxes a silent 8 kbit/s AAC track.
   *This did not fix the bug: `audio.bin` was encoded with audio and fails the
   same way.*
3. **`--ignore-no-formats-error` is a trap.** yt-dlp then returns JSON with no
   `formats` array at all, so every height check reports "nothing available".
   Removed.
4. **Unbounded exponential backoff.** After a handful of normal retries the next
   attempt landed 30+ minutes out and files looked dead. Replaced by a fixed
   180 s across 40 attempts, and then — because two hours is not long enough for
   a 4K upload to get its high renditions — by `verifyBackoff`: 3 minutes for
   the first hour, 15 minutes out to 24 hours.
5. **Reconcile could not re-arm a delayed job.** `queue.remove()` is a no-op for
   delayed jobs and the subsequent `add()` is deduplicated by job id, so stale
   jobs kept their old backoff. It now inspects state and `promote()`s.

The readiness probe was ultimately **deleted** rather than fixed — attempting the
download is the check, so the two cannot disagree. That was the right call.

The instrumentation that finally caught it is worth keeping:

- `run()` logs the full argv on every call and the full stderr on failure, and
  errors carry `stderr`/`argv` (`YtdlpError`) instead of being flattened.
- `download()` passes no `--no-warnings`. The warnings are the signal.
- On a "still transcoding" failure the verify processor asks `describeFormats`
  and writes the answer onto the file row, so a stuck file says
  `available heights: 720, 480` rather than repeating a guess. First attempt,
  every tenth, and the last one — it is a second yt-dlp call and doubling the
  request rate would be its own problem.

Do **not** debug by dumping a cookie jar and running yt-dlp by hand. That is
what killed two jars already. `GET /files/:id/formats` and
`GET /files/:id/download?source=youtube` both go through `withCookies` and take
the lock.

### 5.2 Frontend — built, unexercised against a real upload

`web/` is a Next.js App Router UI. Five screens: sign in (offers registration
only while the instance has none), setup (the four-step wizard, all of its state
derived from the API), files (3 s polling, live status, upload with progress,
download, delete), accounts (add, OAuth, cookie jar, quota), and a redirect from
`/`.

**There is no frontend server.** Every page is a client component, so the UI is
a static export (`output: 'export'`) that the NestJS process serves with
`useStaticAssets`. One process, one port: UI at `/`, API under `/api`.

Decisions worth keeping:

- **One origin, not two.** The session cookie is `httpOnly`, so nothing in the
  page can carry it by hand; a separate frontend server would need CORS or a
  proxy to work at all. Serving both from one process makes same-origin true by
  construction.
- **`/accounts/callback` is excluded from the global prefix.** It is the OAuth
  redirect URI registered in each user's Google Cloud project; moving it under
  `/api` would break every account already connected. The static `/accounts`
  page and that route coexist because the paths differ.
- **`redirect()` does not survive a static export.** `/` bounces to `/files`
  from a `useEffect`; the build-time version produced an error page.
- **Uploads go through `XMLHttpRequest`**, because `fetch` cannot report upload
  progress and the files here are large enough that a silent form is unusable.

Verified: UI at `/`, `/files`, `/login`, `/accounts` all served; API answering
under `/api`; `/accounts/callback` still reaching the controller. Earlier, on
the two-server layout that this replaced: registration, session, `/files`,
`/status` and a real multipart upload, with a file walking PENDING → ENCODING →
UPLOADING. Not yet verified through the UI: a full upload to READY, which needs
a working account — see 5.1.

### 5.3 Smaller gaps

- **Tests cover the pure layer only.** `pnpm test` runs `node:test` — no
  framework — over the codec (crc, container, erasure coding, frame sampling and
  soft repair, plus a real round trip through `simulateYouTube` at 1080p and the
  expected failure at 810p) and over the API's pure modules (`SecretBox`,
  `filterCookieJar`, quota selection). Nothing exercises Nest, the queues or
  yt-dlp; the pipeline is still verified by running it.
- **`synchronize: true`** in TypeORM. Fine for one owner, wrong the moment this
  holds someone else's data. Switch to migrations before that.
- **No pagination** on `GET /files`.
- **yt-dlp ages badly.** YouTube breaks it every few weeks. The container pins
  whatever pip installed at build time; there is no update path yet. Needs either
  periodic rebuilds or a self-update step.
- **The capture is a paste, and that is the end of a long argument.** A jar has
  to come from a real browser signed in to YouTube. A container can neither exec
  on the host nor read a browser profile it cannot see, so the choices were: ship
  a browser in the image (chromium + Xvfb + x11vnc + noVNC, ~600MB, tried and
  removed), run something on the operator's machine (a helper process or an
  extension, ruled out), or ask the operator for the `cookie:` header DevTools
  already shows. The paste needs nothing on either side, so it won.
  `jarFromHeader` in `cookie-jar.ts` turns it into a Netscape jar and the
  existing `filterCookieJar` does the rest. `scripts/get-cookies.mjs` stays for
  anyone who wants a throwaway-profile jar instead; `YTS_API` there is the
  **origin**, not the API root — it adds the `/api` prefix itself. It did not,
  for a while, and every call 404'd.
- **`document.cookie` cannot see the cookies that matter.** They are `HttpOnly`,
  so no page, bookmarklet or console can read them — only DevTools, an
  extension, or a process with the profile on disk. Any future "just read them
  from the page" idea dies here.
- **Docker on a Mac** cannot use VideoToolbox, but the encoder is libx264
  (software) anyway. Only matters if hardware encoding is ever added.

---

## 6. Traps

Things that will waste your time if you do not know them.

- **yt-dlp without a JS runtime fails as "Requested format is not available".**
  Not as "no runtime". The real reason is a *warning* two lines up, and the
  message it produces is identical to a video that is still transcoding. If
  downloads ever stop working, check `deno --version` and `yt-dlp-ejs` in the
  container before suspecting YouTube.
- **Suppressing warnings hides the cause, not the noise.** `--no-warnings` cost
  months here.

- **Kill processes by the right pattern.** They run as `node dist/worker.js`, not
  a full path. `pkill -f "yt-storage/api/dist"` matches nothing, silently, and
  you end up with a pile of stale workers — one of which will grab a job and fail
  it against a schema it does not recognise. Cost: about an hour.
- **BullMQ stores attempts in `atm`**, not `attemptsMade`. Reading the wrong
  field makes a retrying job look like it never ran.
- **Do not dump a cookie jar to debug.** Running yt-dlp with a copy while the
  worker holds the real one rotates the session twice and kills it. Use the
  API's own endpoints, which take the lock.
- **Port 6379 is taken** on the owner's machine by another project. This stack
  uses **6380**.
- **`~/.npmrc` sets `ignore-scripts=true`**, so native addons do not build on
  install. `pnpm rebuild -r` after every install, or nothing loads.
- **pnpm 10 needs `--legacy` for `deploy`**, and Node 25 images have no corepack.
- **Redis persists across `docker compose down`.** Stale jobs survive; clear the
  `bull:*` keys when testing queue behaviour.
- **Old uploads are not a test of new encoder code.** Always upload fresh.

---

## 7. Owner's preferences

Observed over the build; worth respecting.

- Writes in Spanish, wants answers in Spanish. Code, comments, and docs in
  English.
- Wanted TypeORM, not Prisma, and said so after Prisma was already wired up.
- Prefers no extra tooling when something already installed can do the job —
  rejected a browser extension for cookies and asked for automatic extraction
  instead, which is why `scripts/get-cookies.mjs` exists.
- Wants things demonstrated working, not asserted working.
