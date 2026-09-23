// portal-invite — Supabase Edge Function entry point. All behaviour lives in
// handler.ts (a factory over the Supabase client, so the request boundary is
// unit-tested with a fake one in tests/portal-invite-handler.test.mjs); this
// file only wires the real client.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createPortalInviteHandler } from "./handler.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  // A server-side client: no session to persist or refresh. signInWithOtp
  // (the re-invite for a returning contact) only asks Auth to send the email.
  { auth: { persistSession: false, autoRefreshToken: false } }
);

Deno.serve(createPortalInviteHandler({ supabase }));
