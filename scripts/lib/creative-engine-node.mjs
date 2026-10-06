// The Creative Engine renderer wired for Node (tests and the read-only
// preview script): the same pinned resvg WASM (hash-checked) and opentype.js
// the Edge Function uses, so a render here is byte-identical to one there.
import fs from "node:fs";
import opentype from "opentype.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { checkWasm, createEngine } from "../../supabase/functions/creative-engine/render.ts";

let ready;
export function rasterizeWith(ResvgCtor) {
  return (svg) => {
    const r = new ResvgCtor(svg, { fitTo: { mode: "original" }, font: { loadSystemFonts: false } });
    const img = r.render();
    const png = img.asPng();
    img.free();
    r.free();
    return png;
  };
}
export function nodeEngine() {
  ready ??= (async () => {
    const wasm = fs.readFileSync(new URL("../../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url));
    await checkWasm(wasm);
    await initWasm(wasm);
    return createEngine({ parseFont: (buf) => opentype.parse(buf), rasterize: rasterizeWith(Resvg) });
  })();
  return ready;
}
