"use client";

import { useActionState } from "react";
import {
  bindZernioGbpAction,
  setGbpTransportAction,
  setZernioPublishingAction,
  unbindZernioAccountAction,
  verifyZernioGbpAction,
  type ActionState,
  type GbpAccountsState,
} from "@/app/settings-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Settings › Publisher › Business Profile through Zernio. One row per bound
// Business Profile location of each piloted client (a client may have
// several; each post names its own), plus a row to bind another location. Verify asks the publisher what the publish key sees
// (accounts and their locations; the key is never shown). Binding names one
// client and one location, is re-read in Zernio first and never enables; only
// an admin switches a bound location on or off, or removes the binding.
export type ZernioGbpRow = {
  client_id: string;
  client: string;
  social_account_id: string | null;
  location_id: string | null;
  location_name: string | null;
  account_id: string | null;
  account_name: string | null;
  enabled: boolean;
  verified_at: string | null;
  health: string | null;
  // The client's explicit Business Profile transport.
  transport: "google" | "zernio";
  // The row that binds an additional location for a client that has one.
  another?: boolean;
};

function Status({ state }: { state: ActionState }) {
  if (!state) return null;
  return <span className={cn("text-xs", state.ok ? "text-green-800" : "text-red-700")}>{state.message}</span>;
}

function Row({ row, admin }: { row: ZernioGbpRow; admin: boolean }) {
  const [bindState, bind, binding] = useActionState<ActionState, FormData>(bindZernioGbpAction, null);
  const [switchState, setSwitch, switching] = useActionState<ActionState, FormData>(setZernioPublishingAction, null);
  const [unbindState, unbind, unbinding] = useActionState<ActionState, FormData>(unbindZernioAccountAction, null);
  const [transportState, setTransport, settingTransport] = useActionState<ActionState, FormData>(setGbpTransportAction, null);
  return (
    <li className="space-y-2 rounded-md border p-3" data-gbp-row={row.client_id} data-gbp-location={row.location_id ?? (row.another ? "another" : "")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.client}</span>
        {row.location_id
          ? <span className="text-xs text-muted-foreground">Location {row.location_name ?? "?"} (<span className="font-mono">{row.location_id}</span>)</span>
          : <span className="text-xs text-muted-foreground">{row.another ? "Bind another Business Profile location for this client." : "No Business Profile location bound."}</span>}
        <Badge variant="outline" data-gbp-transport>{row.transport === "zernio" ? "Through Zernio only" : "Direct to Google"}</Badge>
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
          <form action={bind} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="client_id" value={row.client_id} />
            <input name="zernio_account_id" defaultValue={row.account_id ?? ""} placeholder="Zernio account id" aria-label="Zernio account id"
              className="h-8 w-56 rounded-md border px-2 font-mono text-xs" />
            <input name="location_id" defaultValue={row.location_id ?? ""} placeholder="Location id" aria-label="Location id"
              className="h-8 w-56 rounded-md border px-2 font-mono text-xs" />
            <Button type="submit" size="sm" variant="outline" disabled={binding}>{row.account_id ? "Verify again" : "Verify and bind"}</Button>
          </form>
          {row.account_id && row.social_account_id && (
            <form
              action={setSwitch}
              onSubmit={(e) => {
                if (!row.enabled && !window.confirm(`Let the publisher post approved Business Profile posts to ${row.location_name ?? "this location"} through Zernio? The publisher switch and pilot list still apply.`)) e.preventDefault();
              }}
            >
              <input type="hidden" name="social_account_id" value={row.social_account_id} />
              <input type="hidden" name="expected_account_id" value={row.account_id} />
              <input type="hidden" name="enabled" value={row.enabled ? "false" : "true"} />
              <input type="hidden" name="kind" value="gbp" />
              <Button type="submit" size="sm" variant={row.enabled ? "outline" : "default"} disabled={switching}>
                {row.enabled ? "Switch publishing off" : "Switch publishing on"}
              </Button>
            </form>
          )}
          {!row.account_id && row.transport === "zernio" && (
            <form
              action={setTransport}
              onSubmit={(e) => {
                if (!window.confirm(`Return ${row.client}'s Business Profile posts to the direct Google path? Posts approved naming a Zernio location still never go to Google.`)) e.preventDefault();
              }}
            >
              <input type="hidden" name="client_id" value={row.client_id} />
              <input type="hidden" name="transport" value="google" />
              <Button type="submit" size="sm" variant="ghost" disabled={settingTransport}>Return to direct Google</Button>
            </form>
          )}
          {row.account_id && row.social_account_id && (
            <form action={unbind} onSubmit={(e) => { if (!window.confirm("Remove this location's Zernio binding? The client stays on Zernio: its Business Profile posts stop until a location is bound again, and only an admin can return it to the direct Google path.")) e.preventDefault(); }}>
              <input type="hidden" name="social_account_id" value={row.social_account_id} />
              <Button type="submit" size="sm" variant="ghost" disabled={unbinding}>Remove binding</Button>
            </form>
          )}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Status state={bindState} />
        <Status state={switchState} />
        <Status state={unbindState} />
        <Status state={transportState} />
      </div>
    </li>
  );
}

