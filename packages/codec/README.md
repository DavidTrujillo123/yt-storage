# ISG codec lab

Encodes arbitrary files as black-and-white block video that survives YouTube's
re-encode, and decodes them back byte-for-byte. This is the standalone codec —
the NestJS app wraps it, but everything that can actually fail lives here.

```bash
pnpm install
node src/cli.ts specs
node src/cli.ts roundtrip fixtures/random-1mb.bin 36 1080
```

Requires Node 25+ (native TypeScript), `ffmpeg`, and `ffprobe`.
`@ronomon/reed-solomon` is a native addon; pnpm must be allowed to run its build
script (`pnpm rebuild @ronomon/reed-solomon` if `binding.node` is missing).

## How it survives

Four layers, each covering the one below.

**1. Block alignment.** Bits are drawn as square blocks on a 1920x1080 canvas,
then upscaled nearest-neighbour to 3840x2160 before encoding. The default
`dense` grid uses 2x2 blocks, which land as 4x4 pixel squares; the older `wide`
grid uses 4x4, which land as 8x8. Either way a bit is a whole number of
transform blocks, so VP9 codes it as a single DC coefficient — nearly free, and
nearly exact. The 4K upload also buys a 4K bitrate budget for what is really
1080p of information.

Grayscale only. Colour would be destroyed by 4:2:0 chroma subsampling.

**2. Adaptive threshold.** A one-block checkerboard border frames every canvas.
The decoder measures the black and white levels off that border per frame, so
the decision threshold follows whatever compression did to the signal instead of
sitting at a hardcoded 128. It also makes the decoder resolution-independent —
it samples block centres from whatever dimensions the file actually has.

**3. Soft-decision repair.** Every frame carries a CRC32. The sampler records how
far each block sat from the threshold, so on a CRC failure the least confident
bits are the likely errors. Flipping one or two of them and retesting the CRC
recovers most marginal frames, keeping them out of the erasure budget.

**4. Erasure coding.** Frames are grouped 24 data + 6 parity (Reed-Solomon,
`@ronomon/reed-solomon`). Because the CRC *detects* damage rather than letting it
through silently, corruption becomes an erasure — the case RS handles best. Any
6 frames of any 30 can be lost outright.

## Measured limits

Round-trip of 1 MiB of incompressible random data through a local VP9 re-encode.
PASS means the recovered file was byte-identical.

| Simulated YouTube | Repaired | Lost | Result |
|---|---|---|---|
| crf 32–63, served 2160p | 0 | 0 | PASS |
| crf 36, served 1440p | 0 | 0 | PASS |
| crf 50, served 1080p | 0 | 0 | PASS |
| crf 63, served 1080p | 3 | 1 | PASS |
| crf 36, served 900p | 0 | 0 | PASS |
| crf 36, served 810p | — | — | **FAIL** |

Compression quality is essentially a non-issue — even crf 63 at 1080p stays
inside the parity budget. **Rescaling is the real threat.** For the `wide` grid
the floor is ~900p served; below that each 4-px block covers under 3.3 pixels
and the frame is unreadable. For `dense` it is 1080p exactly: measured
byte-identical at 1080p under crf 36 and failing at 972p. Either way the
retrieved file must be at 1080p or better, which is the design's one hard
dependency, and the format selector enforces it with no fallback below it.

Restores ask for the 1080p rendition rather than the best one, because that is
what both grids are measured against and it is a quarter of the bytes of the
2160p rendition the 4K master produces — on a measured restore the download was
three quarters of the wall clock. If it does not decode, the restore falls back
to the best rendition at or above the floor and remembers which answered.

Decoding downscales whatever it is served to what the grid needs — 1080p for
`dense`, 2160p for `wide` — with `scale=…:flags=area` on the way into the frame
pipe, rather than sampling 4K frames for a signal that does not need them.

Bitrate flags are a trap here: `-b:v` alone leaves libvpx-vp9 in VBR and it
quietly ignores the target, so bitrate-based tests report passes when no
degradation ever happened. `simulateYouTube` uses `-crf` with `-b:v 0`.

## Capacity and cost

`dense` is the default; `wide` is what every video written before layouts
existed used, and `CODEC_LAYOUT=wide` still writes it.

