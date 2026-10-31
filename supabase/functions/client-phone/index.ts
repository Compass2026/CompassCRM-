import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import AccessToken from "npm:twilio@5.13.1/lib/jwt/AccessToken.js";
import { createClientPhone } from "./handler.ts";
const base = Deno.env.get("SUPABASE_URL")!;
const db = createClient(base, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
Deno.serve(
  createClientPhone(db, base, (c) => {
    const t = new AccessToken(c.account, c.key, c.secret, {
      identity: c.identity,
      ttl: 300,
    });
    t.addGrant(
      new AccessToken.VoiceGrant({
        outgoingApplicationSid: c.app,
        incomingAllow: true,
      }),
    );
    return t.toJwt();
  }),
);
