import { preparePublication, publicationPaths, type BlogRelease, type RepositoryRead } from "../content-drafter/publication.ts";
import { buildBlogBrief, type DraftRow } from "../content-drafter/brief.ts";
import { lintBlog } from "../content-drafter/lint.ts";
import { parseBlogDraft } from "../content-drafter/handler.ts";
import { stableJson } from "../post-drafter/rules.ts";
import type { DrafterInput } from "../post-drafter/types.ts";
type Json = Record<string, unknown>;
type Publication = { id: string; lease_token: string; release_hash: string; snapshot: BlogRelease & Json; scheduled_at: string; status: string; evidence?: Json; reconcile_reason?: string };
export type Deps = {
  authorized(req: Request): Promise<boolean>;
  claim(id: string): Promise<Publication>;
  resume(id: string): Promise<Publication>;
  authorize(id: string, token: string): Promise<void>;
  finish(id: string, token: string, status: string, evidence: Json, error?: string): Promise<void>;
  input(client: string, service: string | null): Promise<DrafterInput>;
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
  const bodyUrls = [...r.body_markdown.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  return [...r.internal_links.map((l) => l.url), ...bodyUrls].every((url)=>html.includes(`href="${url.replaceAll("&","&amp;")}"`));
}
export function createBlogPublisher(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return Response.json({error:"POST only"},{status:405});
    if (!await deps.authorized(req)) return Response.json({error:"forbidden"},{status:403});
    const body = await req.json().catch(()=>null);
    if (!/^[0-9a-f-]{36}$/i.test(body?.publication_id ?? "")) return Response.json({error:"publication_id required"},{status:400});
    const reconciling = body.reconcile === true;
    let p: Publication;
    try { p = reconciling ? await deps.resume(body.publication_id) : await deps.claim(body.publication_id); }
    catch (error) { return Response.json({error:String(error)},{status:409}); }
    if (p.status !== "publishing" || !p.lease_token) return Response.json(p);
    let externalWriteStarted = false;
    let evidence: Json = reconciling ? {...(p.evidence ?? {})} : {};
    try {
      const r = p.snapshot;
      if (reconciling) {
        // Reconciliation is a read-and-verify operation first. The exact
        // approved release may already be publicly deployed even if today's
        // brand/keyword inputs changed after its initial authorized write.
        // Recording that historical fact is not permission for a new write.
        const inspect = await deps.sitePush({client_id:r.client_id,site_id:r.destination.site_id,read:true,paths:publicationPaths(r)});
        if (!inspect.ok) throw new Error("Could not inspect the approved repository");
        const repository = await inspect.json() as RepositoryRead;
        const date = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(p.scheduled_at));
        const prepared = preparePublication(r,p.release_hash,repository,date);
        if (prepared.already_present) {
          const prior = p.evidence ?? {};
          const vercel = ((prior.transport as Json | undefined)?.vercel ?? {}) as Json;
          const deploymentUrl = String(vercel.deployment_url ?? r.destination.url);
          const sha = String(prior.commit_sha ?? repository.head);
          if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Commit provenance cannot be established");
          const inspectDeployment = await deps.sitePush({client_id:r.client_id,site_id:r.destination.site_id,deployment_status:deploymentUrl});
          if (!inspectDeployment.ok) throw new Error("Production deployment inspection is unavailable");
          const deployment = await inspectDeployment.json() as Json;
          if (deployment.ready_state !== "READY" || deployment.target !== "production") {
            throw new Error("Production deployment is not READY");
          }
          const live = await deps.fetchLive(prepared.url);
          if (!live.ok || /noindex/i.test(live.headers.get("x-robots-tag") ?? "")
              || !verifyLiveArticle(await live.text(),r,p.release_hash,prepared.url)) {
            throw new Error("Exact approved article not yet verified on the public domain");
          }
          await deps.authorize(p.id,p.lease_token);
          evidence = {...evidence,commit_sha:sha,url:prepared.url,
            deployment_state:"READY",deployment_target:"production",live_verified:true,
            reconciliation:{mode:"verified_existing_release",deployment_id:deployment.deployment_id ?? null}};
          await deps.finish(p.id,p.lease_token,"published",evidence);
          return Response.json({status:"published",url:prepared.url,commit_sha:sha,reconciled:true});
        }
        if (p.reconcile_reason === "verify existing release only") {
          throw new Error("Missing-commit receipt requires manual review; do not create a new publication");
        }
      }
      const input = await deps.input(r.client_id, (r as BlogRelease & {service_id?: string}).service_id ?? null);
      // The immutable approval snapshot uses draft_id and stores the author's
      // request note inside the approved brief, not as a top-level field.
      // Rebuild with that same reviewed identity before comparing foundations.
      // Never substitute today's note or skip validation of actual brand changes.
      const approvedNote = (r.brief as { target?: { request_note?: string | null } } | undefined)?.target?.request_note ?? null;
      const brief = buildBlogBrief(input, {
        ...r, id:r.draft_id, request_note:approvedNote, deliverable:"blog",status:"approved",
      } as unknown as DraftRow,await deps.pages(r.client_id));
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
      evidence = {...evidence,lint};
      const readRes = await deps.sitePush({client_id:r.client_id,site_id:r.destination.site_id,read:true,paths:publicationPaths(r)});
      if (!readRes.ok) throw new Error("Could not read the approved website repository");
      const read = await readRes.json() as RepositoryRead;
      const date = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(p.scheduled_at));
      const delivery = preparePublication(r,p.release_hash,read,date);
      if (delivery.already_present) throw new Error("Approved release exists; reconcile the verified live page without writing another commit.");
      await deps.authorize(p.id,p.lease_token);
        evidence = {...previous,commit_sha:sha,url:delivery.url,
          deployment_state:"READY",deployment_target:"production",live_verified:true,
          reconciliation:{mode:"existing_release",deployment_id:deployment.deployment_id ?? null}};
        await deps.finish(p.id,p.lease_token,"published",evidence);
        return Response.json({status:"published",url:delivery.url,commit_sha:sha,reconciled:true});
      }
      await deps.authorize(p.id,p.lease_token);
      externalWriteStarted = true;
      const pushRes = await deps.sitePush({client_id:r.client_id,site_id:r.destination.site_id,repo:r.destination.repo_url.replace("https://github.com/",""),
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
      // An uncertain release is never retried blindly. On reconciliation,
      // preserve its previous commit/transport receipt so the next read can
      // distinguish a completed write from a rejected fast-forward update.
      const status = externalWriteStarted || reconciling ? "uncertain" : "blocked";
      const message = error instanceof Error ? error.message : String(error);
      if (reconciling) evidence = {...evidence,reconciliation_error:message};
      const recordedError = reconciling
        ? "Website commit or deployment is not confirmed. Reconcile before retrying."
        : message;
      await deps.finish(p.id,p.lease_token,status,evidence,recordedError);
      return Response.json({status,error:message},{status:409});
    }
  };
}
