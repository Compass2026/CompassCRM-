import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import { Webhook } from "npm:svix@2.9.1";
import { createEmailWebhook } from "./handler.ts";
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
Deno.serve(
  createEmailWebhook(db, (raw, headers, secret) =>
    new Webhook(secret).verify(raw, headers),
  ),
);
