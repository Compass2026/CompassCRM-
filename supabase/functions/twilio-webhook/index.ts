// Deployed entry point (verify_jwt = false: Twilio sends no JWT; the Twilio
// signature is the authentication). The logic is handler.ts, tested with a
// fake store and the real SDK validator (tests/twilio-webhook-handler.test.mjs);
// the database boundary is 0063's, tested in the sandbox.
import { createClient } from "npm:@supabase/supabase-js@2";
// The official SDK's webhook validator only (no REST client in the bundle).
import webhooks from "npm:twilio@5.13.1/lib/webhooks/webhooks.js";
import { createTwilioWebhook } from "./handler.ts";
import { createStore } from "./store.ts";
import { webhookBase } from "../_shared/communications/credentials.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const store = createStore(supabase);

let base: string | null = null;
const fn = createTwilioWebhook({
  store,
  validate: (token, signature, url, params) => webhooks.validateRequest(token, signature, url, params),
  publicBase: async () => (base ??= webhookBase(await store.secret("TWILIO_WEBHOOK_BASE_URL"), supabaseUrl)),
  log: (event, detail) => console.log(JSON.stringify({ fn: "twilio-webhook", event, ...detail })),
});

Deno.serve((req) => fn.handle(req));
