// Deployed entry point (verify_jwt = true). The logic is handler.ts and
// plan.ts, tested with a fake store (tests/source-assets.test.mjs); the
// database boundary is 0055's, tested in the sandbox.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createSourceAssets } from "./handler.ts";
import { createStore } from "./store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const fn = createSourceAssets({ store: createStore(supabase) });

Deno.serve((req) => fn.handle(req));
