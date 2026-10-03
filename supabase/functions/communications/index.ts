// Deployed entry point (verify_jwt = true). The logic is handler.ts, tested
// with a fake store and a fake Twilio (tests/communications-handler.test.mjs)
// and end to end over PostgREST (npm run test:communications); the database
// boundary is 0063's, tested in the sandbox.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createCommunications } from "./handler.ts";
import { createStore } from "./store.ts";
import { createTwilioProvider } from "../_shared/communications/twilio.ts";
import { webhookBase } from "../_shared/communications/credentials.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const store = createStore(supabase);

let base: string | null = null;
const fn = createCommunications({
  store,
  provider: createTwilioProvider((input, init) => fetch(input, init)),
  webhookBase: async () => (base ??= webhookBase(await store.secret("TWILIO_WEBHOOK_BASE_URL"), supabaseUrl)),
  log: (event, detail) => console.log(JSON.stringify({ fn: "communications", event, ...detail })),
});

Deno.serve((req) => fn.handle(req));
