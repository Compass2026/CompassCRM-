"use client";

import { useActionState } from "react";
import {
  connectGoogleAction,
  listGa4AccountsAction,
  saveGa4AccountAction,
  checkGoogleAccessAction,
  type ActionState,
  type Ga4AccountsState,
  type AccessCheck,
} from "@/app/settings-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// The "Google hands" card on Settings: connect the Compass Workspace account
// (mints GOOGLE_OPS_REFRESH_TOKEN), pick the Analytics account new properties
// go under (GA4_ACCOUNT_ID), and see which clients' Business Profile / Search
// Console / GA4 the account can already reach.

export type GoogleOpsSetting = {
  email: string | null;
  scopes: string[];
  missing_scopes: string[];
  connected_at: string;
} | null;

export type Ga4Setting = { id: string; name: string | null; set_at: string } | null;

type Props = {
  tokenPresent: boolean;
  ga4Present: boolean;
  ops: GoogleOpsSetting;
  ga4: Ga4Setting;
  access: AccessCheck | null;
  redirectUri: string;
  flash: { google?: string; reason?: string };
};

function Status({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <span className={cn("text-xs", state.ok ? "text-muted-foreground" : "text-destructive")}>{state.message}</span>
  );
}

function Mark({ v }: { v: string }) {
  const tone =
    v === "yes" ? "bg-emerald-100 text-emerald-800 border-emerald-200" :
    v === "no" ? "bg-amber-50 text-amber-800 border-amber-200" :
    "text-muted-foreground";
  return <Badge variant="outline" className={cn("text-[10px]", tone)}>{v}</Badge>;
}

