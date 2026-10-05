// A post's creative: which governed references fill a template's slots.
//
// A teammate picks a template approved for the client; the post decides the
// rest. Its service is the topic, its linked claims are the only claims the
// image may carry (0054 / 0057 check the overlay against post_claims), and
// photos are picked from the client's approved own-work photos of that
// service. The result is references only — govern.ts still resolves and
// checks every word and photo, and refuses anything the record does not
// support. Deterministic: the same post and record give the same picks.
import { blockedPhrase, PEOPLE_SUBJECTS, serviceMatches, type Binding, type FactAsset, type Facts, type RenderRequest } from "./govern.ts";
import { focalCrop } from "./crop.ts";
import type { ListSlot, PhotoSlot, TemplateSpec, TextSlot } from "./spec.ts";
import { CopyRefusal, wordCount } from "./text.ts";

// What the store reads about a post.
export type PostFacts = {
  id: string;
  client_id: string;
  platform: string;
  service_id: string | null;
  copy: string | null;
  review_status: string;
  creative_policy: string;
  creative_version: number;
  scheduled_at: string | null;
  claim_ids: string[]; // linked claims, in the order they were linked
};

type Refs = Omit<RenderRequest, "template" | "client_id">;

function refuse(code: string, message: string, slot?: string): never {
  throw new CopyRefusal(code, message, slot);
}

// Spring Mar–May, summer Jun–Aug, fall Sep–Nov, winter Dec–Feb, by the
// Central date the post goes out (or today). "Storm season" is never picked
// for a teammate: it reads as urgency.
export function seasonFor(at: Date): "spring" | "summer" | "fall" | "winter" {
  const m = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "numeric" }).format(at));
  return m >= 3 && m <= 5 ? "spring" : m >= 6 && m <= 8 ? "summer" : m >= 9 && m <= 11 ? "fall" : "winter";
}

function textSlot(spec: TemplateSpec, name: string): TextSlot | null {
  for (const e of spec.elements) {
    if (e.type === "stack") {
      for (const it of e.items) if (it.type === "text" && it.slot === name) return it as TextSlot;
    } else if (e.type === "text" && e.slot === name) return e;
  }
  return null;
}
function listSlot(spec: TemplateSpec, name: string): ListSlot | null {
  for (const e of spec.elements) {
    if (e.type === "stack") for (const it of e.items) if (it.type === "list" && it.slot === name) return it as ListSlot;
  }
  return null;
}

// Claims linked to the post that may appear on its creative, in link order:
// confirmed or sourced, and free of language no creative carries (a claim the
// copy may cite, like a warranty pending confirmation, is simply left off).
function linkedClaims(spec: TemplateSpec, facts: Facts, post: PostFacts) {
  return post.claim_ids.flatMap((id) => {
    const c = facts.claims.find((x) => x.id === id);
    const usable = c && (c.status === "confirmed" || (c.status === "sourced" && !!c.source?.trim()));
    return usable && !blockedPhrase(c.claim.trim(), spec) ? [c] : [];
  });
}

