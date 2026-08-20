# syntax=docker/dockerfile:1

# ---- build -------------------------------------------------------------------
# better-sqlite3 and @ronomon/reed-solomon are native addons with no prebuilt
# arm64 binaries we can rely on, so they are compiled here for the target
# architecture and the toolchain is left behind in this stage.
FROM node:25-trixie-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Node 25 images no longer ship corepack.
RUN npm install -g pnpm@10
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/codec/package.json packages/codec/
COPY api/package.json api/
COPY web/package.json web/

# --no-frozen-lockfile would hide a lockfile drift that only shows up in prod.
RUN pnpm install --frozen-lockfile

COPY packages/codec packages/codec
COPY api api
COPY web web

# The UI is a static export with no server of its own; the API process serves
# it, so it ships as a directory of files rather than a second image.
# --legacy because this workspace does not inject its local packages; pnpm 10
# refuses to deploy otherwise.
RUN pnpm -F @yt-storage/codec build \
 && pnpm -F @yt-storage/api build \
 && pnpm -F @yt-storage/web build \
 && pnpm deploy --legacy --filter=@yt-storage/api --prod /out/api \
 && cp -r api/dist /out/api/dist \
 && pnpm deploy --legacy --filter=@yt-storage/codec --prod /out/packages/codec \
 && cp -r packages/codec/src /out/packages/codec/src \
 && cp -r web/out /out/web

# better-sqlite3 ships a prebuilt addon for eight platforms and the amalgamated
# SQLite source beside them: 27MB, of which this image can load one 2MB file.
# The rest is deleted here, in the stage that is thrown away, so the runtime
# never carries a macOS binary it cannot execute.
#
# Two layouts live under prebuilds/: better-sqlite3 keeps one file per platform
# (`linux-arm64.node`), node-gyp-build keeps a directory per platform
# (`linux-arm64/argon2.node`). Pruning by top-level entry name handles both;
# deleting by file name deletes the contents of the directory that is kept, and
# the image then starts up to "No native build was found".
RUN find /out -type d -name prebuilds -exec sh -c \
      'find "$1" -mindepth 1 -maxdepth 1 ! -name "linux-*" -exec rm -rf {} +' _ {} \; \
 && rm -rf /out/api/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/deps \
           /out/api/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/src

# ---- runtime -----------------------------------------------------------------
# Just the deno binary, from the image that exists for exactly this.
FROM denoland/deno:bin AS deno

FROM node:25-trixie-slim AS runtime

# ffmpeg renders and reads the frames; yt-dlp is the only way to get bytes back
# out of YouTube, since the Data API cannot download video.
#
# yt-dlp-ejs is the challenge solver script. YouTube's `n` parameter has to be
# computed by running a piece of its own player JavaScript, and without both
# the solver and a runtime to execute it YouTube serves no video formats at
# all — "Only images are available". The download then fails as
# "Requested format is not available", which reads exactly like a video that
# has not finished transcoding. That cost days.
#
# No browser in this image, and nothing to run on your machine either. The
# cookie jar every deployment needs comes from the `cookie:` header the browser
# you are already using sends to YouTube: DevTools shows it, you paste it into
# the setup page, and the API turns it into a jar. A container cannot read that
# browser itself — it cannot exec on the host, and on macOS it is a Linux VM
# with no access to the Keychain key that decrypts the cookie database — so the
# copy has to come from the person, and this is the shortest way to ask.
#
# This image carried chromium, Xvfb, x11vnc and noVNC to do it in-page instead.
# That was roughly 600MB of it.
#
# aria2 is here for one number. A DASH rendition is a single file behind a
# single URL, and YouTube throttles a single connection: measured at 0.8 MB/s
# on a link doing 37 MB/s, which turned a ten-gigabyte restore into three and a
# half hours. Ranged requests took it to 2.5-6 MB/s; aria2 asks for sixteen of
# those ranges at once, which is the only thing left that the throttle cannot
# answer. About 1.5 MB of image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates tini aria2 \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp yt-dlp-ejs \
    && rm -rf /var/lib/apt/lists/*

# Node is in this image already and yt-dlp supports it, but deno is what yt-dlp
# enables by default and the reason is worth keeping: the script being run
# comes from YouTube, and deno executes it sandboxed with no permissions. This
# process holds a Google cookie jar — one that authenticates every Google
# service, not just YouTube — on disk while yt-dlp runs.
COPY --from=deno /deno /usr/local/bin/deno

# Before the COPYs, so ownership is set as each file lands. A `chown -R` after
# them rewrites every file it touches, and a rewritten file is a new file in a
# new layer: the old ordering shipped the application twice, 321MB of it, for
# nothing but a uid.
RUN useradd --system --uid 10001 --home /app yts \
 && mkdir -p /data && chown yts:yts /data

WORKDIR /app
COPY --from=build --chown=yts:yts /out/api ./api
COPY --from=build --chown=yts:yts /out/packages ./packages
COPY --from=build --chown=yts:yts /out/web ./web

# The codec runs as a child process straight from TypeScript source, using
# Node's native type stripping.
ENV CODEC_CLI=/app/packages/codec/src/cli.ts \
    DATA_DIR=/data \
    DATABASE_PATH=/data/yt-storage.db \
    WEB_DIR=/app/web \
    NODE_ENV=production \
    # deno wants a writable cache; the container user does not own /app.
    DENO_DIR=/tmp/deno

USER yts

VOLUME ["/data"]
EXPOSE 3000
WORKDIR /app/api

# tini reaps the ffmpeg and yt-dlp children the codec spawns; without it they
# accumulate as zombies inside the container.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
