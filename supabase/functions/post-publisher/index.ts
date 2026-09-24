// Deployed entry point. The logic is handler.ts (tested with a fake Google
// and a fake store, and end to end against PostgREST in the sandbox).
import { createClient } from "npm:@supabase/supabase-js@2";
import { createPostPublisher } from "./handler.ts";
import { createStore } from "./store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const publisher = createPostPublisher({ store: createStore(supabase), fetch });

Deno.serve((req) => publisher.handle(req));
