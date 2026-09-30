# Creative Engine — renderer runtime readiness (Sept 30 2026)

This note covers runtime safety only. It is a gate before the renderer is
deployed to Supabase Edge. Nothing is deployed, 0057 is not applied and no
template is registered. Design and rules: `docs/creative-engine.md`.

## 1. What we measured

**Setup:**

- Deno 2.1.4, with the renderer wired as `index.ts` wires it (the pinned
  resvg-wasm and opentype.js, the embedded fonts).
- One fresh process per template.
- Each process: engine start, then three renders of the Lucas preview
  request.
- Sources are synthetic JPEGs with the texture of a real photo, at Lucas's
  real asset sizes: 950×1200 to 1536×2048, 315–865 KB. The PNG
  wordmark is 1200×886.
- This container is not Edge hardware. Section 6 covers measuring the
  deployed function.

**After engine start (no render yet):**

- RSS: 89 MB
- JS heap: 12 MB
- external: 18 MB
- CPU for the start: 70–130 ms

| Template | First render (cold) | Warm | Process peak RSS |
|---|---|---|---|
| service-light · facebook | **1.38–1.44 s** | 1.17 s | **216 MB** |
| service-light · instagram | 1.33 s | 1.15 s | 208 MB |
| service-light · gbp | 0.80 s | 0.60 s | 209 MB |
| real-work · facebook / instagram | 1.23–1.25 s | 1.04–1.07 s | 192–208 MB |
| service-spotlight · facebook / instagram | 1.16–1.30 s | 0.98–1.00 s | 185–192 MB |
| trust-know-how · facebook / instagram | 1.15–1.19 s | 0.96–0.97 s | 183–186 MB |
| real-work · gbp | 0.87 s | 0.68 s | 179 MB |
| service-spotlight · gbp | 0.64–0.73 s | 0.46 s | 175 MB |
| seasonal (all three) | 0.73–0.75 s | 0.55–0.61 s | 165–176 MB |
| trust-know-how · gbp | 0.53 s | 0.38 s | 170 MB |

**How to read the table:**

- Times are wall time for one render. The render is synchronous
  single-threaded WASM, so wall time is close to main-thread CPU.
- Whole-process CPU for a first render is 1.2–1.97 s. That figure also
  counts V8's background compile and GC threads.
- The first render in a process is 20–30% slower than a warm one, because
  the WASM still runs on V8's baseline tier.
- Peak RSS is for the whole Deno process across three renders. A fresh
  worker starts near 89 MB, so a render adds about 75–127 MB.
- RSS rises from render to render in the same process (for example
  181 → 201 → 205 MB), because WASM memory never shrinks.

These figures are higher than the earlier ones in `docs/creative-engine.md`
(0.45–1.1 s, 186 MB), which used flat synthetic PNG sources. Those figures
have been corrected.

## 2. Supabase Edge limits

| Limit | Value |
|---|---|
| Memory | 256 MB per worker |
| CPU time | **2 s per request** (async I/O excluded) |
| Wall clock | 150 s (Free) / 400 s (paid) |
| Request idle timeout | 150 s |

A request over a limit is terminated with a worker-limit error: Supabase
answers **546**. We do not know exactly which memory Supabase counts
against the 256 MB (the V8 heap, external buffers, and whether WASM linear
memory is included). So treat our two figures as bounds:

- the render's own increase (≤ ~127 MB) as the **lower bound**
- the whole-process RSS (≤ 216 MB, including the ~89 MB Deno runtime) as
  the **upper bound**

## 3. Where the memory and time go

For the heaviest render (service-light · facebook, cold):

| Stage | Time |
|---|---|
| Plan | 10 ms |
| Compose (base64 and SVG, 2.0 MB of SVG) | 100 ms |
| SVG parse | 69 ms |
| **Draw** | **1,155 ms** |
| PNG encode | 95 ms |

Single-photo measurements:

| Work | Time |
|---|---|
| Decode a 1536×2048 JPEG | ~90 ms |
| Decode a 950×1200 JPEG | ~35–40 ms |
| High-quality resample of one photo over a full 1080×1350 area | **500–570 ms** |
| Draw 1536×2048 at 1:1 | ~280 ms |

- **Where the time goes:** mostly into resampling. The cost follows the
  output area covered by photos, not the source's file size.
- **Draw memory (WASM, never returned while the worker lives):**
  - the canvas: 1080×1350 RGBA is 5.8 MB; 1200×900 is 4.3 MB
  - a canvas-sized layer for each clipped photo group while it is drawn:
    5.8 MB each
  - each decoded source: 1536×2048 is 12.6 MB; 950×1200 is 4.6 MB
  - the parsed tree, which holds the encoded image bytes
  - the SVG text copied in (up to 2 MB)
  - the PNG and zlib buffers
