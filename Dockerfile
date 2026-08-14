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
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates tini \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp yt-dlp-ejs \
    && rm -rf /var/lib/apt/lists/*

# Node is in this image already and yt-dlp supports it, but deno is what yt-dlp
# enables by default and the reason is worth keeping: the script being run
# comes from YouTube, and deno executes it sandboxed with no permissions. This
# process holds a Google cookie jar — one that authenticates every Google
# service, not just YouTube — on disk while yt-dlp runs.
COPY --from=deno /deno /usr/local/bin/deno

WORKDIR /app
COPY --from=build /out/api ./api
COPY --from=build /out/packages ./packages
COPY --from=build /out/web ./web

# The codec runs as a child process straight from TypeScript source, using
# Node's native type stripping.
ENV CODEC_CLI=/app/packages/codec/src/cli.ts \
    DATA_DIR=/data \
    DATABASE_PATH=/data/yt-storage.db \
    WEB_DIR=/app/web \
    NODE_ENV=production \
    # deno wants a writable cache; the container user does not own /app.
    DENO_DIR=/tmp/deno

RUN useradd --system --uid 10001 --home /app yts \
 && mkdir -p /data && chown -R yts:yts /data /app
USER yts

VOLUME ["/data"]
EXPOSE 3000
WORKDIR /app/api

# tini reaps the ffmpeg and yt-dlp children the codec spawns; without it they
# accumulate as zombies inside the container.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
