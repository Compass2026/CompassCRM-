// What a render may say and show, decided from the governed record only.
//
// The caller names references (a service id, a claim id, a label id, photo
// asset ids); it never passes text. Every word is resolved here from the
// client's record, checked against the slot's allowed roles, its word limit
// and the phrases no Compass creative may carry, and every photo against its
// creative-use review. Anything short of that is a refusal with a code; the
// render never falls back to other copy or another image.
import { CopyRefusal, wordCount } from "./text.ts";
import { focalCrop, type Crop } from "./crop.ts";
import type { Label, ListSlot, PhotoSlot, PillSlot, Role, TemplateSpec, TextSlot } from "./spec.ts";
import { sha256Hex, jsonbText } from "./spec.ts";

export const BRIEF_SCHEMA = "compass-creative-brief/1";

// ── The governed record the store reads (one client) ─────────────────────────
export type FactAsset = {
  id: string;
  kind: string;
  creative_use: string;
  depicts_own_work: boolean | null;
  subjects: string[];
  focal_x: number | null;
  focal_y: number | null;
  width: number | null;
  height: number | null;
  content_hash: string | null;
  storage_path: string | null;
};
export type Facts = {
  client: { id: string; name: string; phone: string | null; website_url: string | null; status: string };
  brand: { tagline: string | null; standing_cta: string | null };
  services: { id: string; name: string; segment: string | null; status: string }[];
  claims: { id: string; claim: string; status: string; source: string | null }[];
  assets: FactAsset[];
};

// ── The request: references only ─────────────────────────────────────────────
export type Binding = { role: Role; source_id?: string };
export type RenderRequest = {
  template: { key: string; version: number; spec_hash: string; id?: string };
  client_id: string;
  service_id?: string | null;
  bindings: Record<string, Binding | Binding[]>;
  photos?: Record<string, string[]>;
  expected_copy_hash?: string;
  expected_source_hashes?: Record<string, string>;
};

export type Line = { slot: string; role: Role; source_id: string | null; text: string };
export type PlannedPhoto = {
  slot: string; index: number; role: PhotoSlot["role"];
  asset: FactAsset; crop: Crop;
};
export type Plan = {
  lines: Line[];
  lists: Record<string, Line[]>;
  photos: PlannedPhoto[];
  logo: FactAsset;
  service_id: string | null;
  copy_hash: string;
};

