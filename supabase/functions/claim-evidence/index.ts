// claim-evidence — Supabase Edge Function entry point. All behaviour lives in
// handler.ts (a factory over the Supabase client, so the request boundary is
// unit-tested with a fake one in tests/claim-evidence-handler.test.mjs); this
// file only wires the real service-role client.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createClaimEvidenceHandler } from "./handler.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

Deno.serve(createClaimEvidenceHandler({ supabase }));