| | dense | wide |
|---|---|---|
| Block | 2x2 px, grid 960x540 | 4x4 px, grid 480x270 |
| Payload per frame | 64,408 bytes | 15,992 bytes |
| Payload per group | 1.47 MiB across 30 frames | 0.37 MiB across 30 frames |
| Throughput | 5.18 GiB per hour of video, at 30 fps | 1.29 GiB per hour |
| Master crf | 26 | 10 |

Measured on an M-series with 12 cores, `dense`, incompressible random data:

| | |
|---|---|
| Encode | 1 GiB in 234 s — **~4.6 MiB/s of payload** |
| Video bloat | **~4.9x** the payload |
| Decode | 1 GiB in 105 s — **~10 MiB/s of payload** |
| Peak memory, encoding | ~200 MiB of node plus ~860 MiB of ffmpeg |
| Peak memory, decoding | ~520 MiB of node plus ffmpeg |

Both directions are ffmpeg-bound, and both are flat in the size of the file.

**Encoding** is ffmpeg almost entirely: on a 40 MiB fixture the whole
`encodeFile` measured 25.3 s and ffmpeg alone on the same frames measured
24.9 s. Everything the JavaScript does — the container, the parity, the CRCs,
painting the pixels — is 3.7 s of that, and it runs through the pipe while
ffmpeg works. `renderFrame` allocating a 2 MiB image per frame looks like the
waste and is not: a version reusing one buffer measured slower.

So the encoder's settings are the lever, and `ultrafast` is three times faster
than the `veryfast` it replaced. The preset turns CABAC off, which costs 2.7x
in master size; putting only that back with `-x264-params cabac=1` gives the
size straight back for 1.8 s. Seventeen percent more upload for three times
less encoding is a good trade here, because uploading a master measured ten
times faster than producing it.

**Decoding** is the same shape: turning a 2160p master back into raw frames is
5.0 s of a 6.5 s decode, so the four sampling threads wait on the pipe rather
than the other way round. That is why `workerCount()` caps at four, and why
hardware decoding is not used — `-hwaccel videotoolbox` measured *slower* in
wall clock (9.8 s) despite spending a seventh of the CPU, because every frame
has to come back off the GPU. Decoding what YouTube serves is slower still:
VP9 and AV1 cost more than the x264 master.

**Memory** used to be the thing that capped uploads, and none of it was where
it looked. The encoder held the file three times over — the file, the container
stream in front of it, and a padded copy — which is now a group at a time off
disk. ffmpeg's `-shortest`, trimming an endless silent audio track against the
video, peaked at 4.4 GiB where cutting that track to the video's length with
`-t` peaks at 889 MiB for byte-identical output. And the decoder kept every
recovered shard, concatenated them into the whole stream and gunzipped that
into another copy: measured at 4.2 GiB for a 1 GiB file, against 523 MiB now
that groups are written out as the read passes them — and 105 s rather than
141 s, because most of that memory was garbage to collect.

Groups go out under a `.part` name and the file is renamed only once the hash
matches, so a streaming decode still never hands back bytes it has not
verified.

YouTube's 12-hour cap puts roughly 60 GiB of data in a single `dense` video, and
the Data API allows 100 uploads/day per Cloud project — or unlimited by
uploading through YouTube Studio manually and pasting the video id.

## Layout

| File | Role |
|---|---|
| `geometry.ts` | Canvas, group and frame-rate constants shared by every grid |
| `layout.ts` | The grids themselves: block size, capacity, and the height each needs served |
| `frame.ts` | Bits to pixels, pixels to bits, CRC, soft-decision repair |
| `ecc.ts` | Reed-Solomon group encode and erasure recovery |
| `container.ts` | File header, optional gzip, sha256 verification |
| `ffmpeg.ts` | Raw frame pipes in and out, YouTube simulation |
| `encode.ts` / `decode.ts` | The two pipelines, whole-file and by group range |
| `cli.ts` | `encode`, `decode`, `decode-range`, `header`, `roundtrip`, `specs` |

## Known limits

- Nothing holds a whole file any more. `encode` reads its input a group at a
  time, `decode` writes groups out as the read passes them, and `decode-range`
  holds only the groups asked for. What is left is a working set: about half a
  gigabyte for a decode whatever the file weighs.
- Losing an entire group is unrecoverable — parity is within a group, not across.
- One file per video. The app archives multi-file uploads into a tar before
  handing them here, so the codec never has to know about it.
