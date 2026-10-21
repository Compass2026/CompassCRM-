// The publisher's Business Profile path through Zernio (Oct 11 2026;
// docs/zernio-publisher.md): the Business Profile channel of the shared
// Zernio path (zernio-path.ts), which owns publishing, idempotency,
// reconciliation and the no-write preflight. This file owns what is the
// Business Profile's:
//
// - the route: a Business Profile post goes to exactly one publisher. When
//   its approved snapshot names a location, or its client has a Zernio
//   location, it is this path's — refused here if anything is missing, never
//   handed to the direct Google path (gbp.ts gbpRoute);
// - the content rules, the binding rules and the request, pinned to the
//   exact location (gbp.ts);
// - no Zernio send while an earlier direct-Google attempt for the post has no
//   settled answer (it may be on the profile already);
// - the read-only verification of the Google Business Profile accounts and
//   locations the publish key sees, and the explicit binding of one client to
//   one location (bind), which re-reads the account, its locations and its
//   health and never enables publishing.

import { summarizeHealth, ZERNIO_ACCOUNT_RE, ZERNIO_PUBLISH_KEY_SECRET, type Binding } from "./facebook.ts";
import {
  buildGbpCreateBody, gbpBindingProblems, gbpImageProblem, gbpProblems, gbpRoute, locationResource, GBP_ZERNIO_PLATFORM,
  type GbpRoute, type GbpSnapshot, type ZernioLocation,
} from "./gbp.ts";
import type { PostRow } from "./store.ts";
import { createZernioPath, type Snap, type ZernioChannel, type ZernioCtx } from "./zernio-path.ts";
import type { ZernioAccount, ZernioGbpLocations, ZernioPublisher } from "./zernio.ts";

const host = (u: string | null | undefined) => {
  try { return u ? new URL(u).hostname.replace(/^www\./, "").toLowerCase() : null; } catch { return null; }
};

