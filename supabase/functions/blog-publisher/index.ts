import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import { createBlogPublisher } from "./handler.ts";
import { createStore } from "../content-drafter/store.ts";
import { createSitePushHandler } from "../site-push/handler.ts";
import gazetteer from "../post-drafter/gazetteer.json" with { type: "json" };
const supabase = createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const store = createStore(supabase);
const push = createSitePushHandler({supabase,fetch,timing:{findMs:60000,settleMs:60000,pollMs:4000}});
const rpc = async (name: string,args: Record<string,unknown>) => {
  const {data,error} = await supabase.rpc(name,args);
  if (error) throw new Error(error.message);
  return data;
};
Deno.serve(createBlogPublisher({
  gazetteer,
  async authorized(req) {
    const secret = await store.secret("SYNC_CRON_SECRET");
    if (secret && req.headers.get("x-cron-secret") === secret) return true;
    return !!await store.teamMemberForJwt((req.headers.get("authorization")??"").replace(/^Bearer /,""));
  },
  claim: (id) => rpc("blog_publication_claim",{p_id:id}),
  authorize: (id,token) => rpc("blog_publication_authorize",{p_id:id,p_token:token}),
  finish: (id,token,status,evidence,error) => rpc("blog_publication_finish",{p_id:id,p_token:token,p_status:status,p_evidence:evidence,p_error:error??null}),
  async input(client) { const input=await store.input(client); if (!input) throw new Error("Client intelligence unavailable"); return input; },
  pages: store.sitePages,
  async sitePush(body) {
    const secret = await store.secret("SYNC_CRON_SECRET");
    if (!secret) throw new Error("Website publisher secret is missing");
    return push(new Request("https://internal/site-push",{method:"POST",headers:{"content-type":"application/json","x-cron-secret":secret},body:JSON.stringify(body)}));
  },
  fetchLive: (url) => fetch(url,{redirect:"error",headers:{"cache-control":"no-cache"},signal:AbortSignal.timeout(15000)}),
}));
