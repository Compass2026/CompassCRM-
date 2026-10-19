// Deployed entry point (verify_jwt = true: callers send the anon key as the
// bearer plus x-compass-delegation-key). The logic is handler.ts.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createContentApprovals } from "./handler.ts";
import { createStore } from "./store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const approvals = createContentApprovals({ store: createStore(supabase) });

Deno.serve((req) => approvals.handle(req));
