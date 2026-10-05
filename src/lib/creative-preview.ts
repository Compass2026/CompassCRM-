// Read-only Creative Engine previews in the CRM (Brand › Creative previews).
// The same renderer as the creative-engine function (identical bytes: the
// pinned resvg WASM is fetched once, hash-checked, and the fonts are the
// embedded, hash-checked ones). Facts and source files are read with the
// signed-in teammate's own session, so RLS decides what can be read.
//
// Nothing here writes: no run, asset, template, post or approval. Recording
// a preview (creative_runs / creative_assets / a proposed client template)
// is the creative-engine function's job, once 0057 is applied and the
// templates are registered.
import opentype from "opentype.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { checkWasm, createEngine, RESVG_WASM_VERSION, type Engine } from "../../supabase/functions/creative-engine/render.ts";
import type { OtFont } from "../../supabase/functions/creative-engine/text.ts";
import { createStore } from "../../supabase/functions/creative-engine/store.ts";
import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

const WASM_URL = `https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@${RESVG_WASM_VERSION}/index_bg.wasm`;
let ready: Promise<Engine> | null = null;

export function previewEngine(): Promise<Engine> {
  ready ??= (async () => {
    const res = await fetch(WASM_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`resvg wasm: HTTP ${res.status}`);
    const wasm = new Uint8Array(await res.arrayBuffer());
    await checkWasm(wasm);
    await initWasm(wasm);
    return createEngine({
      parseFont: (buf) => opentype.parse(buf) as OtFont,
      rasterize: (svg) => {
        const r = new Resvg(svg, { fitTo: { mode: "original" }, font: { loadSystemFonts: false } });
        const img = r.render();
        const png = img.asPng();
        img.free();
        r.free();
        return png;
      },
    });
  })();
  ready.catch(() => {
    ready = null;
  });
  return ready;
}

// Facts and file reads only; the store's write methods are never called here
// (and a teammate's session holds no grant for them).
export function previewReader(supabase: Supabase) {
  const store = createStore(supabase);
  return { facts: store.facts, read: store.read };
}
