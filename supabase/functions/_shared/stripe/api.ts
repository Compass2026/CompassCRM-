// Minimal Stripe REST client for the billing sync (B2). No SDK: every call is
// a plain fetch with a pinned API version, so the sync layer runs unchanged
// in Deno (Edge Functions) and Node (tests with a fake fetch), and the object
// shapes the mappers read are fixed by STRIPE_API_VERSION rather than by the
// account's default.
//
// Read-only in B2: the sync layer only ever reads Stripe (Stripe wins; Compass
// never changes Stripe because Compass disagrees with it). B3 adds the writes
// its actions need (Checkout, portal sessions, customers) with idempotency keys.

export const STRIPE_API_VERSION = "2025-03-31.basil";

// deno-lint-ignore no-explicit-any
export type StripeObject = Record<string, any>;

export class StripeApiError extends Error {
  status: number;
  code: string | null;
  type: string | null;
  constructor(status: number, body: StripeObject | null, path: string) {
    const err = body?.error ?? {};
    super(`Stripe ${status} on ${path}: ${err.message ?? "no message"}`);
    this.status = status;
    this.code = err.code ?? null;
    this.type = err.type ?? null;
  }
  // The object does not exist (never did, or was deleted and is no longer retrievable).
  get missing(): boolean {
    return this.status === 404 || this.code === "resource_missing";
  }
}

export type StripeApi = {
  mode: "test" | "live";
  get(path: string, params?: Record<string, string | number | string[]>): Promise<StripeObject>;
  list(path: string, params?: Record<string, string | number | string[]>): Promise<StripeObject[]>;
};

export function keyMode(secretKey: string): "test" | "live" {
  return /^(sk|rk)_live_/.test(secretKey) ? "live" : "test";
}

function query(params: Record<string, string | number | string[]> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const x of v) q.append(`${k}[]`, x);
    else q.append(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function createStripeApi(opts: {
  secretKey: string;
  fetch?: typeof fetch;
  apiVersion?: string;
  base?: string;
}): StripeApi {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.base ?? "https://api.stripe.com";
  const headers = {
    authorization: `Bearer ${opts.secretKey}`,
    "stripe-version": opts.apiVersion ?? STRIPE_API_VERSION,
  };
  async function get(path: string, params?: Record<string, string | number | string[]>) {
    const res = await doFetch(`${base}${path}${query(params)}`, { headers });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new StripeApiError(res.status, body, path);
    return body as StripeObject;
  }
  return {
    mode: keyMode(opts.secretKey),
    get,
    // Every page of a list endpoint (Stripe's cursor pagination, 100 at a time).
    async list(path, params = {}) {
      const out: StripeObject[] = [];
      let after: string | null = null;
      for (let page = 0; page < 1000; page++) {
        const body = await get(path, { ...params, limit: 100, ...(after ? { starting_after: after } : {}) });
        const data = (body.data ?? []) as StripeObject[];
        out.push(...data);
        if (!body.has_more || data.length === 0) return out;
        after = data[data.length - 1].id;
      }
      throw new Error(`Stripe list ${path} did not end after 1000 pages`);
    },
  };
}
