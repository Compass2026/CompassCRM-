"use client";

import { useActionState, useState } from "react";
import {
  listGbpLocationsAction,
  selectGbpLocationAction,
  type ActionState,
  type GbpCandidate,
  type GbpListState,
} from "@/app/settings-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Business Profile location per client: list what the connected account
// manages (read-only), a person picks and confirms the client's own profile,
// Google re-verifies it, and it is stored on the client only if the client
// has none. Hints (phone / website / exact name) help the reading; they never
// pick anything.

type ClientOpt = { id: string; name: string; gbp_location: string | null };

function Hint({ on, label }: { on: boolean; label: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px]", on ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "text-muted-foreground")}
    >
      {on ? "✓" : "✗"} {label}
    </Badge>
  );
}

function Candidate({ c, clientId, clientName, disabled }: { c: GbpCandidate; clientId: string; clientName: string; disabled: boolean }) {
  const [state, select, saving] = useActionState<ActionState, FormData>(selectGbpLocationAction, null);
  return (
    <li className="rounded border p-2 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">{c.title || "(no name)"}</span>
        {c.hints && (
          <>
            <Hint on={c.hints.phone} label="phone" />
            <Hint on={c.hints.website} label="website" />
            <Hint on={c.hints.exact_name} label="exact name" />
          </>
        )}
        {c.has_voice_of_merchant === false && (
          <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-800 border-amber-200">not verified: cannot post</Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {[c.phone, c.website, c.address, c.service_area && `serves ${c.service_area}`].filter(Boolean).join(" · ") || "No phone, website or address on the profile"}
      </p>
      <p className="text-[11px] text-muted-foreground break-all">
        {c.resource}
        {c.account_name ? ` · account “${c.account_name}”` : ""}
        {c.maps_uri && (
          <>
            {" · "}
            <a href={c.maps_uri} target="_blank" rel="noreferrer" className="underline">Open in Maps</a>
          </>
        )}
      </p>
      {!disabled && (
        <form action={select} className="flex items-center gap-2 flex-wrap">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="location" value={c.resource} />
          <input type="hidden" name="title" value={c.title} />
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" name="confirm" required />
            This is {clientName}&apos;s own profile
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={saving}>
            {saving ? "Verifying…" : `Use for ${clientName}`}
          </Button>
          {state && <span className={cn("text-xs", state.ok ? "text-emerald-700" : "text-destructive")}>{state.message}</span>}
        </form>
      )}
    </li>
  );
}

export function GbpLocationPicker({ clients, tokenPresent }: { clients: ClientOpt[]; tokenPresent: boolean }) {
  const [clientId, setClientId] = useState("");
  const [listState, list, listing] = useActionState<GbpListState, FormData>(listGbpLocationsAction, null);
  const client = clients.find((c) => c.id === clientId);
  const shown = listState?.ok && listState.clientId === clientId ? listState : null;
  const withLocation = clients.filter((c) => c.gbp_location);

  return (
    <div className="space-y-2">
      {withLocation.length > 0 && (
        <ul className="text-xs space-y-0.5">
          {withLocation.map((c) => (
            <li key={c.id}>
              {c.name} → <code className="text-[11px] break-all">{c.gbp_location}</code>
            </li>
          ))}
        </ul>
      )}
      <form action={list} className="flex items-center gap-2 flex-wrap">
        <select
          name="client_id"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Choose a client…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.gbp_location ? " (location set)" : ""}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline" size="sm" disabled={listing || !tokenPresent || !clientId}>
          {listing ? "Listing…" : "List Business Profile locations"}
        </Button>
        {listState && !listState.ok && <span className="text-xs text-destructive">{listState.message}</span>}
      </form>
      {client?.gbp_location && (
        <p className="text-xs text-muted-foreground">
          {client.name} already has a location. It is never replaced from here; the list below is for checking only.
        </p>
      )}
      {shown && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {shown.candidates?.length ?? 0} location{shown.candidates?.length === 1 ? "" : "s"} the connected account manages.
            {shown.complete ? "" : " The listing is incomplete; a missing profile may still exist."}
            {shown.message ? ` ${shown.message}` : ""}
          </p>
          {shown.errors && shown.errors.length > 0 && <p className="text-xs text-destructive">{shown.errors.join(" · ")}</p>}
          <ul className="space-y-1">
            {(shown.candidates ?? []).map((c) => (
              <Candidate key={c.resource} c={c} clientId={clientId} clientName={client?.name ?? "this client"} disabled={!!client?.gbp_location} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
