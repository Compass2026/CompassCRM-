// owner-page-check (20261028170000): checks a client's keyword owner pages
// and records one owner_page_checks row per page. It writes nothing else: no
// keyword, page group, market, list, post or site.
//
//   POST {client_id, brand_workspace_id?} → the owner pages of the keywords in
//   the client's proposed and approved core lists (and their named supporting
//   children), from owner_page_check_targets(); at most MAX_PAGES a call.
//
// Every fetch goes through the Authority inventory's network guard (public
// addresses only, no redirects followed blindly, a size and time cap). One
// probe per host (a path that cannot exist) separates a real page from a
// host that answers every path. Callers: the worker (x-cron-secret =
// SYNC_CRON_SECRET) or a signed-in team member. Deployed verify_jwt = true.
import { checkHost, systemResolver, type Resolver } from "../authority/netguard.ts";
import { judgePage, type Fetched } from "./check.ts";

export const MAX_PAGES = 60;
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Target = { url: string; site_url: string; keyword_count: number };
export type Store = {
  secret(name: string): Promise<string | null>;
  teamMember(jwt: string): Promise<string | null>;
  targets(clientId: string, programId: string | null): Promise<Target[]>;
  record(row: Record<string, unknown>): Promise<void>;
};
export type Deps = { store: Store; fetch?: typeof fetch; resolve?: Resolver | null; runId?: () => string };

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

// Follows redirects by hand so every hop is guarded; answers status 0 on failure.
export async function guardedGet(url: string, f: typeof fetch, resolve: Resolver | null): Promise<Fetched> {
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try { u = new URL(at); } catch { return { status: 0, finalUrl: at, html: "" }; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { status: 0, finalUrl: at, html: "" };
    const host = await checkHost(u.hostname, resolve);
    if (!host.ok) return { status: 0, finalUrl: at, html: "" };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await f(at, { redirect: "manual", signal: ctl.signal, headers: { "user-agent": "CompassOwnerPageCheck/1 (+https://compassmarketing.ai)" } });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        at = new URL(r.headers.get("location")!, at).toString();
        continue;
      }
      const reader = r.body?.getReader();
      let html = "";
      if (reader) {
        const dec = new TextDecoder();
        let n = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          n += value.length;
          html += dec.decode(value, { stream: true });
          if (n > MAX_BYTES) { await reader.cancel(); break; }
        }
      }
      return { status: r.status, finalUrl: at, html };
    } catch {
      return { status: 0, finalUrl: at, html: "" };
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 0, finalUrl: at, html: "" };
}

export function createOwnerPageCheck(deps: Deps) {
  const f = deps.fetch ?? fetch;
  const runId = deps.runId ?? (() => crypto.randomUUID());
  return {
    async handle(req: Request): Promise<Response> {
      if (req.method !== "POST") return reply(405, { error: "POST only" });
      const cron = await deps.store.secret("SYNC_CRON_SECRET");
      const viaCron = !!cron && req.headers.get("x-cron-secret") === cron;
      if (!viaCron) {
        const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
        if (!jwt) return reply(401, { error: "Sign in or use the cron secret" });
        if (!(await deps.store.teamMember(jwt))) return reply(403, { error: "Team members only" });
      }
      let body: Record<string, unknown>;
      try { body = await req.json(); } catch { return reply(400, { error: "JSON body required" }); }
      const clientId = String(body.client_id ?? "");
      const programId = body.brand_workspace_id == null ? null : String(body.brand_workspace_id);
      if (!UUID.test(clientId) || (programId !== null && !UUID.test(programId))) return reply(400, { error: "client_id (and brand_workspace_id) are uuids" });

      const targets = (await deps.store.targets(clientId, programId)).slice(0, MAX_PAGES);
      const resolve = deps.resolve === undefined ? await systemResolver() : deps.resolve;
      const run = `owner-page-check:${runId()}`;
      const probes = new Map<string, Fetched>();
      const results: { url: string; verdict: string; detail: string | null }[] = [];
      for (const t of targets) {
        const origin = new URL(t.url).origin;
        if (!probes.has(origin)) probes.set(origin, await guardedGet(`${origin}/compass-check-${run.slice(-12)}-does-not-exist`, f, resolve));
        const page = await guardedGet(t.url, f, resolve);
        const v = await judgePage(t.url, t.site_url, page, probes.get(origin)!);
        await deps.store.record({ client_id: clientId, requested_url: t.url, final_url: v.final_url, http_status: v.http_status,
          verdict: v.verdict, method: "http", title: v.title, h1: v.h1, canonical: v.canonical, content_sha256: v.content_sha256,
          detail: v.detail, source_ref: run });
        results.push({ url: t.url, verdict: v.verdict, detail: v.detail });
      }
      return reply(200, { run, checked: results.length, live: results.filter((r) => r.verdict === "live").length, results });
    },
  };
}
