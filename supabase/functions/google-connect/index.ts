// Deployed entry point (verify_jwt = false: Google's redirect carries no JWT;
// the signed state authorizes it, and every POST mode checks a team JWT).
// The logic is handler.ts, tested in tests/google-connect.test.mjs.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createGoogleConnect } from "./handler.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
Deno.serve(createGoogleConnect({ supabase, fetch, selfUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-connect` }));
