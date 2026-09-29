// The Stripe sync layer's only door to the database: supabase-js with the
// service role, so every call reaches Postgres through PostgREST as
// authenticator + service_role, the session 0058's write boundary admits.
// It writes only through the billing sync functions; it never touches a
// mirror table directly (service_role has no direct write grant on them).

import type { OpResult, SyncOp, SyncStore } from "./sync.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

export type LedgerEvent = {
  id: string;
  type: string;
  livemode: boolean;
  api_version: string | null;
  event_created_at: string;
  object_type: string | null;
  object_id: string | null;
};
export type Claim = { claimed: true; attempt: number } | { claimed: false; state: "done" | "in_progress"; status?: string };

export type StripeStore = SyncStore & {
  beginEvent(e: LedgerEvent, leaseSeconds?: number): Promise<Claim>;
  finishEvent(id: string, attempt: number, status: "processed" | "ignored", reason?: string | null): Promise<{ ok: boolean }>;
  failEvent(id: string, attempt: number, error: string): Promise<{ ok: boolean }>;
  secret(name: string): Promise<string | null>;
  billingLivemode(): Promise<boolean>;
};

export function createStripeStore(client: Client): StripeStore {
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data as T;
  }
  return {
    apply: (ops: SyncOp[]) => rpc<OpResult[]>("billing_sync_apply", { p: { ops } }),
    linkCustomer: (p) => rpc("billing_link_customer", { p }),
    beginEvent: (e, leaseSeconds = 300) => rpc<Claim>("billing_event_begin", { p: e, p_lease_seconds: leaseSeconds }),
    finishEvent: (id, attempt, status, reason = null) =>
      rpc("billing_event_finish", { p_id: id, p_attempt: attempt, p_status: status, p_reason: reason }),
    failEvent: (id, attempt, error) => rpc("billing_event_fail", { p_id: id, p_attempt: attempt, p_error: error }),
    secret: (name) => rpc<string | null>("get_secret", { secret_name: name }),
    billingLivemode: () => rpc<boolean>("billing_livemode", {}),
  };
}
