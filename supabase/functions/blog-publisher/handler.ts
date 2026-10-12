import { preparePublication, publicationPaths, type BlogRelease, type RepositoryRead } from "../content-drafter/publication.ts";
import { buildBlogBrief, type DraftRow } from "../content-drafter/brief.ts";
import { lintBlog } from "../content-drafter/lint.ts";
import { parseBlogDraft } from "../content-drafter/handler.ts";
import { stableJson } from "../post-drafter/rules.ts";
import type { DrafterInput } from "../post-drafter/types.ts";
type Json = Record<string, unknown>;
type Publication = { id: string; lease_token: string; release_hash: string; snapshot: BlogRelease & Json; scheduled_at: string; status: string };
export type Deps = {
  authorized(req: Request): Promise<boolean>;
  claim(id: string): Promise<Publication>;
  authorize(id: string, token: string): Promise<void>;
  finish(id: string, token: string, status: string, evidence: Json, error?: string): Promise<void>;
  input(client: string): Promise<DrafterInput>;
  pages(client: string): Promise<{ url: string; title: string }[]>;
  sitePush(body: Json): Promise<Response>;
  fetchLive(url: string): Promise<Response>;
  gazetteer?: Record<string, string[]>;
};
const plain = (s: string) => s.replace(/<\/(?:p|h[1-6]|li|div|article)>/gi," ").replace(/<[^>]*>/g,"").replace(/&(?:amp|#38);/g,"&").replace(/&(?:quot|#34);/g,'"')
  .replace(/&(?:apos|#39|#x27);/g,"'").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();
export function verifyLiveArticle(html: string, r: BlogRelease, hash: string, url: string): boolean {
  if (!html.includes(`data-compass-release="${hash}"`) || !html.includes(`href="${url}"`)
      || /<meta[^>]+(?:name|http-equiv)=["'](?:robots|x-robots-tag)["'][^>]+noindex/i.test(html)) return false;
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "";
  if (plain(h1) !== r.h1) return false;
  const text = plain(html);
  const prose = r.body_markdown.replace(/\[([^\]]+)\]\([^)]+\)/g,"$1").replace(/[*_`#]/g,"");
  // Check every authored nonempty line, not just a title that might also occur
  // on a 404, old article or listing page.
  if (!prose.split(/\n+/).map((s)=>s.replace(/^\s*(?:-|\d+\.)\s+/,"").trim()).filter(Boolean).every((s)=>text.includes(plain(s)))) return false;
  return r.internal_links.every((l)=>html.includes(`href="${l.url.replaceAll("&","&amp;")}"`));
}
export function createBlogPublisher(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return Response.json({error:"POST only"},{status:405});
    if (!await deps.authorized(req)) return Response.json({error:"forbidden"},{status:403});
    const body = await req.json().catch(()=>null);
    if (!/^[0-9a-f-]{36}$/i.test(body?.publication_id ?? "")) return Response.json({error:"publication_id required"},{status:400});
    let p: Publication;
    try { p = await deps.claim(body.publication_id); }
    catch (error) { return Response.json({error:String(error)},{status:409}); }
    if (p.status !== "publishing" || !p.lease_token) return Response.json(p);
    let externalWriteStarted = false;
    let evidence: Json = {};
    try {
      const r = p.snapshot;
      const input = await deps.input(r.client_id);
      const brief = buildBlogBrief(input, {...r,id:r.draft_id,deliverable:"blog",status:"approved"} as unknown as DraftRow,await deps.pages(r.client_id));
      if (!brief.ok) throw new Error(brief.refusals.map((x)=>x.message).join(" "));
      const foundation = (b: Record<string, unknown>) => stableJson({
        client:b.client, target:b.target, brand:b.brand, gate:b.gate, cta:b.cta, rules:b.rules,
      });
      if (!r.brief || foundation(r.brief as Json) !== foundation(brief.brief as unknown as Json)) {
        throw new Error("Keyword, brand or campaign foundation changed since review. Regenerate and review before publishing.");
      }
      const parsed = parseBlogDraft({...r,claim_ids:(r.claims as {id:string}[]).map((c)=>c.id)});
      if (typeof parsed === "string") throw new Error(parsed);
      const lint = lintBlog(brief.brief,parsed,{gazetteer:(input.client.state && deps.gazetteer?.[input.client.state]) || []});
      if (!lint.ok) throw new Error(lint.problems.map((x)=>x.message).join(" "));
      evidence = {lint};
      const readRes = await deps.sitePush({client_id:r.client_id,read:true,paths:publicationPaths(r)});
      if (!readRes.ok) throw new Error("Could not read the approved website repository");
      const read = await readRes.json() as RepositoryRead;
      const date = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(p.scheduled_at));
      const delivery = preparePublication(r,p.release_hash,read,date);
      if (delivery.already_present) throw new Error("The released article already exists. Reconcile its deployment without creating another commit.");
      await deps.authorize(p.id,p.lease_token);
      externalWriteStarted = true;
      const pushRes = await deps.sitePush({client_id:r.client_id,repo:r.destination.repo_url.replace("https://github.com/",""),
        branch:r.destination.branch,expected_head:delivery.expected_head,files:delivery.files,
        message:`Publish approved blog ${r.slug} [${p.id}]`});
      const pushed = await pushRes.json();
      const sha = /\/commit\/([0-9a-f]{40})$/.exec(pushed.commit_url ?? "")?.[1];
      evidence = {...evidence,commit_sha:sha,url:delivery.url,transport:pushed,
        deployment_state:pushed.vercel?.ready_state,deployment_target:pushed.vercel?.target};
      if (!pushRes.ok || !sha || pushed.vercel?.ready_state !== "READY" || pushed.vercel?.target !== "production") {
        throw new Error("Website commit or deployment is not confirmed. Reconcile before retrying.");
      }
      const live = await deps.fetchLive(delivery.url);
      if (!live.ok || /noindex/i.test(live.headers.get("x-robots-tag") ?? "")
          || !verifyLiveArticle(await live.text(),r,p.release_hash,delivery.url)) throw new Error("Production deployment exists; the complete live article is not yet verified.");
      evidence.live_verified = true;
      await deps.finish(p.id,p.lease_token,"published",evidence);
      return Response.json({status:"published",url:delivery.url,commit_sha:sha});
    } catch (error) {
      const status = externalWriteStarted ? "uncertain" : "blocked";
      const message = error instanceof Error ? error.message : String(error);
      await deps.finish(p.id,p.lease_token,status,evidence,message);
      return Response.json({status,error:message},{status:409});
    }
  };
}