export function GoogleConnectCard({ tokenPresent, ga4Present, ops, ga4, access, redirectUri, flash }: Props) {
  const [connectState, connect, connecting] = useActionState<ActionState, FormData>(async () => connectGoogleAction(), null);
  const [listState, list, listing] = useActionState<Ga4AccountsState, FormData>(listGa4AccountsAction, null);
  const [saveState, save, saving] = useActionState<ActionState, FormData>(saveGa4AccountAction, null);
  const [checkState, check, checking] = useActionState<ActionState, FormData>(checkGoogleAccessAction, null);

  const banner =
    flash.google === "connected" ? { ok: true, text: "Google connected. This stores the credential only: the worker writes to Google only if Worker Google operations is switched on below, and Business Profile posts only through the Publisher switch." } :
    flash.google === "partial" ? { ok: false, text: `Connected, but some permissions were not granted (${flash.reason ?? "unknown"}). Press Connect Google again and tick every box.` } :
    flash.google === "error" ? { ok: false, text: `Google connection failed: ${flash.reason ?? "unknown error"}.` } :
    null;

  return (
    <div className="space-y-4 text-sm">
      {banner && (
        <div className={cn("callout text-xs", banner.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-destructive/40 bg-destructive/5 text-destructive")}>
          {banner.text}
        </div>
      )}

      {/* ── 1. Account ─────────────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">1. Compass Google account</span>
          {tokenPresent ? (
            <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200 text-[10px]">connected</Badge>
          ) : (
            <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200 text-[10px]">not connected</Badge>
          )}
        </div>
        {tokenPresent && ops && (
          <p className="text-xs text-muted-foreground">
            {ops.email ?? "Account email not recorded"} · connected {new Date(ops.connected_at).toLocaleDateString()}
            {ops.missing_scopes?.length ? ` · missing: ${ops.missing_scopes.map((s) => s.split("/").pop()).join(", ")}` : " · Business Profile, Analytics, Gmail drafts"}
          </p>
        )}
        {tokenPresent && !ops && (
          <p className="text-xs text-muted-foreground">Token present in Vault (set by hand); connect here to record the account.</p>
        )}
        <form action={connect} className="flex items-center gap-2 flex-wrap">
          <Button type="submit" size="sm" disabled={connecting}>
            {connecting ? "Opening Google…" : tokenPresent ? "Reconnect Google" : "Connect Google"}
          </Button>
          <Status state={connectState} />
        </form>
        <p className="text-xs text-muted-foreground">
          Sign in as the Compass Workspace account and allow Business Profile, Analytics and Gmail (drafts only). The
          token is stored in Vault; it never appears here. The OAuth app must list this redirect URI:
        </p>
        <code className="block rounded bg-muted px-2 py-1 text-[11px] break-all">{redirectUri}</code>
      </section>

      {/* ── 2. Analytics account ────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">2. Analytics account for new properties</span>
          {ga4Present ? (
            <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200 text-[10px]">set</Badge>
          ) : (
            <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200 text-[10px]">not set</Badge>
          )}
        </div>
        {ga4 && (
          <p className="text-xs text-muted-foreground">
            {ga4.name ? `${ga4.name} (${ga4.id})` : ga4.id}
          </p>
        )}
        <form action={list} className="flex items-center gap-2 flex-wrap">
          <Button type="submit" variant="outline" size="sm" disabled={listing || !tokenPresent}>
            {listing ? "Loading…" : "List accounts the connected user can see"}
          </Button>
          {listState && !listState.ok && <span className="text-xs text-destructive">{listState.message}</span>}
          {listState?.ok && listState.message && <span className="text-xs text-muted-foreground">{listState.message}</span>}
        </form>
        {listState?.accounts && listState.accounts.length > 0 && (
          <div className="space-y-1">
            {listState.accounts.map((a) => (
              <form key={a.id} action={save} className="flex items-center gap-2">
                <input type="hidden" name="id" value={a.id} />
                <input type="hidden" name="name" value={a.name} />
                <span className="flex-1 truncate">{a.name} <span className="text-muted-foreground">· {a.id} · {a.properties} propert{a.properties === 1 ? "y" : "ies"}</span></span>
                <Button type="submit" size="sm" variant={ga4?.id === a.id ? "secondary" : "outline"} disabled={saving}>
                  {ga4?.id === a.id ? "current" : "Use"}
                </Button>
              </form>
            ))}
          </div>
        )}
        <form action={save} className="flex items-center gap-2 flex-wrap">
          <Input name="id" placeholder="or type the numeric account id" className="max-w-xs" defaultValue={ga4?.id ?? ""} inputMode="numeric" />
          <Button type="submit" variant="outline" size="sm" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          <Status state={saveState} />
        </form>
      </section>

      {/* ── 3. Per-client access ─────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">3. What the account can reach per client</span>
          {access && <span className="text-xs text-muted-foreground">checked {new Date(access.checked_at).toLocaleString()}</span>}
        </div>
        <form action={check} className="flex items-center gap-2 flex-wrap">
          <Button type="submit" variant="outline" size="sm" disabled={checking || !tokenPresent}>
            {checking ? "Checking…" : "Check access"}
          </Button>
          <Status state={checkState} />
        </form>
        {access && (access.gbp_error || access.gsc_error) && (
          <p className="text-xs text-destructive">{[access.gbp_error, access.gsc_error].filter(Boolean).join(" · ")}</p>
        )}
        {access && (
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="py-1 font-normal">Client</th>
                <th className="py-1 font-normal">Business Profile</th>
                <th className="py-1 font-normal">Search Console</th>
                <th className="py-1 font-normal">GA4</th>
              </tr>
            </thead>
            <tbody>
              {access.clients.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-1">{r.name}</td>
                  <td className="py-1"><Mark v={r.gbp} />{r.gbp_title && <span className="ml-1 text-muted-foreground">{r.gbp_title}</span>}</td>
                  <td className="py-1"><Mark v={r.gsc} /></td>
                  <td className="py-1"><Mark v={r.ga4} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-muted-foreground">
          A client marked <em>no</em> under Business Profile needs the one grant on its Foundation checklist: add the
          Compass account as a manager on their profile (and an owner on Search Console). Then set the client&apos;s GBP
          Setup and Tracking Setup stages to <em>Not started</em> so the worker applies what it already drafted (only
          with Worker Google operations switched on; otherwise those steps stay on your list).
        </p>
      </section>
    </div>
  );
}
