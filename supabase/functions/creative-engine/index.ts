// Deployed entry point (verify_jwt = true). The logic is handler.ts, govern.ts
// and render.ts, tested in Node with the same pinned WASM and fonts
// (tests/creative-engine*.test.mjs). NOT DEPLOYED yet: it needs migration
// 0057 (overlay roles) applied and the Lucas templates registered, each on
// Tom's approval.
//
// The resvg WASM is fetched once per worker from a pinned URL and refused
// unless it hashes to the pinned value (render.ts), so this function and the
// Node tests rasterise with byte-identical code.
import { createClient } from "npm:@supabase/supabase-js@2";
import opentype from "npm:opentype.js@1.3.4";
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import { createCreativeEngine } from "./handler.ts";
import { checkWasm, createEngine, RESVG_WASM_VERSION, type Engine } from "./render.ts";
import { createStore } from "./store.ts";

const WASM_URL = `https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@${RESVG_WASM_VERSION}/index_bg.wasm`;

let ready: Promise<Engine> | null = null;
function engine(): Promise<Engine> {
  ready ??= (async () => {
    const res = await fetch(WASM_URL);
    if (!res.ok) throw new Error(`resvg wasm: ${res.status}`);
    const wasm = new Uint8Array(await res.arrayBuffer());
    await checkWasm(wasm);
    await initWasm(wasm);
    return createEngine({
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
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const fn = createCreativeEngine({ store: createStore(supabase), engine });

Deno.serve((req) => fn.handle(req));
