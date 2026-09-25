// Deployed entry point (verify_jwt = true). The logic is handler.ts, tested
// with a fake store and end to end against PostgREST over the sandbox replay.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createAuthorityRun } from "./handler.ts";
import { createStore } from "./store.ts";
import gazetteer from "../post-drafter/gazetteer.json" with { type: "json" };

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const run = createAuthorityRun({ store: createStore(supabase), gazetteer });

Deno.serve((req) => run.handle(req));
