// Client brand kits: the approved creative system a client's templates are
// built with. A kit holds design decisions only (palette, typography, which
// approved logo asset, phrases the client has ruled out); never a claim, a
// service or contact detail — those are read from the record at render time.
import { EMBEDDED_FONTS } from "./fonts.generated.ts";
import type { ColorToken, FontId, TemplateSpec } from "./spec.ts";

export type BrandKit = {
  client_id: string;
  slug: string;
  palette: Record<ColorToken, string>;
  fonts: TemplateSpec["fonts"];
  logo_asset_id: string;
  blocked_phrases: string[];
};

const pinnedFonts = (): TemplateSpec["fonts"] =>
  Object.fromEntries(EMBEDDED_FONTS.map((f) => [f.id, { family: f.family, weight: f.weight, sha256: f.sha256 }])) as
    Record<FontId, { family: string; weight: number; sha256: string }>;

// Lucas Construction — decisions of Sept 28 2026 (docs/lucas-creative-readiness.md):
// the creative palette (brown stays inside the logo artwork), Montserrat for
// headlines and Poppins for supporting type (the website keeps Inter), the
// v3 wordmark approved on Creative use Sept 29 2026, and the claims and
// markets that stay unavailable until separately confirmed or approved.
export const LUCAS: BrandKit = {
  client_id: "102d3b20-2795-44ae-bd64-d1e43916291c",
  slug: "lucas",
  palette: {
    charcoal: "#0d0f10",
    panel: "#1a1d1f",
    blue: "#128fb1",
    sky: "#72d2e4",
    text: "#f0f4f8",
    muted: "#8fa3b1",
  },
  fonts: pinnedFonts(),
  logo_asset_id: "0c945d6f-c1ff-4b94-8c2b-afa777366e35",
  blocked_phrases: [
    "warrant(y|ies)",                          // Lifetime Workmanship Warranty: owner confirmation pending
    "inspections?",                            // not an approved service; "free inspection" unconfirmed
    "st\\.? louis county", "greater st\\.? louis", "chesterfield", "ballwin", "wildwood", "florissant",
    "locally owned", "family[- ](owned|operated)",
    "storm chaser", "out-of-town", "high[- ]pressure",
  ],
};

export const KITS: Record<string, BrandKit> = { lucas: LUCAS };
