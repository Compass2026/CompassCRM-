// authority-run (Authority Engine D2): turns the deterministic engine
// (../authority, D1.1) into a recorded run.
//
//   version  → what this deployment is, and whether the inventory can
//              resolve DNS here (it fails closed without it).
//   full     → a fresh read-only inventory of the client's public site.
//   refresh  → the latest completed run's inventory, reused.
//
// Synchronously: authenticate, validate, authority_begin_run (so a run
// already running comes back as a real 409), answer 202 {run_id}. In the
// background (EdgeRuntime.waitUntil): the fingerprint first, then the
// input, the inventory, the engine, the completed / degraded decision
// (classify.ts) and one authority_record_run. Any exception records the
// run failed. It writes nothing else: no client facts, keywords, pages, site
// content, Google or publishing, and no Authority table directly.
//
// Callers: the worker (x-cron-secret = SYNC_CRON_SECRET) or a signed-in
// team member (JWT on team_members). Deployed with verify_jwt = true.
import { runAuthority } from "../authority/engine.ts";
import { candidatesFrom, inventorySite, INVENTORY_LIMITS, type Inventory, type InventoryOptions } from "../authority/inventory.ts";
import { systemResolver, type Resolver } from "../authority/netguard.ts";
import { AUTHORITY_VERSION, type AuthorityInput } from "../authority/types.ts";
import { classifyRun, inputHash, safeError, validatePayload, type RecordPayload } from "./classify.ts";
import type { Mode, Store } from "./store.ts";

export const HANDLER_VERSION = 1;
export const MODES = ["full", "refresh", "version"] as const;

export type Deps = {
  store: Store;
  gazetteer?: Record<string, string[]>;       // place names by state (post-drafter/gazetteer.json)
  fetch?: typeof fetch;                        // the inventory's fetch
  resolve?: Resolver | null;                   // the inventory's resolver (default: the system's)
  inventory?: (opts: InventoryOptions) => Promise<Inventory>;
  waitUntil?: (p: Promise<unknown>) => void;   // default: EdgeRuntime.waitUntil
};

type Json = Record<string, unknown>;
type Caller = { via: "worker" | "team"; memberId: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (status: number, body: Json) => Response.json(body, { status });
const bareHost = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; } };

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

export function createAuthorityRun(deps: Deps) {
  const { store } = deps;
  const inventory = deps.inventory ?? inventorySite;
  const waitUntil = deps.waitUntil ?? ((p: Promise<unknown>) => {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
  });

  async function caller(req: Request): Promise<Caller | 401 | 403> {
    const cron = await store.secret("SYNC_CRON_SECRET");
    const header = req.headers.get("x-cron-secret");
    if (cron && header === cron) return { via: "worker", memberId: null };
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const who = await store.caller(jwt);
    if (who !== "none" && who.member) return { via: "team", memberId: who.member };
    // A wrong secret, an anon key or a non-team sign-in is refused, not unknown.
    return who === "none" && !header && !jwt ? 401 : 403;
  }

  async function dnsWorks(): Promise<boolean> {
    const r = deps.resolve === undefined ? await systemResolver() : deps.resolve;
    if (!r) return false;
    try { return (await r("dns.google")).length > 0; } catch { return false; }
  }

  // The background half. Never throws: an exception becomes a failed run.
  async function execute(runId: string, clientId: string, mode: Mode, reuse: Inventory | null): Promise<void> {
    try {
      // Fingerprint BEFORE input: a change landing mid-run reads as stale
      // afterwards, never as falsely fresh.
      const fingerprint = await store.fingerprint(clientId);
      const input = (await store.input(clientId)) as (AuthorityInput & Json) | null;
      if (!input?.client || !input.authority) throw new Error("authority_input returned nothing for this client");
      const siteUrl = input.authority.site?.url ?? null;

      let inv: Inventory | null = null;
      if (mode === "refresh") inv = siteUrl ? reuse : null;
      else if (siteUrl) {
        inv = await inventory({
          site: siteUrl, candidates: candidatesFrom(input),
          maxPages: INVENTORY_LIMITS.maxPages, concurrency: INVENTORY_LIMITS.concurrency,
          timeoutMs: INVENTORY_LIMITS.timeoutMs, budgetMs: INVENTORY_LIMITS.budgetMs, maxBytes: INVENTORY_LIMITS.maxBytes,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.resolve !== undefined ? { resolve: deps.resolve } : {}),
        });
      }
      const health = classifyRun(siteUrl, inv);

      input.authority.inventory = inv ? { fetched_at: inv.fetched_at, pages: inv.pages } : null;
      input.authority.places = (input.client.state && deps.gazetteer?.[input.client.state]) || [];
      const report = runAuthority(input);

      const payload: RecordPayload = {
        status: health.status,
        engine_version: report.version,
        judged_at: report.generated_at,
        as_of: report.as_of,
        input_hash: await inputHash(input),
        section_hashes: fingerprint,
        inventory: inv ? { ...inv, health } : null,
        inventory_errors: health.inventory_errors,
        report,
      };
      const invalid = validatePayload(payload, clientId);
      if (invalid) throw new Error(`The engine's report was refused before recording: ${invalid}`);
      await store.record(runId, payload);
    } catch (e) {
      try { await store.record(runId, { status: "failed", error: safeError(e) }); }
      catch { /* the next authority_begin_run fails a run stuck over 15 minutes */ }
    }
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    const who = await caller(req);
    if (who === 401) return reply(401, { error: "unauthorized" });
    if (who === 403) return reply(403, { error: "forbidden" });
    const body = (await req.json().catch(() => null)) as Json | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "JSON body required" });
    const mode = body.mode;

    if (mode === "version") {
      return reply(200, { version: HANDLER_VERSION, engine: AUTHORITY_VERSION, modes: MODES, limits: INVENTORY_LIMITS, dns: await dnsWorks() });
    }
    if (mode !== "full" && mode !== "refresh") return reply(400, { error: `mode is one of ${MODES.join(", ")}` });
    const clientId = body.client_id;
    if (typeof clientId !== "string" || !UUID.test(clientId)) return reply(400, { error: "client_id (a uuid) is required" });
    const extra = Object.keys(body).filter((k) => k !== "mode" && k !== "client_id");
    if (extra.length) return reply(400, { error: `unexpected field(s): ${extra.join(", ")}` });

    const client = await store.client(clientId);
    if (!client) return reply(404, { error: "client_not_found" });
    if (client.status === "offboarded") return reply(409, { error: "client_offboarded" });

    let reuse: Inventory | null = null;
    if (mode === "refresh") {
      const latest = await store.latestInventory(clientId);
      if (!latest) return reply(409, { error: "needs_full_run", detail: "No completed run to reuse an inventory from; run mode full first." });
      reuse = latest.inventory;
      // The stored observation must still be of the recorded site.
      const input = (await store.input(clientId)) as AuthorityInput | null;
      const siteUrl = input?.authority?.site?.url ?? null;
      if ((siteUrl ?? null) !== null && (!reuse || bareHost(reuse.site) !== bareHost(siteUrl!))) {
        return reply(409, { error: "needs_full_run", detail: "The latest completed run has no inventory of the site now recorded; run mode full." });
      }
    }

    const begun = await store.begin(clientId, mode, who.via, who.memberId);
    if ("conflict" in begun) return reply(409, { error: "run_in_progress", run_id: begun.running_run_id });

    waitUntil(execute(begun.run_id, clientId, mode, reuse));
    return reply(202, { run_id: begun.run_id, mode, status: "running" });
  }

  return { handle, execute };
}
