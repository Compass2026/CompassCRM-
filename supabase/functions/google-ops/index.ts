// Deployed entry point. The logic is handler.ts (tested with a fake Google
// and a fake Supabase in tests/worker-google-ops.test.mjs).
import { createClient } from "npm:@supabase/supabase-js@2";
import { createGoogleOps } from "./handler.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
Deno.serve(createGoogleOps({ supabase, fetch }));