export function postRefs(spec: TemplateSpec, facts: Facts, post: PostFacts, now: Date = new Date()): Refs {
  const service = post.service_id ? facts.services.find((s) => s.id === post.service_id) ?? null : null;
  const needsService = spec.family !== "trust_know_how";
  if (needsService && !service) refuse("post_service_missing", "The post has no service; this template shows the post's service");
  const claims = linkedClaims(spec, facts, post);
  const used = new Set<string>();
  const fits = (max: number) => (c: { id: string; claim: string }) => !used.has(c.id) && wordCount(c.claim) <= max;
  const take = (max: number) => {
    const c = claims.find(fits(max));
    if (c) used.add(c.id);
    return c ?? null;
  };
  const bindings: Record<string, Binding | Binding[]> = {};

  // Eyebrow: the service's segment where it has one, else the business.
  const eyebrow = textSlot(spec, "eyebrow");
  const segmentOrBusiness = (): Binding =>
    service?.segment?.trim() && eyebrow?.roles.includes("service_segment")
      ? { role: "service_segment", source_id: service.id }
      : { role: "business_name" };
  // Subline: the tagline, or a linked claim when the template prefers one.
  const subline = textSlot(spec, "subline");
  const tagline = facts.brand.tagline?.trim() ?? "";
  const taglineFits = !!tagline && !!subline && wordCount(tagline) <= subline.max_words && !blockedPhrase(tagline, spec);
  const sublineFrom = (preferClaim: boolean): Binding | null => {
    if (!subline) return null;
    if (preferClaim && subline.roles.includes("claim")) {
      const c = take(subline.max_words);
      if (c) return { role: "claim", source_id: c.id };
    }
    if (taglineFits && subline.roles.includes("tagline")) return { role: "tagline" };
    if (!preferClaim && subline.roles.includes("claim")) {
      const c = take(subline.max_words);
      if (c) return { role: "claim", source_id: c.id };
    }
    return null;
  };
  const points = listSlot(spec, "points");
  const fillPoints = () => {
    if (!points) return;
    const items: Binding[] = [];
    while (items.length < points.max_items) {
      const c = take(points.max_words_each);
      if (!c) break;
      items.push({ role: "claim", source_id: c.id });
    }
    if (items.length < points.min_items) {
      refuse("not_enough_claims",
        `This template lists ${points.min_items}–${points.max_items} claims beside its headline; the post links ${claims.length} usable claim(s) short enough to fit`,
        "points");
    }
    if (items.length) bindings.points = items;
  };

  switch (spec.family) {
    case "service_spotlight": {
      bindings.eyebrow = segmentOrBusiness();
      bindings.headline = { role: "service_name", source_id: service!.id };
      const s = sublineFrom(true);
      if (s) bindings.subline = s;
      fillPoints();
      break;
    }
    case "trust_know_how": {
      const head = textSlot(spec, "headline")!;
      const c = take(head.max_words);
      if (!c) refuse("not_enough_claims", "Trust & Know-How leads with a claim linked to the post; the post links none short enough to fit", "headline");
      bindings.eyebrow = { role: "business_name" };
      bindings.headline = { role: "claim", source_id: c.id };
      fillPoints();
      break;
    }
    case "seasonal": {
      const season = seasonFor(post.scheduled_at ? new Date(post.scheduled_at) : now);
      if (!spec.labels.some((l) => l.id === season)) refuse("label_unknown", `The template has no ${season} label`, "eyebrow");
      bindings.eyebrow = { role: "template_label", source_id: season };
      bindings.headline = { role: "service_name", source_id: service!.id };
      const s = sublineFrom(false);
      if (s) bindings.subline = s;
      break;
    }
    case "real_work":
      bindings.eyebrow = { role: "template_label", source_id: "our_work" };
      bindings.headline = { role: "service_name", source_id: service!.id };
      break;
    case "service_light": {
      bindings.eyebrow = segmentOrBusiness();
      bindings.headline = { role: "service_name", source_id: service!.id };
      const s = sublineFrom(false);
      if (s) bindings.subline = s;
      break;
    }
  }

  return { service_id: service?.id ?? null, bindings, photos: pickPhotos(spec, facts, service) };
}

// For each photo group, in slot order: the largest approved own-work photo
// of the service (no people, hashed, a reviewed focal point) that fills the
// slot without being enlarged — a hero also needs a short side of 1,080 px.
// A group no photo can fill is refused; there is no stand-in image.
export function pickPhotos(spec: TemplateSpec, facts: Facts, service: { id: string; name: string } | null): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const usedIds = new Set<string>();
  const shortSide = (a: FactAsset) => Math.min(a.width ?? 0, a.height ?? 0);
  const base = facts.assets.filter((a) =>
    a.kind === "photo" && a.creative_use === "approved" && a.depicts_own_work === true && !!a.content_hash && !!a.storage_path
    && a.focal_x != null && a.focal_y != null && !a.subjects.some((s) => PEOPLE_SUBJECTS.test(s)));
  for (const g of spec.photo_groups) {
    const slots = spec.elements.filter((e): e is PhotoSlot => e.type === "photo" && e.slot === g.slot).sort((a, b) => a.index - b.index);
    const onTopic = (a: FactAsset) => !!service && serviceMatches(service.name, a.subjects);
    const pool = base
      .filter((a) => !g.require_service_match || onTopic(a))
      // On topic first, then the largest, then a stable order.
      .sort((a, b) => Number(onTopic(b)) - Number(onTopic(a)) || shortSide(b) - shortSide(a) || (a.id < b.id ? -1 : 1));
    const ids: string[] = [];
    for (const slot of slots) {
      const pick = pool.find((a) => {
        if (usedIds.has(a.id)) return false;
        if (slot.role === "hero" && shortSide(a) < 1080) return false;
        try {
          focalCrop({ width: a.width ?? 0, height: a.height ?? 0 }, { x: Number(a.focal_x), y: Number(a.focal_y) }, { w: slot.w, h: slot.h }, g.slot);
          return true;
        } catch {
          return false;
        }
      });
      if (!pick) {
        const what = g.require_service_match ? `approved own-work photos of ${service?.name ?? "the service"}` : "approved own-work photos";
        refuse("no_eligible_photo",
          `The template needs ${slots.length} ${what} large enough for its ${g.slot} (${slot.role} ${slot.w}×${slot.h}); the client has ${ids.length} that fit`,
          g.slot);
      }
      usedIds.add(pick.id);
      ids.push(pick.id);
    }
    out[g.slot] = ids;
  }
  return out;
}