export function createGbpPath(ctx: ZernioCtx) {
  const { store, at } = ctx;

  // ── The route, read once per client per run ──
  const clientLocation = new Map<string, Binding | null>();
  const zernioLocationOf = async (clientId: string) => {
    if (!clientLocation.has(clientId)) clientLocation.set(clientId, await store.gbpLocationForClient(clientId));
    return clientLocation.get(clientId)!;
  };
  // The approval names a location only through a Business Profile account (a
  // draft switched from Facebook may still carry its Page; that is not one).
  async function namesLocation(p: PostRow): Promise<boolean> {
    const id = (p.approved_snapshot as { social_account_id?: string | null } | null)?.social_account_id ?? null;
    if (!id) return false;
    const a = await path.accountOf(id);
    return !a || a.platform === "google_business";
  }
  // The client's explicit transport: zernio once a location was bound, kept
  // after the binding is removed, back to google only by a team admin.
  const transports = new Map<string, "google" | "zernio">();
  const transportOf = async (clientId: string) => {
    if (!transports.has(clientId)) transports.set(clientId, await store.gbpTransportForClient(clientId));
    return transports.get(clientId)!;
  };
  async function route(p: PostRow): Promise<GbpRoute> {
    if (await namesLocation(p)) return "zernio";
    return gbpRoute(null, (await transportOf(p.client_id)) === "zernio" || !!(await zernioLocationOf(p.client_id)));
  }

  // An earlier direct-Google attempt still without a settled answer.
  async function priorExecution(p: PostRow): Promise<string | null> {
    const google = (await store.postRuns(p.id)).filter((r) => r.transport === "google"
      && ["published", "reconciled", "uncertain", "ambiguous", "failed"].includes(r.outcome));
    const last = google.at(-1);
    if (last && (last.outcome === "uncertain" || last.outcome === "ambiguous")) {
      return "An earlier attempt to publish this post directly to Google has no settled answer; it may already be on the profile. A person checks the profile before it is sent through Zernio.";
    }
    return null;
  }

  async function locationsOf(z: ZernioPublisher, accountId: string) {
    const r = await z.gbpLocations(accountId);
    const j = (r.json ?? {}) as ZernioGbpLocations;
    const locations = r.ok ? (j.locations ?? []).map((l: ZernioLocation) => ({
      location_id: locationResource(l.id), name: l.name ?? null, address: l.address ?? null, website: l.websiteUrl ?? null,
      google_account: l.accountId ?? null, google_account_name: l.accountName ?? null, store_code: l.storeCode ?? null,
    })) : [];
    return { read: r.ok ? "ok" : r.message, locations, selected_location_id: r.ok ? locationResource(j.selectedLocationId ?? null) : null, has_more: r.ok ? j.hasMore === true : null };
  }

  async function verifyAccount(z: ZernioPublisher, a: ZernioAccount) {
    const locs = await locationsOf(z, a._id);
    const health = await z.health(a._id);
    return {
      zernio_account_id: a._id,
      name: a.displayName ?? a.username ?? null,
      active: a.isActive !== false && a.enabled !== false && a.needsReconnection !== true,
      ...locs,
      health: health.ok ? summarizeHealth(health.json, at) : { status: "unreadable", detail: health.message, checked_at: at.toISOString() },
    };
  }
  const healthy = (h: { status: string; postingGranted?: boolean | null; tokenValid?: boolean | null }) =>
    h.status !== "error" && h.status !== "unreadable" && h.postingGranted !== false && h.tokenValid !== false;

  const channel: ZernioChannel = {
    platform: "google_business",
    label: "Business Profile",
    texts: {
      fixTitle: "Fix a Business Profile post before it can publish",
      failedTitle: "A Business Profile post failed to publish",
      checkTitle: "Check the Business Profile before this post is sent again",
      checkNotes: (detail, link, id) =>
        `${detail} The publisher will not re-send it or record it on its own. Look at the client's Business Profile and at the post in Zernio. If it is on the profile, leave the post as it is and note the link here; if it is not, schedule it again or press Publish now on ${link} (the publisher reads Zernio again first). post_id=${id}`,
      connectTitle: "Connect Zernio publishing for the Business Profile",
      connectNotes: (why) => `${why} Business Profile posts stay scheduled and publish on the next run after it is fixed (Settings → Publisher). They are never sent directly to Google instead.`,
      reconnectTitle: "Reconnect the client's Business Profile in Zernio",
      reconnectNotes: (why) => `${why} Reconnect the Google Business Profile in Zernio, then verify the location again in Settings → Publisher. Business Profile posts that failed can be scheduled again afterwards.`,
      publishedOn: "published on the Business Profile",
      waiting: "waiting for Google's result.",
      noEntry: (id) => `Zernio's post ${id} has no Business Profile entry for the bound account and location.`,
      earlierNoEntry: (id) => `Zernio's earlier post ${id} has no entry for this location.`,
      duplicateOther: (id) => `Zernio refused the post as a duplicate of ${id}, which is not this exact post on this location.`,
    },
    problems: (s) => gbpProblems(s as GbpSnapshot),
    bindingProblems: gbpBindingProblems,
    target: (b) => ({ accountId: b.publish_account_id!, locationId: b.publish_page_id }),
    match: (t) => ({ platform: GBP_ZERNIO_PLATFORM, locationId: t.locationId, label: "Business Profile" }),
    body: (s, b, url) => buildGbpCreateBody(s as GbpSnapshot, b, url),
    imageProblem: (bytes, type) => gbpImageProblem(bytes, type),
    publishing: () => store.publishingGbpPosts(),
    failed: () => store.failedGbpPosts(),
    owns: async (p) => (await route(p)) === "zernio",
    priorExecution,
    targetView: (b) => ({
      social_account_id: b.id, client_id: b.client_id, location_id: b.publish_page_id, location_name: b.display_name,
      zernio_account_id: b.publish_account_id, zernio_account_name: b.publish_account_name, zernio_platform: GBP_ZERNIO_PLATFORM,
    }),
    async live(z, binding, check) {
      const listed = await z.gbpAccounts();
      const a = listed.accounts.find((x) => x._id === binding.publish_account_id);
      if (!listed.answer.ok) { check("Zernio account listed", false, listed.answer.message); return null; }
      if (!a) { check("Zernio account listed", false, "the publish key does not see the bound account as a Google Business Profile account"); return null; }
      const v = await verifyAccount(z, a);
      check("Zernio account listed and active", v.active);
      const loc = v.locations.find((l) => l.location_id === binding.publish_page_id);
      check("the bound location is one the account manages", !!loc,
        v.read !== "ok" ? v.read : loc ? `${loc.name ?? ""} ${loc.address ?? ""}`.trim() : `not among ${v.locations.length} location(s)${v.has_more ? " (list truncated)" : ""}`);
      check("Zernio posts to exactly this location (pinned by locationId)", binding.publish_page_id === binding.external_account_id,
        `pinned ${binding.publish_page_id}; account default ${v.selected_location_id ?? "(none)"}`);
      const h = v.health as { status: string; postingGranted?: boolean | null; tokenValid?: boolean | null };
      check("Zernio account healthy with posting permission", healthy(h), `health ${h.status}`);
      return v;
    },
    fixture: (f, { assets, creative }) => ({
      platform: "google_business", social_account_id: f.social_account_id, post_type: f.post_type ?? "standard", copy: f.copy,
      cta_type: f.cta_type ?? null, cta_url: f.cta_url ?? null, offer: null, assets, ...(creative.length ? { creative } : {}),
    }) as Snap,
  };

  const path = createZernioPath(ctx, channel);

  // ── Read-only: the Business Profile accounts and locations the publish key
  // sees, beside the clients that could be bound. Evidence only: binding is a
  // separate, explicit call naming one client and one location. ──
  const boundOf = (l: Binding) => ({
    social_account_id: l.id, location_id: l.publish_page_id, location_name: l.display_name,
    zernio_account_id: l.publish_account_id, enabled: l.publish_enabled, verified_at: l.publish_verified_at,
    health: l.publish_health,
  });
  async function accountsReport() {
    const z = await path.ensureZernio();
    if (!z) return { key: { ok: false, detail: path.keyBlock() } };
    const listed = await z.gbpAccounts();
    if (!listed.answer.ok) return { key: { ok: false, detail: listed.answer.message, http_status: listed.answer.status } };
    const zernioAccounts: Awaited<ReturnType<typeof verifyAccount>>[] = [];
    for (const a of listed.accounts) zernioAccounts.push(await verifyAccount(z, a));
    const clients = await store.clientsForGbp(ctx.settings.clients);
    const compass = clients.map((c) => {
      const site = host(c.website_url);
      return {
        client_id: c.id, name: c.name, website: c.website_url, piloted: ctx.settings.clients.includes(c.id),
        bound: c.location ? boundOf(c.location) : null,
        // Every bound location (a client may have several; each post names its own).
        bound_locations: ((c as { locations?: Binding[] }).locations ?? (c.location ? [c.location] : [])).map(boundOf),
        // Same website host only: a hint for the person binding, never a binding.
        website_matches: zernioAccounts.flatMap((a) => a.locations.filter((l) => !!site && host(l.website) === site)
          .map((l) => ({ zernio_account_id: a.zernio_account_id, location_id: l.location_id, name: l.name }))),
      };
    });
    return {
      key: { ok: true, secret: ZERNIO_PUBLISH_KEY_SECRET, distinct_from_read_key: true },
      zernio_accounts: zernioAccounts, compass_clients: compass,
    };
  }

  // Bind one client to one location of the Zernio account named by the
  // caller, after re-reading the account, its locations and its health with
  // the publish key. Never enables.
  async function bind(clientId: string, accountId: string, locationId: string) {
    if (!ZERNIO_ACCOUNT_RE.test(accountId)) return { ok: false, status: 400, error: "Not a Zernio account id." };
    const location = locationResource(locationId);
    if (!location) return { ok: false, status: 400, error: "Not a Business Profile location id (digits or locations/<id>)." };
    const z = await path.ensureZernio();
    if (!z) return { ok: false, status: 424, error: path.keyBlock() };
    const listed = await z.gbpAccounts();
    if (!listed.answer.ok) return { ok: false, status: 424, error: listed.answer.message };
    const a = listed.accounts.find((x) => x._id === accountId);
    if (!a) return { ok: false, status: 409, error: "The publish key cannot see that Zernio account as a Google Business Profile account." };
    const v = await verifyAccount(z, a);
    const loc = v.locations.find((l) => l.location_id === location);
    const refuse: string[] = [];
    if (!v.active) refuse.push("The Zernio account is not active or needs reconnecting.");
    if (v.read !== "ok") refuse.push(`Could not read the account's locations: ${v.read}`);
    else if (!loc) refuse.push(`Location ${location} is not among the account's locations${v.has_more ? " (the list was truncated)" : ""}.`);
    const h = v.health as { status: string; postingGranted?: boolean | null; tokenValid?: boolean | null };
    if (!healthy(h)) refuse.push(`Zernio health: ${h.status}, posting permission ${h.postingGranted}, token ${h.tokenValid}.`);
    if (refuse.length) return { ok: false, status: 409, error: refuse.join(" "), verified: v };
    try {
      const result = await store.bindGbpLocation({
        client_id: clientId, account_id: accountId, location_id: location, location_name: loc!.name, account_name: v.name, health: v.health,
      });
      return { ok: true, status: 200, result, verified: { ...v, bound_location: loc } };
    } catch (e) {
      return { ok: false, status: 409, error: e instanceof Error ? e.message : String(e), verified: v };
    }
  }

  return { route, namesLocation, publish: path.publish, sweep: path.sweep, preflight: path.preflight, accountsReport, bind, zernioLocationOf };
}

export type GbpPath = ReturnType<typeof createGbpPath>;
