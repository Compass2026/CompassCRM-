// Deployed entry point (verify_jwt = true: callers send the anon key as the
// bearer plus x-compass-delegation-key). The logic is handler.ts.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createContentApprovals } from "./handler.ts";
import { createCopyCheck } from "./copy-check.ts";
import { createPostTargetReader, createStore } from "./store.ts";
import { createStore as createDrafterStore } from "../post-drafter/store.ts";
import gazetteer from "../post-drafter/gazetteer.json" with { type: "json" };

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const drafter = createDrafterStore(supabase);
const copyCheck = createCopyCheck({
  postTarget: createPostTargetReader(supabase),
  input: (clientId, serviceId, keywordId) => drafter.input(clientId, serviceId, keywordId),
  socialAccounts: (clientId) => drafter.socialAccounts(clientId),
  gazetteer,
});
const approvals = createContentApprovals({ store: createStore(supabase), copyCheck });

Deno.serve((req) => approvals.handle(req));