- **JS memory:**
  - the source bytes (≤ 0.9 MB each)
  - their base64 copy (1.33×)
  - the SVG string (1.2–2.0 MB) and its UTF-8 copy
  - glyph path strings
  - Over a render, the heap goes from 12 to 14–35 MB and external from 18
    to 41–67 MB.
- **Fixed cost:** about 89 MB of RSS is the Deno runtime, V8, the resvg
  module and the parsed fonts.

## 4. Can decoding, drawing or encoding be reduced?

| Option | Effect (measured) | Output bytes | Verdict |
|---|---|---|---|
| Pass photos to resvg as raw bytes (`imagesToResolve` / `resolveImage`) instead of base64 data URIs | Removes the base64 and SVG copies: a few MB of JS, ~2 MB of SVG to parse. No CPU gain in the draw | Should be the same; must be verified | Small memory win |
| Skip the clip-path wrapper on radius-0 photos | Draw 10–20% faster; one fewer canvas-sized layer | Change → renderer v2 | Worth doing if the Edge figures are tight |
| Pre-sized source derivatives: each approved photo scaled once, off the request path, to the slot's crop size and stored by content hash, so the render draws 1:1 | Photo draw ~4× cheaper; smaller decode | Change → renderer v2, plus a new governed derivative (source hash → derivative hash) | The largest win; an architecture change, not proposed yet |
| `imageRendering: optimizeSpeed` | 30–40% faster | Change | **Rejected:** nearest-neighbour aliasing on downscaled photos |
| JPEG output instead of PNG | Encode is only ~95 ms | Change | Not worth it |
| Decoding | ~35–90 ms per photo | — | Not the bottleneck |

The renderer already does one render per request and frees the Resvg
objects after each.

**No clear defect was found, so the renderer is unchanged.** The risk is
CPU headroom on the 1080×1350 formats, not correctness.

## 5. Minimum safety margin before production

| Measure | Required on the deployed function | This container today |
|---|---|---|
| CPU per render, heaviest template, cold | **≤ 1.0 s** (50% of 2 s) | 1.38–1.44 s — **does not meet it** |
| CPU per render, heaviest template, warm | ≤ 1.0 s | 1.17 s |
| Peak memory as Supabase counts it | **≤ 170 MB** (~66% of 256 MB) | Between the 127 MB lower bound and the 216 MB upper bound |
| Memory creep over 20 sequential warm renders | ≤ +10% | 3 renders: +13% RSS — measure longer |
| Worker-limit (546) errors in the protocol below | 0 | — |

**If the deployed function misses the CPU margin, choose one, in this
order:**

1. Drop the clip wrapper at radius 0 and resolve images as raw bytes
   (renderer v2; goldens and 0057's spec hashes re-checked).
2. Pre-sized derivatives.
3. Render on a Node host with more CPU. The renderer is runtime-neutral and
   byte-identical, and the writes stay in the Creative Engine's database
   session.

Do not deploy for production use until one of these meets the margin.

## 6. Measuring the deployed Edge Function

**Prerequisite (needs approval; not built):** `plan` does not rasterise, and
`preview` writes (a run, a stored asset). So measuring needs a small
team-only `measure` mode that:

- reads and re-hashes the real sources exactly as `preview` does
- renders
- discards the PNG
- returns: the content hash, the PNG size, `performance.now()` timings
  (read, plan, compose, parse, draw, encode), and `Deno.memoryUsage()`
  (rss, heapUsed, external) before and after
- writes nothing: no `creative_begin_run`, no upload, no `creative_write`

Deploy it with `verify_jwt = true` through `deploy-supabase-function.yml`,
only after Tom approves the deploy.

**Protocol:** real Lucas sources, read from `brand-assets` by the
function:

1. **Cold start:** the first request after the deploy (or after the idle
   shutdown), once per template, for all 15. Record the WASM fetch and
   compile, and the font parse, separately. The fetch is I/O, so it is not
   billed as CPU, but it adds latency and depends on jsDelivr. Bundling the
   3.3 MB WASM in the function (within the 20 MB CLI limit) removes that
   dependency.
2. **Warm:** 5 sequential renders per template.
3. **Creep:** 20 sequential renders of service-light · facebook.
4. **Concurrency:** 3 parallel renders of service-light · facebook, since a
   worker can serve more than one request.
5. **Determinism:** every content hash equals the Node golden for the same
   source bytes.

**Evidence to read, beside the mode's own figures:**

- the function's edge logs through `query_logs`: execution time, status
  codes, any 546
- the runtime's worker shutdown events, which carry the reason (CPU time,
  memory, wall clock) and the CPU and memory used; confirm on the first
  deploy that these fields are present
- the Supabase dashboard's per-function CPU and memory charts

Pass means every row of section 5 is met. Record the figures in this note
before any production render.
