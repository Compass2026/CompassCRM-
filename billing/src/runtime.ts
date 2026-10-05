// What the three billing entry points share (Option B, docs/billing-runtime.md):
// the environment of the compass-billing Vercel project, the database pool for
// the billing_sync login, the Stripe key check, and the adapter from Vercel's
// Node request to the Fetch-API Request the handlers take.
//
// Environment (compass-billing project only; nothing here is in Supabase):
//   STRIPE_SECRET_KEY      sk_test_… / rk_test_… (a live key is refused
//                          unless BILLING_ALLOW_LIVE is exactly "true")
//   STRIPE_WEBHOOK_SECRET  the signing secret of the endpoint that points here
//   CRON_SECRET            Vercel Cron's bearer for the daily reconciliation
//   BILLING_DATABASE_URL   Supavisor transaction-pooler URL for billing_sync
//   BILLING_DATABASE_CA    optional: the project's CA certificate (PEM); with
//                          it the database certificate is verified
//   SUPABASE_URL, SUPABASE_ANON_KEY   public: where to verify a caller's JWT
//   APP_BASE_URL           optional: the CRM's https origin (return links)
//   BILLING_ALLOW_LIVE     "true" only at go-live, with a live key

import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { keyMode } from "../../supabase/functions/_shared/stripe/api.ts";
import { createPgStore, supabaseAuthUser } from "./store.ts";

export const DEFAULT_APP_URL = "https://compass-crm-ten.vercel.app";

export function env(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

// The Stripe key, if this deployment may use it: a test key always; a live key
// only once BILLING_ALLOW_LIVE is "true" (the handlers additionally refuse a
// live key until billing is switched to live in the CRM).
export function stripeKey(): string | null {
  const key = env("STRIPE_SECRET_KEY");
  if (!key || !/^(sk|rk)_(test|live)_/.test(key)) return null;
  if (keyMode(key) === "live" && env("BILLING_ALLOW_LIVE") !== "true") return null;
  return key;
}

export function appBaseUrl(): string {
  const v = env("APP_BASE_URL")?.replace(/\/$/, "");
  return v && /^https:\/\/[^\s/]+$/.test(v) ? v : DEFAULT_APP_URL;
}

// One small pool per function instance; Supavisor's transaction mode does the
// real pooling. The connection string's sslmode is dropped in favour of an
// explicit TLS setting: verified against BILLING_DATABASE_CA when it is set,
// encrypted but unverified otherwise.
let pool: pg.Pool | null = null;
export function database(): pg.Pool {
  if (pool) return pool;
  const raw = env("BILLING_DATABASE_URL");
  if (!raw) throw new Error("BILLING_DATABASE_URL is not set");
  const url = new URL(raw);
  url.searchParams.delete("sslmode");
  const ca = env("BILLING_DATABASE_CA");
  pool = new pg.Pool({
    connectionString: url.toString(),
    ssl: ca ? { ca: ca.replace(/\\n/g, "\n"), rejectUnauthorized: true } : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    application_name: "compass-billing",
  });
  return pool;
}

export function billingStore() {
  const url = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY");
  if (!url || !anonKey) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  return createPgStore(database(), {
    authUser: supabaseAuthUser({ url, anonKey }),
    reconcileSecret: env("CRON_SECRET"),
  });
}

// Work that outlives the response (reconciliation answers 202 first): handed
// to Vercel's waitUntil when the platform provides it, otherwise awaited
// before the response is sent.
export function backgroundWork(): { waitUntil: (p: Promise<unknown>) => void; drain: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  // deno-lint-ignore no-explicit-any
  const ctx = (globalThis as any)[Symbol.for("@vercel/request-context")]?.get?.();
  return {
    waitUntil: (p) => {
      const settled = p.catch(() => undefined);
      if (typeof ctx?.waitUntil === "function") ctx.waitUntil(settled);
      else pending.push(settled);
    },
    drain: async () => {
      await Promise.all(pending);
    },
  };
}

// Vercel's Node launcher (req, res) → the handler's Request → Response. The
// body is passed through byte for byte (the webhook signs the raw body).
export function nodeEntry(handle: (req: Request, work: ReturnType<typeof backgroundWork>) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const work = backgroundWork();
    let response: Response;
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
      const method = req.method ?? "GET";
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) for (const x of v) headers.append(k, x);
        else if (v !== undefined) headers.set(k, v);
      }
      const request = new Request(`https://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      response = await handle(request, work);
    } catch (e) {
      console.error("billing runtime error", e);
      response = new Response(JSON.stringify({ error: "failed" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    await work.drain();
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.setHeader("cache-control", "no-store");
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

// Constant-time comparison (Vercel Cron's bearer).
export function sameSecret(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
