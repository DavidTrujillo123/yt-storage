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

**1. Block alignment.** Bits are drawn as 4x4 blocks on a 1920x1080 canvas, then
upscaled nearest-neighbour to 3840x2160 before encoding. Each bit becomes an
8x8 pixel square aligned to the codec's transform grid, so VP9 codes it as a
single DC coefficient — nearly free, and nearly exact. The 4K upload also buys a
4K bitrate budget for what is really 1080p of information.

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
inside the parity budget. **Rescaling is the real threat.** The floor is ~900p
served; below that each 4-px block covers under 3.3 pixels and the frame is
unreadable. This is the design's one hard dependency: the retrieved file must be
at 1080p or better. `yt-dlp -f "bestvideo[height>=1080]"` enforces it.

Bitrate flags are a trap here: `-b:v` alone leaves libvpx-vp9 in VBR and it
quietly ignores the target, so bitrate-based tests report passes when no
degradation ever happened. `simulateYouTube` uses `-crf` with `-b:v 0`.

## Capacity and cost

| | |
|---|---|
| Payload per frame | 15,992 bytes |
| Payload per group | 0.37 MiB across 30 frames |
| Throughput | 1.29 GiB per hour of video, at 30 fps |
| Video bloat | ~4.4x the payload |
| Encode speed | ~0.64 MiB/s of payload (M-series, 10 cores) |

YouTube's 12-hour cap puts roughly 15 GiB of data in a single video. The
Data API allows 100 uploads/day per Cloud project, so ~1.5 TiB/day through the
API — or unlimited by uploading through YouTube Studio manually and pasting the
video id.

## Layout

| File | Role |
|---|---|
| `geometry.ts` | Canvas, block, and group constants — the single source of truth |
| `frame.ts` | Bits to pixels, pixels to bits, CRC, soft-decision repair |
| `ecc.ts` | Reed-Solomon group encode and erasure recovery |
| `container.ts` | File header, optional gzip, sha256 verification |
| `ffmpeg.ts` | Raw frame pipes in and out, YouTube simulation |
| `encode.ts` / `decode.ts` | The two pipelines |
| `cli.ts` | `encode`, `decode`, `roundtrip`, `specs` |

## Known limits

- Whole streams are held in memory. Fine to ~100 MiB; larger files need the
  group loop to spill to disk.
- Losing an entire group is unrecoverable — parity is within a group, not across.
- One file per video. The app archives multi-file uploads into a tar before
  handing them here, so the codec never has to know about it.