// Phrases no Compass creative carries unless a later, confirmed record says
// otherwise (Sept 28 2026 decisions): offers and free work, availability and
// speed promises, licensing, counts, founding years, reviews and ratings,
// superlatives and guarantees, emergency language, street addresses.
export const GLOBAL_BLOCKED: { id: string; re: RegExp }[] = [
  { id: "free", re: /\bfree\b/i },
  { id: "24/7", re: /\b24\s*\/\s*7\b|\b24 hours?\b|\baround the clock\b/i },
  { id: "same-day", re: /\bsame[- ]day\b|\bwithin \d+ (hours?|days?)\b/i },
  { id: "licensed/bonded/insured", re: /\blicen[cs]ed\b|\bbonded\b|\binsured\b/i },
  { id: "counts", re: /\b\d[\d,]*\s*\+?\s*(roofs?|homes?|projects?|jobs?|customers?|clients?|years?)\b/i },
  { id: "founding year", re: /\bsince\s+(19|20)\d{2}\b|\b(established|founded|est\.)\s+(in\s+)?(19|20)\d{2}\b/i },
  { id: "reviews", re: /\breviews?\b|\bstars?\b|\b\d(\.\d)?\s*-?\s*star\b|\brated\b|\brating\b/i },
  { id: "superlatives", re: /#\s?1\b|\bno\.\s?1\b|\bnumber one\b|\bbest\b|\btop[- ]rated\b|\bleading\b|\bpremier\b|\bunbeatable\b|\bunmatched\b|\bmost trusted\b|\baward/i },
  { id: "guarantees", re: /\bguarantee(d|s)?\b/i },
  { id: "price", re: /\bcheapest\b|\blowest\b|\bdiscount\b|\b\$\s?\d|\b\d+\s?%\s?off\b|\bsale\b/i },
  { id: "urgency", re: /\blimited[- ]time\b|\bact now\b|\bhurry\b|\btoday only\b/i },
  { id: "emergency", re: /\bemergenc(y|ies)\b/i },
  { id: "street address", re: /\b\d{2,6}\s+[a-z0-9 .]+\b(pkwy|parkway|street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|highway|hwy)\b/i },
];

// Subject tags that mean a photo shows people. People imagery waits for a
// governed consent / usage record (Team & Community is blocked).
export const PEOPLE_SUBJECTS = /\b(owner|team member|team|crew|staff|employee|people|person|customer|homeowner|worker|family|child|children|portrait|headshot)\b/i;

const GENERIC_SERVICE_WORDS = new Set(["and", "&", "installation", "install", "repair", "repairs", "replacement",
  "services", "service", "claims", "insurance", "damage", "new", "the", "of"]);

export function displayWebsite(url: string | null): string | null {
  if (!url) return null;
  const s = url.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  return s || null;
}

// A photo may illustrate a service only when its reviewed subjects name the
// service's subject (roof for Roof Replacement, gutter for gutters, …).
export function serviceMatches(serviceName: string, subjects: string[]): boolean {
  const words = serviceName.toLowerCase().split(/[^a-z]+/).filter((w) => w && !GENERIC_SERVICE_WORDS.has(w));
  if (!words.length) return false;
  const stem = (w: string) => w.replace(/(ing|s)$/, "");
  return subjects.some((s) => words.some((w) => s.toLowerCase().split(/[^a-z]+/).some((t) => t && stem(t) === stem(w))));
}

function refuse(code: string, message: string, slot?: string): never {
  throw new CopyRefusal(code, message, slot);
}

// Why a governed line may not appear on a creative, or null.
export function blockedPhrase(text: string, spec: TemplateSpec): string | null {
  for (const b of GLOBAL_BLOCKED) {
    if (b.re.test(text)) return `"${text}" uses ${b.id} language, which is not available for creative`;
  }
  for (const src of spec.blocked_phrases) {
    if (new RegExp(src, "i").test(text)) return `"${text}" matches the client's unavailable phrase /${src}/`;
  }
  return null;
}

function checkPhrases(text: string, spec: TemplateSpec, slot: string) {
  const why = blockedPhrase(text, spec);
  if (why) refuse("unavailable_claim", why, slot);
}

export async function copyHash(lines: Line[], lists: Record<string, Line[]>): Promise<string> {
  const all = [...lines, ...Object.keys(lists).sort().flatMap((k) => lists[k])];
  return sha256Hex(jsonbText(all.map((l) => ({ slot: l.slot, role: l.role, source_id: l.source_id, text: l.text }))));
}

function slotsOf(spec: TemplateSpec): { text: (TextSlot | PillSlot)[]; lists: ListSlot[]; photos: PhotoSlot[] } {
  const text: (TextSlot | PillSlot)[] = [];
  const lists: ListSlot[] = [];
  const photos: PhotoSlot[] = [];
  for (const e of spec.elements) {
    if (e.type === "stack") {
      for (const it of e.items) (it.type === "list" ? lists : text).push(it as never);
    } else if (e.type === "text" || e.type === "pill") text.push(e);
    else if (e.type === "photo") photos.push(e);
  }
  return { text, lists, photos };
}

export async function plan(spec: TemplateSpec, facts: Facts, req: RenderRequest, templateId: string | null = null): Promise<Plan> {
  if (req.client_id !== facts.client.id) refuse("wrong_client", "The request is for another client");
  if (facts.client.status === "offboarded") refuse("client_offboarded", "The client is offboarded");
  const { text: textSlots, lists: listSlots, photos: photoSlots } = slotsOf(spec);
  const known = new Set([...textSlots.map((s) => s.slot), ...listSlots.map((s) => s.slot)]);
  for (const k of Object.keys(req.bindings ?? {})) {
    if (!known.has(k)) refuse("unknown_slot", `The template has no slot "${k}"`, k);
  }

  const service = req.service_id ? facts.services.find((s) => s.id === req.service_id) : null;
  if (req.service_id && (!service || service.status !== "approved")) {
    refuse("service_not_approved", "The topic service is not an approved service of this client");
  }
  const used = new Set<string>();

  const resolve = (slot: string, b: Binding, roles: Role[], maxWords: number): Line => {
    if (!roles.includes(b.role)) refuse("role_not_allowed", `${slot} does not take ${b.role}`, slot);
    let text: string | null = null;
    let source: string | null = null;
    switch (b.role) {
      case "business_name": text = facts.client.name; break;
      case "tagline": text = facts.brand.tagline; break;
      case "standing_cta": text = facts.brand.standing_cta; break;
      case "phone": text = facts.client.phone; break;
      case "website": text = displayWebsite(facts.client.website_url); break;
      case "service_name":
      case "service_segment": {
        const s = facts.services.find((x) => x.id === b.source_id);
        if (!s || s.status !== "approved") refuse("service_not_approved", `${slot} names a service that is not approved`, slot);
        if (service && s.id !== service.id) refuse("service_mismatch", `${slot} names another service than the creative's topic`, slot);
        if (!service) refuse("topic_service_required", `${slot} names a service; the request needs that service_id as its topic`, slot);
        text = b.role === "service_name" ? s.name : s.segment;
        source = s.id;
        break;
      }
      case "claim": {
        const c = facts.claims.find((x) => x.id === b.source_id);
        const usable = c && (c.status === "confirmed" || (c.status === "sourced" && !!c.source?.trim()));
        if (!usable) refuse("claim_unusable", `${slot} names a claim that is not confirmed or sourced`, slot);
        text = c!.claim;
        source = c!.id;
        break;
      }
      case "template_label": {
        const l = spec.labels.find((x: Label) => x.id === b.source_id);
        if (!l) refuse("label_unknown", `${slot} names a label this template does not have`, slot);
        text = l.text;
        source = templateId;
        break;
      }
    }
    if (!text || !text.trim()) refuse("governed_value_missing", `${slot}: the client record has no ${b.role}`, slot);
    const t = text!.trim();
    if (wordCount(t) > maxWords) {
      refuse("too_many_words", `${slot} allows ${maxWords} words; the governed ${b.role} has ${wordCount(t)}`, slot);
    }
    checkPhrases(t, spec, slot);
    const key = `${b.role}:${source ?? t}`;
    if (b.role === "claim" && used.has(key)) refuse("duplicate_line", `The same claim appears twice`, slot);
    used.add(key);
    return { slot, role: b.role, source_id: source, text: t };
  };

  const lines: Line[] = [];
  for (const s of textSlots) {
    const given = req.bindings?.[s.slot];
    if (s.auto) {
      if (given !== undefined) refuse("slot_is_fixed", `${s.slot} is filled by the engine (${s.auto})`, s.slot);
      lines.push(resolve(s.slot, { role: s.auto }, [s.auto], s.max_words));
      continue;
    }
    if (given === undefined) {
      if (s.required) refuse("missing_required_slot", `${s.slot} is required`, s.slot);
      continue;
    }
    if (Array.isArray(given)) refuse("not_a_list", `${s.slot} takes one line`, s.slot);
    lines.push(resolve(s.slot, given as Binding, s.roles, s.max_words));
  }
  const lists: Record<string, Line[]> = {};
  for (const s of listSlots) {
    const given = req.bindings?.[s.slot];
    const items = given === undefined ? [] : Array.isArray(given) ? given : refuse("not_a_single_line", `${s.slot} takes a list`, s.slot);
    if (items.length < s.min_items || items.length > s.max_items) {
      refuse("list_size", `${s.slot} takes ${s.min_items}–${s.max_items} items; got ${items.length}`, s.slot);
    }
    if (items.length) lists[s.slot] = items.map((b) => resolve(s.slot, b, s.roles, s.max_words_each));
  }

  // Photos: approved own work, unchanged, reviewed, no people, the topic.
  const photos: PlannedPhoto[] = [];
  const seen = new Set<string>();
  for (const g of spec.photo_groups) {
    const want = photoSlots.filter((p) => p.slot === g.slot).sort((a, b) => a.index - b.index);
    const ids = req.photos?.[g.slot] ?? [];
    if (ids.length !== want.length) refuse("photo_count", `${g.slot} takes exactly ${want.length} photo(s); got ${ids.length}`, g.slot);
    if (g.require_service_match && !service) refuse("topic_service_required", `${g.slot} must show the creative's service`, g.slot);
    for (const [i, id] of ids.entries()) {
      const where = `${g.slot}[${i}]`;
      if (seen.has(id)) refuse("duplicate_photo", "A photo is used twice", where);
      seen.add(id);
      const a = facts.assets.find((x) => x.id === id);
      if (!a) refuse("source_withdrawn", `Photo ${id} is not one of this client's assets`, where);
      if (a.kind !== "photo") refuse("source_not_photo", `Asset ${id} is not a photo`, where);
      if (a.creative_use !== "approved") refuse("source_not_approved", `Photo ${id} is ${a.creative_use} for creative use`, where);
      if (a.depicts_own_work !== true) refuse("source_not_own_work", `Photo ${id} is not marked as the client's own work`, where);
      if (!a.content_hash || !a.storage_path) refuse("source_not_hashed", `Photo ${id} has no recorded hash`, where);
      const expect = req.expected_source_hashes?.[id];
      if (expect && expect !== a.content_hash) refuse("source_changed", `Photo ${id} is no longer the file the request expected`, where);
      if (a.subjects.some((s) => PEOPLE_SUBJECTS.test(s))) {
        refuse("people_imagery_blocked", `Photo ${id} shows people; people imagery needs a governed consent record`, where);
      }
      if (g.require_service_match && !serviceMatches(service!.name, a.subjects)) {
        refuse("photo_off_topic", `Photo ${id}'s reviewed subjects do not show ${service!.name}`, where);
      }
      const slot = want[i];
      if (slot.role === "hero" && Math.min(a.width ?? 0, a.height ?? 0) < 1080) {
        refuse("source_below_hero", `Photo ${id} (${a.width}×${a.height}) is below the 1080 px hero threshold`, where);
      }
      if (a.focal_x == null || a.focal_y == null) refuse("focal_point_missing", `Photo ${id} has no reviewed focal point`, where);
      const crop = focalCrop({ width: a.width ?? 0, height: a.height ?? 0 }, { x: Number(a.focal_x), y: Number(a.focal_y) },
        { w: slot.w, h: slot.h }, where);
      photos.push({ slot: g.slot, index: i, role: slot.role, asset: a, crop });
    }
  }
  for (const k of Object.keys(req.photos ?? {})) {
    if (!spec.photo_groups.some((g) => g.slot === k)) refuse("unknown_slot", `The template has no photo group "${k}"`, k);
  }

  const logo = facts.assets.find((x) => x.id === spec.logo_asset_id);
  if (!logo || !logo.kind.startsWith("logo")) refuse("logo_withdrawn", "The template's logo is not one of this client's logos");
  if (logo.creative_use !== "approved") refuse("logo_not_approved", `The logo is ${logo.creative_use} for creative use`);
  if (!logo.content_hash || !logo.storage_path) refuse("logo_not_hashed", "The logo has no recorded hash");
  const expectLogo = req.expected_source_hashes?.[logo.id];
  if (expectLogo && expectLogo !== logo.content_hash) refuse("source_changed", "The logo is no longer the file the request expected");

  const hash = await copyHash(lines, lists);
  if (req.expected_copy_hash && req.expected_copy_hash !== hash) {
    refuse("copy_hash_mismatch", "The governed copy changed since the request was made");
  }
  return { lines, lists, photos, logo, service_id: service?.id ?? null, copy_hash: hash };
}
