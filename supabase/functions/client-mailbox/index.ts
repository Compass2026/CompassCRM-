import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import { createMailbox } from "./handler.ts";
const base = Deno.env.get("SUPABASE_URL")!;
const db = createClient(base, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
Deno.serve(createMailbox(db, base));
