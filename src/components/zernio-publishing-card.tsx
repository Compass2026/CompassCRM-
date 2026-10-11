"use client";

import { useActionState } from "react";
import {
  bindZernioAccountAction,
  setZernioPublishingAction,
  unbindZernioAccountAction,
  verifyZernioAccountsAction,
  type ActionState,
} from "@/app/settings-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Settings › Publisher › Facebook through Zernio (Zernio Social Publisher v1).
// Each client's Facebook Page and its Zernio binding. The key is never shown:
// Verify asks the publisher what the publish key can see. Binding re-reads the
// account and its Page in Zernio and never enables; only an admin switches a
// bound Page on or off, or removes the binding.
export type ZernioPageRow = {
  id: string;
  client: string;
  page_id: string | null;
  page_name: string | null;
  account_id: string | null;
  account_name: string | null;
  enabled: boolean;
  verified_at: string | null;
  health: string | null;
};

function Status({ state }: { state: ActionState }) {
  if (!state) return null;
  return <span className={cn("text-xs", state.ok ? "text-green-800" : "text-red-700")}>{state.message}</span>;
}

function Row({ row, admin }: { row: ZernioPageRow; admin: boolean }) {
  const [bindState, bind, binding] = useActionState<ActionState, FormData>(bindZernioAccountAction, null);
  const [switchState, setSwitch, switching] = useActionState<ActionState, FormData>(setZernioPublishingAction, null);
  const [unbindState, unbind, unbinding] = useActionState<ActionState, FormData>(unbindZernioAccountAction, null);
  return (
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.client}</span>
        <span className="text-xs text-muted-foreground">
          Facebook Page {row.page_name ?? "?"} ({row.page_id ?? "no Page id"})
        </span>
        {row.account_id
          ? <Badge variant="outline" className={row.enabled ? "bg-green-100 text-green-800" : ""}>{row.enabled ? "Publishing on" : "Bound, publishing off"}</Badge>
          : <Badge variant="outline">Not bound</Badge>}
      </div>
      {row.account_id && (
        <p className="text-xs text-muted-foreground">
          Zernio account <span className="font-mono">{row.account_id}</span> ({row.account_name ?? "?"}) · verified{" "}
          {row.verified_at ? new Date(row.verified_at).toLocaleString("en-US", { timeZone: "America/Chicago" }) : "never"} · health {row.health ?? "unknown"}
        </p>
      )}
      {admin && (
        <div className="flex flex-wrap items-start gap-2">
          {row.page_id && (
            <form action={bind} className="flex items-center gap-2">
              <input type="hidden" name="social_account_id" value={row.id} />
              <input
                name="zernio_account_id"
                defaultValue={row.account_id ?? ""}
                placeholder="Zernio account id"
                className="h-8 w-56 rounded-md border px-2 font-mono text-xs"
              />
              <Button type="submit" size="sm" variant="outline" disabled={binding}>{row.account_id ? "Verify again" : "Verify and bind"}</Button>
            </form>
          )}
          {row.account_id && (
            <form
              action={setSwitch}
              onSubmit={(e) => {
                if (!row.enabled && !window.confirm(`Let the publisher post approved Facebook posts to ${row.page_name ?? "this Page"} through Zernio? The publisher switch and pilot list still apply.`)) e.preventDefault();
              }}
            >
              <input type="hidden" name="social_account_id" value={row.id} />
              <input type="hidden" name="expected_account_id" value={row.account_id} />
              <input type="hidden" name="enabled" value={row.enabled ? "false" : "true"} />
              <Button type="submit" size="sm" variant={row.enabled ? "outline" : "default"} disabled={switching}>
                {row.enabled ? "Switch publishing off" : "Switch publishing on"}
              </Button>
            </form>
          )}
          {row.account_id && (
            <form action={unbind} onSubmit={(e) => { if (!window.confirm("Remove this Page's Zernio binding?")) e.preventDefault(); }}>
              <input type="hidden" name="social_account_id" value={row.id} />
              <Button type="submit" size="sm" variant="ghost" disabled={unbinding}>Remove binding</Button>
            </form>
          )}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Status state={bindState} />
        <Status state={switchState} />
        <Status state={unbindState} />
      </div>
    </li>
  );
}

export function ZernioPublishingCard({ rows, admin, keyPresent }: { rows: ZernioPageRow[]; admin: boolean; keyPresent: boolean }) {
  const [verifyState, verify, verifying] = useActionState<ActionState>(verifyZernioAccountsAction, null);
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted-foreground">
          Publish key (ZERNIO_PUBLISH_API_KEY): {keyPresent ? "in Vault" : "not set"}. It is never shown here.
        </span>
        <form action={verify}>
          <Button type="submit" size="sm" variant="outline" disabled={verifying || !keyPresent}>Verify with Zernio</Button>
        </form>
        <Status state={verifyState} />
      </div>
      {rows.length === 0
        ? <p className="text-xs text-muted-foreground">No client has a Facebook Page recorded in Compass.</p>
        : <ul className="space-y-2">{rows.map((r) => <Row key={r.id} row={r} admin={admin} />)}</ul>}
      <p className="text-xs text-muted-foreground">
        A Facebook post goes out through Zernio only when the publisher is on, the client is on the pilot list and its Page is
        bound and switched on here. Otherwise its scheduled time opens a “post this by hand” task, as before.
      </p>
    </div>
  );
}
