// Minimal Stripe REST client for the billing sync (B2). No SDK: every call is
// a plain fetch with a pinned API version, so the sync layer runs unchanged
// in Deno (Edge Functions) and Node (tests with a fake fetch), and the object
// shapes the mappers read are fixed by STRIPE_API_VERSION rather than by the
// account's default.
//
// The sync layer only ever reads (get / list / search): Stripe wins, and
// Compass never changes Stripe because Compass disagrees with it. The B3
// command handler (stripe-billing) is the only caller of `post`, for the
// objects an admin asks for (a customer, a client price, a Checkout or
// Customer Portal session, the portal configuration), always with an
// idempotency key on anything that creates something.

export const STRIPE_API_VERSION = "2025-03-31.basil";

// deno-lint-ignore no-explicit-any
export type StripeObject = Record<string, any>;

export class StripeApiError extends Error {
  status: number;
  code: string | null;
  type: string | null;
  param: string | null;
  constructor(status: number, body: StripeObject | null, path: string) {
    const err = body?.error ?? {};
    super(`Stripe ${status} on ${path}: ${err.message ?? "no message"}`);
    this.status = status;
    this.code = err.code ?? null;
    this.type = err.type ?? null;
    this.param = err.param ?? null;
  }
  // The object does not exist (never did, or was deleted and is no longer retrievable).
  get missing(): boolean {
    return this.status === 404 || this.code === "resource_missing";
  }
}

export type Params = Record<string, string | number | string[]>;
// deno-lint-ignore no-explicit-any
export type FormParams = Record<string, any>;

export type StripeApi = {
  mode: "test" | "live";
  get(path: string, params?: Params): Promise<StripeObject>;
  list(path: string, params?: Params): Promise<StripeObject[]>;
  // Search endpoints (/v1/customers/search): one page, Stripe's query syntax.
  search(path: string, query: string, opts?: { limit?: number; expand?: string[] }): Promise<StripeObject[]>;
  post(path: string, params?: FormParams, opts?: { idempotencyKey?: string }): Promise<StripeObject>;
};

// Stripe's form encoding: nested objects as a[b][c], arrays as a[0], a[1].
export function formEncode(params: FormParams): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, x);
    else out.append(prefix, String(v));
  };
  walk("", params);
  return out.toString();
}

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

// Transient Stripe answers are retried a bounded number of times: 429 (rate
// limited), 5xx, a 409 Stripe marks retryable, and network errors. Reads are
// always safe to retry; a create only when it carries an idempotency key.
// Stripe's Retry-After (seconds) is honoured, capped; otherwise exponential
// backoff with jitter. `Stripe-Should-Retry: false` is never retried.
export type RetryOptions = { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void> };

export function retryDelayMs(attempt: number, retryAfter: string | null, o: RetryOptions = {}): number {
  const max = o.maxDelayMs ?? 10_000;
  const secs = retryAfter != null ? Number(retryAfter) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, max);
  const base = (o.baseDelayMs ?? 500) * 2 ** attempt;
  return Math.min(base + Math.floor(Math.random() * base * 0.25), max);
}

export function createStripeApi(opts: {
  secretKey: string;
  fetch?: typeof fetch;
  apiVersion?: string;
  base?: string;
  retry?: RetryOptions;
}): StripeApi {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.base ?? "https://api.stripe.com";
  const retry = opts.retry ?? {};
  const maxRetries = retry.maxRetries ?? 2;
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const headers = {
    authorization: `Bearer ${opts.secretKey}`,
    "stripe-version": opts.apiVersion ?? STRIPE_API_VERSION,
  };
  async function send(path: string, url: string, init: RequestInit, retryable: boolean): Promise<StripeObject> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, init);
      } catch (e) {
        if (retryable && attempt < maxRetries) {
          await sleep(retryDelayMs(attempt, null, retry));
          continue;
        }
        throw e;
      }
      const body = await res.json().catch(() => null);
      if (res.ok) return body as StripeObject;
      const should = res.headers?.get?.("stripe-should-retry") ?? null;
      const transient = res.status === 429 || res.status >= 500 || should === "true";
      if (retryable && transient && should !== "false" && attempt < maxRetries) {
        await sleep(retryDelayMs(attempt, res.headers?.get?.("retry-after") ?? null, retry));
        continue;
      }
      throw new StripeApiError(res.status, body, path);
    }
  }
  function get(path: string, params?: Params) {
    return send(path, `${base}${path}${query(params)}`, { headers }, true);
  }
  return {
    mode: keyMode(opts.secretKey),
    get,
    async search(path, q, o = {}) {
      const body = await get(path, { query: q, limit: o.limit ?? 10, ...(o.expand ? { expand: o.expand } : {}) });
      return (body.data ?? []) as StripeObject[];
    },
    post(path, params = {}, o = {}) {
      return send(path, `${base}${path}`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/x-www-form-urlencoded",
          ...(o.idempotencyKey ? { "idempotency-key": o.idempotencyKey } : {}),
        },
        body: formEncode(params),
      }, !!o.idempotencyKey);
    },
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