function Seen({ state }: { state: GbpAccountsState }) {
  if (!state) return null;
  if (!state.ok) return <p role="alert" className="text-xs text-red-700">{state.message}</p>;
  return (
    <div className="space-y-2 text-xs" data-gbp-seen>
      <p className="text-green-800">{state.message}</p>
      {(state.accounts ?? []).map((a) => (
        <div key={a.zernio_account_id} className="rounded-md border p-2">
          <p>
            <span className="font-medium">{a.name ?? "?"}</span> · Zernio account <span className="font-mono">{a.zernio_account_id}</span> ·{" "}
            {a.active ? "active" : "inactive or needs reconnecting"} · health {a.health.status}
          </p>
          {a.read !== "ok" && <p className="text-red-700">Locations could not be read: {a.read}</p>}
          <ul className="mt-1 space-y-0.5">
            {a.locations.map((l) => (
              <li key={l.location_id ?? l.name ?? "?"}>
                <span className="font-mono">{l.location_id}</span> {l.name ?? ""}{l.address ? ` · ${l.address}` : ""}{l.website ? ` · ${l.website}` : ""}
                {l.location_id === a.selected_location_id ? " · the account's default" : ""}
              </li>
            ))}
          </ul>
          {a.has_more && <p className="text-amber-800">The account has more locations than were listed.</p>}
        </div>
      ))}
      {(state.matches ?? []).filter((m) => m.website_matches.length).map((m) => (
        <p key={m.client_id} className="text-muted-foreground">
          Same website as {m.name}: {m.website_matches.map((w) => `${w.name ?? "?"} (${w.location_id})`).join(", ")}. A hint only; binding is your explicit choice.
        </p>
      ))}
    </div>
  );
}

export function ZernioGbpCard({ rows, admin, keyPresent }: { rows: ZernioGbpRow[]; admin: boolean; keyPresent: boolean }) {
  const [seen, verify, verifying] = useActionState<GbpAccountsState>(verifyZernioGbpAction, null);
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted-foreground">
          Publish key (ZERNIO_PUBLISH_API_KEY): {keyPresent ? "in Vault" : "not set"}. It is never shown here.
        </span>
        <form action={verify}>
          <Button type="submit" size="sm" variant="outline" disabled={verifying || !keyPresent}>Verify Business Profile locations</Button>
        </form>
      </div>
      <Seen state={seen} />
      {rows.length === 0
        ? <p className="text-xs text-muted-foreground">No client is on the pilot list or has a Business Profile location bound.</p>
        : <ul className="space-y-2">{rows.map((r) => <Row key={`${r.client_id}:${r.location_id ?? "new"}`} row={r} admin={admin} />)}</ul>}
      <p className="text-xs text-muted-foreground">
        Binding a location moves the client to Zernio: its Business Profile posts go through Zernio only, pinned to that
        location, never directly to Google, and only when the publisher is on, the client is piloted and the location is
        switched on here. Removing the binding keeps the client on Zernio (posts stop); only an admin returns it to the
        direct Google path. Posts approved before the location was bound must be reopened, saved and approved again so the
        approval names it. Clients never moved keep the direct Google path.
      </p>
    </div>
  );
}
