import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import { createCallWorker } from "./handler.ts";
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{
  auth:{persistSession:false,autoRefreshToken:false},
});
Deno.serve(createCallWorker(db));
