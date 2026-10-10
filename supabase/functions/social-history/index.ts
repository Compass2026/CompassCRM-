// Deployed entry point (verify_jwt = true). The logic is handler.ts, tested
// with a fake store and a fake Zernio (tests/social-history-*.test.mjs); the
// database rules by the sandbox's social_history.test.sql.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createSocialHistory } from "./handler.ts";
import { createStore } from "./store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const history = createSocialHistory({ store: createStore(supabase) });

Deno.serve((req) => history.handle(req));
