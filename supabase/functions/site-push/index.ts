// site-push — Supabase Edge Function entry point. All behaviour lives in
// handler.ts (a factory over its external dependencies, so the request
// boundary is unit-tested with a fake GitHub and a fake Supabase client);
// this file only wires the real ones.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createSitePushHandler } from "./handler.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(createSitePushHandler({ supabase, fetch: (input, init) => fetch(input, init) }));
