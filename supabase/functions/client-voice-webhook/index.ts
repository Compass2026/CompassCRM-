import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import webhooks from "npm:twilio@5.13.1/lib/webhooks/webhooks.js";
import { createVoiceWebhook } from "./handler.ts";
const url = Deno.env.get("SUPABASE_URL")!;
const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
Deno.serve(
  createVoiceWebhook(
    db,
    url + "/functions/v1/client-voice-webhook",
    (token, sig, url, p) => webhooks.validateRequest(token, sig, url, p),
  ),
);
