"use client";

import { useState, useTransition } from "react";
import {
  linkStripeCustomerAction,
  searchStripeCustomersAction,
  type CustomerSearchResult,
} from "@/app/billing-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const blocking = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

function created(secs: number | null) {
  return secs ? new Date(secs * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}

// Find a customer that already exists in Stripe and link it to this client.
// Search is by name, email or cus_ id; nothing is linked on a match alone:
// the admin reads the result, ticks the confirmation and presses Link. The
// function refuses a customer already linked to another client, a second
// customer for this client, the wrong mode, and a customer whose metadata
// names another client.
export function CustomerLinkSearch({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [query, setQuery] = useState("");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ livemode: boolean; customers: CustomerSearchResult[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await searchStripeCustomersAction(clientId, query);
            if (r.ok) {
              setResult({ livemode: r.livemode, customers: r.customers });
              setError(null);
            } else {
              setResult(null);
              setError(r.text);
            }
          });
        }}
      >
        <Input
          aria-label="Search Stripe customers"
          placeholder="Name, email or cus_…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Searching…" : "Search Stripe"}
        </Button>
      </form>
      {error && <p className="text-sm text-red-800">{error}</p>}
      {result && result.customers.length === 0 && (
        <p className="text-sm text-muted-foreground">No Stripe customer matches in {result.livemode ? "live" : "test"} mode.</p>
      )}
      {result && result.customers.length > 0 && (
        <ul className="space-y-2">
          {result.customers.map((c) => {
            const elsewhere = c.linked_client && c.linked_client.id !== clientId;
            const here = c.linked_client && c.linked_client.id === clientId;
            const claimed = c.compass_client_id && c.compass_client_id !== clientId;
            const disabled = c.deleted || !c.mode_matches || !!elsewhere || !!here || !!claimed;
            const billing = c.subscriptions.filter((s) => blocking.has(s.status));
            return (
              <li key={c.id} className="rounded-md border p-3 text-sm space-y-2" data-customer={c.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{c.name ?? "(no name)"}</span>
                  <span className="font-mono text-xs text-muted-foreground">{c.id}</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Email</dt>
                  <dd>{c.email ?? "—"}</dd>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{created(c.created)}</dd>
                  <dt className="text-muted-foreground">Mode</dt>
                  <dd>{c.livemode ? "Live" : "Test"}</dd>
                  <dt className="text-muted-foreground">Subscriptions</dt>
                  <dd>
                    {c.subscriptions.length === 0
                      ? "None"
                      : c.subscriptions.map((s) => s.status).join(", ")}
                    {billing.length > 0 ? " — will be imported, and blocks a new payment link" : ""}
                  </dd>
                </dl>
                {c.deleted && <p className="text-xs text-red-800">Deleted in Stripe.</p>}
                {!c.mode_matches && <p className="text-xs text-red-800">Not in the current billing mode.</p>}
                {elsewhere && <p className="text-xs text-red-800">Already linked to {c.linked_client!.name}.</p>}
                {here && <p className="text-xs text-muted-foreground">Already linked to this client.</p>}
                {claimed && <p className="text-xs text-red-800">Its Stripe metadata names another Compass client.</p>}
                {!disabled && (
                  <form action={linkStripeCustomerAction.bind(null, clientId)} className="flex flex-wrap items-center gap-3">
                    <input type="hidden" name="customer_id" value={c.id} />
                    <label className="flex items-center gap-2 text-xs">
                      <input type="checkbox" name="confirm" required />
                      This is {clientName}&apos;s Stripe customer
                    </label>
                    <Button type="submit" size="sm">Link customer</Button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
