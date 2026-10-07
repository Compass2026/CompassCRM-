// Cross-runtime check: renders the golden templates in Deno, wired exactly as
// the Edge Function (supabase/functions/creative-engine/index.ts) wires the
// engine — npm:opentype.js@1.3.4, npm:@resvg/resvg-wasm@2.6.2 with the WASM
// fetched from the pinned URL and hash-checked — and compares every PNG hash
// with tests/fixtures/creative-golden.json, which Node produced.
//   deno run --allow-net --allow-read --allow-env supabase/functions/creative-engine/deno-check.ts
import opentype from "npm:opentype.js@1.3.4";
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import { checkWasm, createEngine, render, RESVG_WASM_VERSION } from "./render.ts";
import { findTemplate } from "./registry.ts";
import { sha256Hex, specHash } from "./spec.ts";
import { lucasPreviewRefs } from "./previews.ts";
// @ts-ignore plain JS helpers shared with the Node tests
import { syntheticSvg } from "../../../tests/helpers/creative-synthetic.mjs";

const root = new URL("../../../", import.meta.url);
const facts = JSON.parse(await Deno.readTextFile(new URL("tests/fixtures/creative-lucas-facts.json", root)));
const golden: Record<string, string> = JSON.parse(await Deno.readTextFile(new URL("tests/fixtures/creative-golden.json", root)));

const wasm = new Uint8Array(await (await fetch(`https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@${RESVG_WASM_VERSION}/index_bg.wasm`)).arrayBuffer());
await checkWasm(wasm);
await initWasm(wasm);
const engine = await createEngine({
  parseFont: (buf) => opentype.parse(buf),
  rasterize: (svg) => {
    const r = new Resvg(svg, { fitTo: { mode: "original" }, font: { loadSystemFonts: false } });
    const img = r.render();
    const png = img.asPng();
    img.free();
    r.free();
    return png;
  },
});

const bytes = new Map<string, Uint8Array>();
for (const a of facts.assets) {
  if (!a.width) continue;
  const png = engine.rasterize(syntheticSvg(a));
  a.content_hash = await sha256Hex(png);
  bytes.set(a.content_hash, png);
}
let bad = 0;
for (const [key, want] of Object.entries(golden)) {
  const t = findTemplate(key, 1)!;
  const t0 = performance.now();
  const r = await render(engine, t, facts, { template: { key, version: 1, spec_hash: await specHash(t.spec) }, client_id: facts.client.id, ...lucasPreviewRefs(key) } as never,
    async (a) => bytes.get(a.content_hash)!);
  const ok = r.content_hash === want;
  if (!ok) bad++;
  console.log(`${ok ? "same" : "DIFFERENT"}  ${key}  ${r.content_hash.slice(0, 16)}  ${(performance.now() - t0).toFixed(0)} ms`);
}
console.log(bad ? `${bad} render(s) differ between Deno and Node` : "Deno renders are byte-identical to Node's");
if (bad) Deno.exit(1);
