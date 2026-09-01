import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { brandLogoKinds } from "@/lib/labels";

type Tables = Database["public"]["Tables"];

export type BrandRow = Tables["client_brands"]["Row"];
export type BrandColor = Tables["brand_colors"]["Row"];
export type BrandFont = Tables["brand_fonts"]["Row"];
export type BrandAsset = Tables["brand_assets"]["Row"] & {
  signed_url: string | null;
};
export type BrandClient = Pick<
  Tables["clients"]["Row"],
  "id" | "name" | "dba" | "industry" | "website_url" | "city" | "state" | "service_area"
>;
export type BrandTask = Pick<
  Tables["tasks"]["Row"],
  "id" | "status" | "owner" | "due_date" | "completed_at"
>;

export type BrandBoardData = {
  client: BrandClient;
  brand: BrandRow;
  colors: BrandColor[];
  fonts: BrandFont[];
  assets: BrandAsset[];
  task: BrandTask | null;
};

export const BRAND_BUCKET = "brand-assets";
export const SIGNED_URL_TTL = 60 * 60; // 1 hour

export function emptyBrand(clientId: string): BrandRow {
  return {
    client_id: clientId,
    tagline: null,
    positioning: null,
    story: null,
    audience: null,
    differentiators: null,
    voice_tone: null,
    content_pillars: [],
    words_we_use: [],
    words_we_avoid: [],
    imagery_style: null,
    typography_notes: null,
    ai_guidance: null,
    approved_at: null,
    approved_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function loadBrandBoard(
  supabase: SupabaseClient<Database>,
  clientId: string
): Promise<BrandBoardData | null> {
  const [
    { data: client },
    { data: brand },
    { data: colors },
    { data: fonts },
    { data: assets },
    { data: task },
  ] = await Promise.all([
    supabase
      .from("clients")
      .select("id, name, dba, industry, website_url, city, state, service_area")
      .eq("id", clientId)
      .single(),
    supabase.from("client_brands").select("*").eq("client_id", clientId).maybeSingle(),
    supabase
      .from("brand_colors")
      .select("*")
      .eq("client_id", clientId)
      .order("sort_order")
      .order("created_at"),
    supabase
      .from("brand_fonts")
      .select("*")
      .eq("client_id", clientId)
      .order("sort_order")
      .order("created_at"),
    supabase
      .from("brand_assets")
      .select("*")
      .eq("client_id", clientId)
      .order("is_primary", { ascending: false })
      .order("sort_order")
      .order("created_at"),
    supabase
      .from("tasks")
      .select("id, status, owner, due_date, completed_at")
      .eq("client_id", clientId)
      .eq("key", "brand_board")
      .order("created_at")
      .limit(1)
      .maybeSingle(),
  ]);

  if (!client) return null;

  const paths = (assets ?? [])
    .map((a) => a.storage_path)
    .filter((p): p is string => !!p);
  const signed = new Map<string, string>();
  if (paths.length > 0) {
    const { data } = await supabase.storage
      .from(BRAND_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL);
    for (const row of data ?? []) {
      if (row.path && row.signedUrl) signed.set(row.path, row.signedUrl);
    }
  }

  return {
    client,
    brand: brand ?? emptyBrand(clientId),
    colors: colors ?? [],
    fonts: fonts ?? [],
    assets: (assets ?? []).map((a) => ({
      ...a,
      signed_url: a.storage_path
        ? (signed.get(a.storage_path) ?? null)
        : (a.url ?? null),
    })),
    task: task ?? null,
  };
}

// ── Color helpers ──────────────────────────────────────────────────────────
export function normalizeHex(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) {
    h = h
      .slice(0, 3)
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length === 8) h = h.slice(0, 6);
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : null;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r0, g0, b0] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r0, g0, b0);
  const min = Math.min(r0, g0, b0);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r0:
        h = ((g0 - b0) / d + (g0 < b0 ? 6 : 0)) * 60;
        break;
      case g0:
        h = ((b0 - r0) / d + 2) * 60;
        break;
      default:
        h = ((r0 - g0) / d + 4) * 60;
    }
  }
  return { h, s, l };
}

/** True when black text reads better than white on this color. */
export function isLightColor(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 150;
}

export function isChromatic(hex: string): boolean {
  const { s, l } = hexToHsl(hex);
  return s >= 0.2 && l >= 0.1 && l <= 0.92;
}

// ── Font helpers ───────────────────────────────────────────────────────────
export function isGoogleFont(font: Pick<BrandFont, "source" | "url">): boolean {
  return (
    (font.source ?? "").toLowerCase() === "google" ||
    (font.url ?? "").includes("fonts.google")
  );
}

/** Google Fonts stylesheet URL that loads every Google-sourced brand font. */
export function googleFontsHref(fonts: BrandFont[]): string | null {
  const families = fonts
    .filter(isGoogleFont)
    .map((f) => f.family.trim())
    .filter(Boolean);
  if (families.length === 0) return null;
  const params = families
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;600;700`)
    .join("&");
  return `https://fonts.googleapis.com/css2?${params}&display=swap`;
}

// ── Asset helpers ──────────────────────────────────────────────────────────
export function pickPrimary(assets: BrandAsset[], kind: BrandAsset["kind"]) {
  const ofKind = assets.filter((a) => a.kind === kind);
  return ofKind.find((a) => a.is_primary) ?? ofKind[0] ?? null;
}

export function splitAssets(assets: BrandAsset[]) {
  const logos = assets.filter((a) => brandLogoKinds.includes(a.kind));
  const references = assets.filter((a) => !brandLogoKinds.includes(a.kind));
  return { logos, references };
}

export function isImage(asset: Pick<BrandAsset, "mime_type" | "url" | "storage_path">) {
  if (asset.mime_type) return asset.mime_type.startsWith("image/");
  const target = asset.storage_path ?? asset.url ?? "";
  return /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(target);
}
