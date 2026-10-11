// The publisher's Facebook path through Zernio (Zernio Social Publisher v1;
// docs/zernio-publisher.md): the Facebook channel of the shared Zernio path
// (zernio-path.ts), which owns publishing, idempotency, reconciliation and
// the no-write preflight. This file owns what is Facebook's:
//
// - the content rules and the binding rules (facebook.ts);
// - the request: the exact approved copy, pinned to the bound Page id;
// - the read-only verification of what the publish key sees (accounts and
//   their selected Page) and the explicit binding (bind), which re-reads the
//   account and never enables publishing.

import {
  bindingProblems, buildCreateBody, facebookProblems, IMAGE_TYPES, summarizeHealth, ZERNIO_ACCOUNT_RE, ZERNIO_PUBLISH_KEY_SECRET,
  type Answer, type Binding, type EntryMatch,
} from "./facebook.ts";
import { createZernioPath, type Snap, type ZernioChannel, type ZernioCtx } from "./zernio-path.ts";
import type { ZernioAccount, ZernioFacebookPage, ZernioPublisher } from "./zernio.ts";

export type FacebookCtx = ZernioCtx;
const FACEBOOK_MATCH: EntryMatch = { platform: "facebook", label: "Facebook" };

export function createFacebookPath(ctx: FacebookCtx) {
  const { store, at } = ctx;

  async function verifyAccount(z: ZernioPublisher, a: ZernioAccount) {
    const page = await z.facebookPage(a._id);
    const health = await z.health(a._id);
    const pj = (page.json ?? {}) as ZernioFacebookPage;
    return {
      zernio_account_id: a._id,
      name: a.displayName ?? a.username ?? null,
      active: a.isActive !== false && a.enabled !== false && a.needsReconnection !== true,
      selected_page_id: page.ok ? pj.selectedPageId ?? null : null,
      pages: page.ok ? (pj.pages ?? []).map((x) => ({ id: x.id, name: x.name ?? null })) : [],
      page_read: page.ok ? "ok" : page.message,
      health: health.ok ? summarizeHealth(health.json, at) : { status: "unreadable", detail: health.message, checked_at: at.toISOString() },
    };
  }

  const channel: ZernioChannel = {
    platform: "facebook",
    label: "Facebook",
    texts: {
      fixTitle: "Fix a Facebook post before it can publish",
      failedTitle: "A Facebook post failed to publish",
      checkTitle: "Check the Facebook Page before this post is sent again",
      checkNotes: (detail, link, id) =>
        `${detail} The publisher will not re-send it or record it on its own. Look at the Page and at the post in Zernio: if it is on the Page, use Mark published on ${link} with its link; if it is not, schedule it again. post_id=${id}`,
      connectTitle: "Connect Zernio publishing for Facebook",
      connectNotes: (why) => `${why} Facebook posts stay scheduled and publish on the next run after it is fixed (Settings → Publisher).`,
      reconnectTitle: "Reconnect the client's Facebook Page in Zernio",
      reconnectNotes: (why) => `${why} Reconnect the Page in Zernio, then verify it again in Settings → Publisher. Facebook posts that failed can be scheduled again afterwards.`,
      publishedOn: "published on Facebook",
      waiting: "waiting for Facebook's result.",
      noEntry: (id) => `Zernio's post ${id} has no Facebook entry for the bound account.`,
      earlierNoEntry: (id) => `Zernio's earlier post ${id} has no entry for this Page.`,
      duplicateOther: (id) => `Zernio refused the post as a duplicate of ${id}, which is not this exact post on this Page.`,
    },
    problems: (s) => facebookProblems(s),
    bindingProblems,
    target: (b) => ({ accountId: b.publish_account_id!, locationId: null }),
    match: () => FACEBOOK_MATCH,
    body: (s, b, url) => buildCreateBody(s, b, url),
    imageProblem: (_bytes, type) => (!type || !IMAGE_TYPES[type] ? "The image is not a JPEG, PNG or WebP file." : null),
    publishing: () => store.publishingFacebookPosts(),
    failed: () => store.failedFacebookPosts(),
    owns: () => Promise.resolve(true),
    targetView: (b) => ({
      social_account_id: b.id, client_id: b.client_id, facebook_page_id: b.external_account_id,
      page_name: b.display_name, zernio_account_id: b.publish_account_id, zernio_account_name: b.publish_account_name,
    }),
    async live(z, binding, check) {
      const listed = await z.facebookAccounts();
      const a = listed.accounts.find((x) => x._id === binding.publish_account_id);
      if (!listed.answer.ok) { check("Zernio account listed", false, listed.answer.message); return null; }
      if (!a) { check("Zernio account listed", false, "the publish key does not see the bound account"); return null; }
      const v = await verifyAccount(z, a);
      check("Zernio account listed and active", v.active);
      check("Zernio posts to exactly this Page", v.selected_page_id === binding.external_account_id, `selected ${v.selected_page_id}`);
      const h = v.health as { status: string; postingGranted?: boolean | null };
      check("Zernio account healthy with posting permission", h.status !== "error" && h.status !== "unreadable" && h.postingGranted !== false, `health ${h.status}`);
      return v;
    },
    fixture: (f, { assets, creative }) => ({
      platform: "facebook", social_account_id: f.social_account_id, post_type: "standard", copy: f.copy, cta_type: null, cta_url: null,
      offer: null, assets, ...(creative.length ? { creative } : {}),
    }) as Snap,
  };

  const path = createZernioPath(ctx, channel);

  // ── Read-only: what the publish key sees, matched to Compass's Pages by Page id ──
  async function accountsReport() {
    const z = await path.ensureZernio();
    if (!z) return { key: { ok: false, detail: path.keyBlock() } };
    const listed = await z.facebookAccounts();
    if (!listed.answer.ok) return { key: { ok: false, detail: listed.answer.message, http_status: listed.answer.status } };
    const zernioAccounts: Awaited<ReturnType<typeof verifyAccount>>[] = [];
    for (const a of listed.accounts) zernioAccounts.push(await verifyAccount(z, a));
    const compass = (await store.facebookAccounts()).map((b) => ({
      social_account_id: b.id, client_id: b.client_id, page_id: b.external_account_id, display_name: b.display_name,
      bound_account_id: b.publish_account_id, enabled: b.publish_enabled, verified_at: b.publish_verified_at,
      // Exact Page-id match only; the binding itself is a separate, explicit call.
      exact_matches: zernioAccounts.filter((x) => !!b.external_account_id && x.selected_page_id === b.external_account_id).map((x) => x.zernio_account_id),
    }));
    return {
      key: { ok: true, secret: ZERNIO_PUBLISH_KEY_SECRET, distinct_from_read_key: true },
      zernio_accounts: zernioAccounts, compass_accounts: compass,
    };
  }

  // Bind one Compass Facebook account to the Zernio account named by the
  // caller, after re-reading it with the publish key. Never enables.
  async function bind(socialAccountId: string, accountId: string) {
    if (!ZERNIO_ACCOUNT_RE.test(accountId)) return { ok: false, status: 400, error: "Not a Zernio account id." };
    const b = await store.account(socialAccountId);
    if (!b || b.platform !== "facebook") return { ok: false, status: 404, error: "No Compass Facebook account with that id." };
    if (!b.external_account_id) return { ok: false, status: 409, error: "The Compass account has no Facebook Page id." };
    const z = await path.ensureZernio();
    if (!z) return { ok: false, status: 424, error: path.keyBlock() };
    const listed = await z.facebookAccounts();
    if (!listed.answer.ok) return { ok: false, status: 424, error: listed.answer.message };
    const a = listed.accounts.find((x) => x._id === accountId);
    if (!a) return { ok: false, status: 409, error: "The publish key cannot see that Zernio account as a Facebook account." };
    const v = await verifyAccount(z, a);
    const refuse: string[] = [];
    if (!v.active) refuse.push("The Zernio account is not active or needs reconnecting.");
    if (v.selected_page_id !== b.external_account_id) refuse.push(`The Zernio account posts to Page ${v.selected_page_id ?? "(none)"}, not ${b.external_account_id}.`);
    if (!v.pages.some((x) => x.id === b.external_account_id)) refuse.push("The Page is not among the account's Pages.");
    const h = v.health as { status: string; postingGranted?: boolean | null; tokenValid?: boolean | null };
    if (h.status === "error" || h.status === "unreadable" || h.postingGranted === false || h.tokenValid === false) refuse.push(`Zernio health: ${h.status}, posting permission ${h.postingGranted}, token ${h.tokenValid}.`);
    if (refuse.length) return { ok: false, status: 409, error: refuse.join(" "), verified: v };
    const result = await store.bindAccount({ social_account_id: b.id, account_id: accountId, page_id: b.external_account_id, account_name: v.name, health: v.health });
    return { ok: true, status: 200, result, verified: v };
  }

  return { routable: path.routable, publish: path.publish, sweep: path.sweep, preflight: path.preflight, accountsReport, bind };
}

export type FacebookPath = ReturnType<typeof createFacebookPath>;
export type { Answer, Binding };
