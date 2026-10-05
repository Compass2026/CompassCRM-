// The Lucas preview set: for each template, the governed references a
// preview renders (a service, claims by id, a label, approved photos by id).
// References only — the renderer resolves every word from the record and
// refuses anything the record does not support. Used by the CRM's read-only
// preview page, the tests and the Deno cross-check.
//
// Choices (Sept 30 2026): Roof Replacement, the service every approved
// own-work photo shows; the four usable credentials (the warranty and review
// claims are unavailable); the one hero-grade own-work photo (IMG_7051,
// 1536×2048) where a photo leads; the smaller own-work photos where they are
// cells or a feature panel. No team / people photos (consent pending).
import type { RenderRequest } from "./govern.ts";

type Refs = Omit<RenderRequest, "template" | "client_id">;

const RR = "4288b96c-db9f-436e-b492-78f5fa7f1f21"; // Roof Replacement
const CLAIM = {
  preferred: "818761df-41bb-41ab-afab-6ecbe4779803", // Owens Corning Preferred Contractor
  duration: "fa1d2070-c56c-4a75-a7ce-43effb6f0d21",  // Installs Owens Corning Duration shingles
  bbb: "7c2a2d65-8242-4734-851d-fa3d6f58911e",       // BBB Accredited Business since 6/30/2025
  scope: "fc6e22d0-f704-43f8-b39b-24f8750ada61",     // Roofing, siding, guttering, fascia and soffit contractor
};
const PHOTO = {
  hero: "3a5e930a-1841-4cc3-860e-f6abbdf3e5a1",     // IMG_7051 finished roof, 1536×2048
  crane: "c7db9166-f6ed-4581-8aaf-fbe6aeee43d5",    // crane lift / active jobsite, 980×1307
  active: "1979f6aa-accb-46b0-919a-7af48d7d6f87",   // active project, 950×1200
  done: "db6eec44-9c4d-4313-82d7-d27e5dfd9bda",     // completed exterior, 950×1200
  edge: "8dfb59dd-1aab-4f2f-9200-1aff067b5396",     // roof edge / gutters detail, 950×1200
};

const spotlight = (gbp: boolean): Refs => ({
  service_id: RR,
  bindings: {
    eyebrow: { role: "service_segment", source_id: RR },
    headline: { role: "service_name", source_id: RR },
    subline: { role: "claim", source_id: CLAIM.duration },
    ...(gbp ? { points: [{ role: "claim", source_id: CLAIM.preferred }, { role: "claim", source_id: CLAIM.bbb }] } : {}),
  },
  photos: { photos: [PHOTO.hero] },
});
const trust = (gbp: boolean): Refs => ({
  bindings: {
    eyebrow: { role: "business_name" },
    headline: { role: "claim", source_id: CLAIM.preferred },
    points: [{ role: "claim", source_id: CLAIM.duration }, { role: "claim", source_id: CLAIM.bbb }, { role: "claim", source_id: CLAIM.scope }],
  },
  photos: { photos: [gbp ? PHOTO.crane : PHOTO.hero] },
});
const seasonal = (): Refs => ({
  service_id: RR,
  bindings: {
    eyebrow: { role: "template_label", source_id: "fall" },
    headline: { role: "service_name", source_id: RR },
    subline: { role: "tagline" },
  },
  photos: { photos: [PHOTO.done, PHOTO.active] },
});
const realWork = (gbp: boolean): Refs => ({
  service_id: RR,
  bindings: {
    eyebrow: { role: "template_label", source_id: "our_work" },
    headline: { role: "service_name", source_id: RR },
  },
  photos: { photos: gbp ? [PHOTO.crane, PHOTO.active, PHOTO.done] : [PHOTO.crane, PHOTO.active, PHOTO.done, PHOTO.edge] },
});
const light = (): Refs => ({
  service_id: RR,
  bindings: {
    eyebrow: { role: "service_segment", source_id: RR },
    headline: { role: "service_name", source_id: RR },
    subline: { role: "tagline" },
  },
  photos: { photos: [PHOTO.hero, PHOTO.done, PHOTO.edge] },
});

const BY_FAMILY: Record<string, (gbp: boolean) => Refs> = {
  "service-spotlight": spotlight, "trust-know-how": trust, "seasonal": seasonal, "real-work": realWork, "service-light": light,
};

export function lucasPreviewRefs(templateKey: string): Refs | null {
  const m = templateKey.match(/^lucas-(.+)-(gbp|facebook|instagram)$/);
  const f = m && BY_FAMILY[m[1]];
  return f ? f(m![2] === "gbp") : null;
}

// Review order: the three pilot families first (Business Profile, then the
// 4:5 social version), then the other two cleared families.
export const LUCAS_PREVIEW_ORDER = [
  "lucas-service-spotlight-gbp", "lucas-service-spotlight-facebook",
  "lucas-trust-know-how-gbp", "lucas-trust-know-how-facebook",
  "lucas-real-work-gbp", "lucas-real-work-facebook",
  "lucas-seasonal-gbp", "lucas-seasonal-facebook",
  "lucas-service-light-gbp", "lucas-service-light-facebook",
];
