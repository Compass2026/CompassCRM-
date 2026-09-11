"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";
import {
  BRAND_BUCKET,
  isChromatic,
  isImage,
  loadBrandBoard,
  normalizeHex,
} from "@/lib/brand";
import { renderBrandBoardHtml } from "@/lib/brand-board-html";

type Enums = Database["public"]["Enums"];

function str(form: FormData, key: string): string | null {
  const v = form.get(key);
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

/** One-per-line (or comma-separated) textarea → string[] */
function list(form: FormData, key: string): string[] {
  const v = form.get(key);
  if (typeof v !== "string") return [];
  return v
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function revalidateBrand(clientId: string) {
  revalidatePath(`/clients/${clientId}/brand`);
  revalidatePath(`/clients/${clientId}/brand-board`);
  revalidatePath(`/clients/${clientId}/pipelines`);
  revalidatePath("/tasks");
}

async function currentUserEmail() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email ?? null;
}

// ── Identity ───────────────────────────────────────────────────────────────
export async function upsertBrandAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("client_brands").upsert(
    {
      client_id: clientId,
      tagline: str(form, "tagline"),
      positioning: str(form, "positioning"),
      story: str(form, "story"),
      audience: str(form, "audience"),
      differentiators: str(form, "differentiators"),
      voice_tone: str(form, "voice_tone"),
      content_pillars: list(form, "content_pillars"),
      words_we_use: list(form, "words_we_use"),
      words_we_avoid: list(form, "words_we_avoid"),
      imagery_style: str(form, "imagery_style"),
      typography_notes: str(form, "typography_notes"),
      ai_guidance: str(form, "ai_guidance"),
    },
    { onConflict: "client_id" }
  );
  if (error) throw new Error(error.message);
  revalidateBrand(clientId);
}

// ── Colors ─────────────────────────────────────────────────────────────────
export async function addColorAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const hex = normalizeHex(str(form, "hex_text") ?? str(form, "hex"));
  if (!hex) throw new Error("Enter a valid hex color like #E85D04");
  const { count } = await supabase
    .from("brand_colors")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId);
  const { error } = await supabase.from("brand_colors").insert({
    client_id: clientId,
    name: str(form, "name") ?? hex.toUpperCase(),
    hex,
    role: (str(form, "role") as Enums["brand_color_role"]) ?? "other",
    usage: str(form, "usage"),
    sort_order: count ?? 0,
  });
  if (error) throw new Error(error.message);
  revalidateBrand(clientId);
}

export async function updateColorAction(
  clientId: string,
  colorId: string,
  form: FormData
) {
  const supabase = await createClient();
  const hex = normalizeHex(str(form, "hex_text") ?? str(form, "hex"));
  if (!hex) throw new Error("Enter a valid hex color like #E85D04");
  const { error } = await supabase
    .from("brand_colors")
    .update({
      name: str(form, "name") ?? hex.toUpperCase(),
      hex,
      role: (str(form, "role") as Enums["brand_color_role"]) ?? "other",
      usage: str(form, "usage"),
    })
    .eq("id", colorId)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidateBrand(clientId);
}

export async function deleteColorAction(clientId: string, colorId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("brand_colors")
    .delete()
    .eq("id", colorId)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidateBrand(clientId);
}

// ── Fonts ──────────────────────────────────────────────────────────────────
export async function addFontAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const family = str(form, "family");
  if (!family) throw new Error("Font family is required");
  const { count } = await supabase
    .from("brand_fonts")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId);
  const { error } = await supabase.from("brand_fonts").insert({
    client_id: clientId,
    family,
    role: (str(form, "role") as Enums["brand_font_role"]) ?? "other",
    source: str(form, "source"),
    url: str(form, "url"),
    weights: str(form, "weights"),
    notes: str(form, "notes"),
    sort_order: count ?? 0,
  });
  if (error) throw new Error(error.message);
  revalidateBrand(clientId);
}

export async function deleteFontAction(clientId: string, fontId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("brand_fonts")
    .delete()
    .eq("id", fontId)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidateBrand(clientId);
}

// ── Assets ─────────────────────────────────────────────────────────────────
export type RegisterAssetInput = {
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  kind: Enums["brand_asset_kind"];
  label: string;
  width?: number | null;
  height?: number | null;
  notes?: string | null;
};

/** Called by the browser uploader after the file lands in Storage. */
export async function registerAssetAction(
  clientId: string,
  input: RegisterAssetInput
) {
  if (!input.storage_path.startsWith(`${clientId}/`)) {
    throw new Error("Storage path does not belong to this client");
  }
  const supabase = await createClient();
  const uploadedBy = await currentUserEmail();
  const { error } = await supabase.from("brand_assets").insert({
    client_id: clientId,
    kind: input.kind,
    label: input.label || input.file_name,
    source: "upload",
    storage_path: input.storage_path,
    file_name: input.file_name,
    mime_type: input.mime_type,
    size_bytes: input.size_bytes,
    width: input.width ?? null,
    height: input.height ?? null,
    notes: input.notes ?? null,
    uploaded_by: uploadedBy,
  });
  if (error) throw new Error(error.message);
  revalidateBrand(clientId);
}

export async function addAssetLinkAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const url = str(form, "url");
  if (!url) throw new Error("URL is required");
  const uploadedBy = await currentUserEmail();
  const { error } = await supabase.from("brand_assets").insert({
    client_id: clientId,
    kind: (str(form, "kind") as Enums["brand_asset_kind"]) ?? "other",
    label: str(form, "label") ?? url,
    source: "link",
    url,
    notes: str(form, "notes"),
    uploaded_by: uploadedBy,
  });
  if (error) throw new Error(error.message);
  revalidateBrand(clientId);
}

export async function updateAssetAction(
  clientId: string,
  assetId: string,
  form: FormData
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("brand_assets")
    .update({
      kind: (str(form, "kind") as Enums["brand_asset_kind"]) ?? "other",
      label: str(form, "label") ?? "Asset",
      notes: str(form, "notes"),
    })
    .eq("id", assetId)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidateBrand(clientId);
}

export async function setPrimaryAssetAction(clientId: string, assetId: string) {
  const supabase = await createClient();
  const { data: asset } = await supabase
    .from("brand_assets")
    .select("kind")
    .eq("id", assetId)
    .eq("client_id", clientId)
    .single();
  if (!asset) throw new Error("Asset not found");
  await supabase
    .from("brand_assets")
    .update({ is_primary: false })
    .eq("client_id", clientId)
    .eq("kind", asset.kind);
  const { error } = await supabase
    .from("brand_assets")
    .update({ is_primary: true })
    .eq("id", assetId);
  if (error) throw new Error(error.message);
  revalidateBrand(clientId);
}

export async function deleteAssetAction(clientId: string, assetId: string) {
  const supabase = await createClient();
  const { data: asset } = await supabase
    .from("brand_assets")
    .select("storage_path")
    .eq("id", assetId)
    .eq("client_id", clientId)
    .single();
  if (asset?.storage_path) {
    await supabase.storage.from(BRAND_BUCKET).remove([asset.storage_path]);
  }
  const { error } = await supabase
    .from("brand_assets")
    .delete()
    .eq("id", assetId)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidateBrand(clientId);
}

// ── Approval (closes the "Build brand board" task) ─────────────────────────
export async function approveBrandBoardAction(clientId: string) {
  const supabase = await createClient();
  const email = await currentUserEmail();
  const now = new Date().toISOString();
  const { error } = await supabase.from("client_brands").upsert(
    { client_id: clientId, approved_at: now, approved_by: email },
    { onConflict: "client_id" }
  );
  if (error) throw new Error(error.message);
  await supabase
    .from("tasks")
    .update({ status: "done", completed_at: now })
    .eq("client_id", clientId)
    .eq("key", "brand_board");
  revalidateBrand(clientId);
}

export async function reopenBrandBoardAction(clientId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("client_brands")
    .update({ approved_at: null, approved_by: null })
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  await supabase
    .from("tasks")
    .update({ status: "open", completed_at: null })
    .eq("client_id", clientId)
    .eq("key", "brand_board");
  revalidateBrand(clientId);
}

// ── Publish a snapshot into Documents ──────────────────────────────────────
const INLINE_IMAGE_MAX = 3 * 1024 * 1024; // per asset
const INLINE_TOTAL_MAX = 12 * 1024 * 1024; // whole document

export async function publishBrandBoardAction(clientId: string) {
  const supabase = await createClient();
  const data = await loadBrandBoard(supabase, clientId);
  if (!data) throw new Error("Client not found");

  const images: Record<string, string> = {};
  let total = 0;
  for (const asset of data.assets) {
    if (!isImage(asset)) continue;
    if (!asset.storage_path) {
      if (asset.url) images[asset.id] = asset.url;
      continue;
    }
    if (asset.size_bytes && asset.size_bytes > INLINE_IMAGE_MAX) continue;
    const { data: blob } = await supabase.storage
      .from(BRAND_BUCKET)
      .download(asset.storage_path);
    if (!blob || blob.size > INLINE_IMAGE_MAX) continue;
    if (total + blob.size > INLINE_TOTAL_MAX) break;
    total += blob.size;
    const buf = Buffer.from(await blob.arrayBuffer());
    const mime = asset.mime_type || blob.type || "image/png";
    images[asset.id] = `data:${mime};base64,${buf.toString("base64")}`;
  }

  const html = renderBrandBoardHtml(data, images);
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `${date} ${data.client.name} — Brand Board.html`;
  const path = `${clientId}/brand-board/${Date.now()}-brand-board.html`;
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(path, new Blob([html], { type: "text/html" }), {
      contentType: "text/html; charset=utf-8",
    });
  if (uploadError) throw new Error(uploadError.message);

  const email = await currentUserEmail();
  const { error } = await supabase.from("documents").insert({
    client_id: clientId,
    kind: "upload",
    label: `Brand Board ${date}`,
    category: "brand",
    storage_path: path,
    file_name: fileName,
    mime_type: "text/html",
    uploaded_by: email,
    notes: data.brand.approved_at
      ? `Approved ${data.brand.approved_at.slice(0, 10)}`
      : "Draft snapshot",
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/documents`);
  redirect(`/clients/${clientId}/documents`);
}

// ── Website scan: pull colors, fonts and logo candidates from the live site ─
export type ScanState = { ok: boolean; message: string } | null;

const FETCH_TIMEOUT_MS = 10_000;
const HTML_MAX = 2 * 1024 * 1024;
const CSS_MAX = 400 * 1024;
const IMAGE_MAX = 8 * 1024 * 1024;
const UA = "Mozilla/5.0 (compatible; CompassBrandScan/1.0; +https://compassmarketing.ai)";

async function fetchWithTimeout(url: string, accept: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept },
    });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, maxBytes: number, accept: string) {
  const res = await fetchWithTimeout(url, accept);
  if (!res) return null;
  const bytes = new Uint8Array(await res.arrayBuffer()).slice(0, maxBytes);
  return new TextDecoder().decode(bytes);
}

async function fetchImage(url: string) {
  const res = await fetchWithTimeout(url, "image/*,*/*;q=0.8");
  if (!res) return null;
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!type.startsWith("image/")) return null;
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > IMAGE_MAX) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > IMAGE_MAX) return null;
  return { bytes: new Uint8Array(buf), type };
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) {
    attrs[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return attrs;
}

function tags(html: string, name: string): Record<string, string>[] {
  const re = new RegExp(`<${name}\\b([^>]*)>`, "gi");
  const out: Record<string, string>[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(parseAttrs(m[1]));
  return out;
}

function resolveUrl(href: string | undefined, base: string): string | null {
  if (!href || href.startsWith("data:") || href.startsWith("javascript:")) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const GENERIC_FONTS = new Set([
  "inherit", "initial", "unset", "sans-serif", "serif", "monospace", "system-ui",
  "-apple-system", "blinkmacsystemfont", "segoe ui", "ui-sans-serif", "ui-serif",
  "ui-monospace", "ui-rounded", "cursive", "fantasy", "arial", "helvetica",
  "helvetica neue", "times new roman", "times", "emoji", "apple color emoji",
  "segoe ui emoji", "segoe ui symbol", "noto color emoji", "icon", "fontawesome",
  "font awesome 5 free", "font awesome 6 free", "material icons", "sans", "revicons",
  "icomoon", "star", "woocommerce", "dashicons", "eicons", "genericons", "flaticon",
  "ionicons", "themify", "fontello", "linearicons", "simple-line-icons", "swiper-icons",
]);

function collectColors(css: string, counts: Map<string, number>) {
  for (const m of css.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
    const hex = normalizeHex(m[1]);
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g)) {
    const [r, g, b] = [m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)));
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
}

function collectFonts(css: string, counts: Map<string, number>) {
  for (const m of css.matchAll(/font-family\s*:\s*([^;}!]+)/gi)) {
    const first = m[1].split(",")[0].trim().replace(/^["']|["']$/g, "").trim();
    if (!first || first.startsWith("var(") || first.length > 40) continue;
    const key = first.toLowerCase();
    if (GENERIC_FONTS.has(key) || /icon|icomoon|awesome|glyph|symbol|emoji|woocommerce/.test(key)) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
}

function googleFamilies(html: string): { family: string; url: string }[] {
  const out: { family: string; url: string }[] = [];
  for (const m of html.matchAll(/https?:\/\/fonts\.googleapis\.com\/css2?\?[^"'\s)]+/gi)) {
    const url = m[0].replace(/&amp;/g, "&");
    try {
      const params = new URL(url).searchParams;
      for (const fam of params.getAll("family")) {
        for (const piece of fam.split("|")) {
          const name = piece.split(":")[0].replace(/\+/g, " ").trim();
          if (name && !out.some((o) => o.family === name)) out.push({ family: name, url });
        }
      }
    } catch {
      // ignore malformed font URLs
    }
  }
  return out;
}

export async function scanWebsiteAction(
  clientId: string,
  _prev: ScanState,
  _form: FormData
): Promise<ScanState> {
  void _prev;
  void _form;
  const supabase = await createClient();
  const { data: client } = await supabase
    .from("clients")
    .select("id, name, website_url")
    .eq("id", clientId)
    .single();
  if (!client?.website_url) {
    return { ok: false, message: "Add the client's website on the Overview tab first." };
  }
  const site = resolveUrl(client.website_url, "https://example.com");
  if (!site) return { ok: false, message: "Website URL is not valid." };

  const html = await fetchText(site, HTML_MAX, "text/html,*/*;q=0.8");
  if (!html) return { ok: false, message: `Could not fetch ${site}.` };

  // ── stylesheets, inline styles ──
  const colorCounts = new Map<string, number>();
  const fontCounts = new Map<string, number>();
  const cssSources: string[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) cssSources.push(m[1]);
  for (const m of html.matchAll(/style\s*=\s*"([^"]*)"/gi)) cssSources.push(m[1]);

  const links = tags(html, "link");
  // Theme / custom CSS carries the brand; plugin and framework CSS mostly
  // carries resets and greys. Rank accordingly before capping the fetches.
  const stylesheetScore = (u: string) =>
    (/theme|custom|uploads|\/style\.css|main|app|index/i.test(u) ? 3 : 0) -
    (/\/plugins\/|bootstrap|reset|normalize|swiper|slick|font-?awesome|icons?\.css/i.test(u) ? 2 : 0);
  const stylesheetUrls = links
    .filter((l) => /\bstylesheet\b/i.test(l.rel ?? ""))
    .map((l) => resolveUrl(l.href, site))
    .filter((u): u is string => !!u && !u.includes("fonts.googleapis.com"))
    .sort((a, b) => stylesheetScore(b) - stylesheetScore(a))
    .slice(0, 8);
  const sheets = await Promise.all(
    stylesheetUrls.map((u) => fetchText(u, CSS_MAX, "text/css,*/*;q=0.8"))
  );
  for (const s of sheets) if (s) cssSources.push(s);

  for (const css of cssSources) {
    collectColors(css, colorCounts);
    collectFonts(css, fontCounts);
  }
  for (const meta of tags(html, "meta")) {
    if ((meta.name ?? "").toLowerCase() === "theme-color") {
      const hex = normalizeHex(meta.content);
      if (hex) colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 50);
    }
  }

  // ── existing rows (dedupe) ──
  const [{ data: existingColors }, { data: existingFonts }, { data: existingAssets }] =
    await Promise.all([
      supabase.from("brand_colors").select("hex").eq("client_id", clientId),
      supabase.from("brand_fonts").select("family").eq("client_id", clientId),
      supabase.from("brand_assets").select("url, kind").eq("client_id", clientId),
    ]);
  const haveHex = new Set((existingColors ?? []).map((c) => c.hex));
  const haveFont = new Set((existingFonts ?? []).map((f) => f.family.toLowerCase()));
  const haveUrl = new Set((existingAssets ?? []).map((a) => a.url).filter(Boolean));
  const haveLogo = (existingAssets ?? []).some((a) => a.kind === "logo_primary");

  // ── colors: top chromatic + a couple of neutrals ──
  const ranked = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]);
  const chromatic = ranked.filter(([hex]) => isChromatic(hex) && !haveHex.has(hex)).slice(0, 6);
  const neutrals = ranked
    .filter(([hex]) => !isChromatic(hex) && !haveHex.has(hex))
    .filter(([hex]) => hex !== "#ffffff" && hex !== "#000000")
    .slice(0, 2);
  const colorRows = [
    ...chromatic.map(([hex, n], i) => ({
      client_id: clientId,
      name: `Site color ${i + 1}`,
      hex,
      role: "other" as const,
      usage: `Found on website (${n} uses)`,
      sort_order: 100 + i,
    })),
    ...neutrals.map(([hex, n], i) => ({
      client_id: clientId,
      name: `Site neutral ${i + 1}`,
      hex,
      role: "neutral" as const,
      usage: `Found on website (${n} uses)`,
      sort_order: 200 + i,
    })),
  ];
  if (colorRows.length) {
    const { error } = await supabase.from("brand_colors").insert(colorRows);
    if (error) return { ok: false, message: error.message };
  }

  // ── fonts ──
  const google = googleFamilies(html);
  const fontRows: Database["public"]["Tables"]["brand_fonts"]["Insert"][] = [];
  for (const g of google) {
    if (haveFont.has(g.family.toLowerCase())) continue;
    haveFont.add(g.family.toLowerCase());
    fontRows.push({
      client_id: clientId,
      family: g.family,
      role: "other",
      source: "google",
      url: g.url,
      notes: "Found on website",
      sort_order: 100 + fontRows.length,
    });
  }
  for (const [family] of [...fontCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    if (haveFont.has(family.toLowerCase())) continue;
    haveFont.add(family.toLowerCase());
    fontRows.push({
      client_id: clientId,
      family,
      role: "other",
      source: null,
      notes: "Found in website CSS",
      sort_order: 100 + fontRows.length,
    });
  }
  if (fontRows.length) {
    const { error } = await supabase.from("brand_fonts").insert(fontRows);
    if (error) return { ok: false, message: error.message };
  }

  // ── logo / icon / share image candidates ──
  type Candidate = { url: string; kind: Enums["brand_asset_kind"]; label: string };
  const candidates: Candidate[] = [];
  const push = (c: Candidate | null) => {
    if (c && !candidates.some((x) => x.url === c.url) && !haveUrl.has(c.url)) candidates.push(c);
  };

  let firstLogo = true;
  for (const img of tags(html, "img")) {
    const hint = `${img.src ?? ""} ${img["data-src"] ?? ""} ${img.alt ?? ""} ${img.class ?? ""} ${img.id ?? ""}`.toLowerCase();
    if (!hint.includes("logo")) continue;
    const url = resolveUrl(img.src || img["data-src"], site);
    if (!url) continue;
    push({
      url,
      kind: firstLogo && !haveLogo ? "logo_primary" : "logo_alt",
      label: firstLogo ? "Website logo" : "Website logo (alternate)",
    });
    firstLogo = false;
    if (candidates.length >= 2) break;
  }

  const icons = links
    .filter((l) => /\bicon\b/i.test(l.rel ?? ""))
    .map((l) => ({
      url: resolveUrl(l.href, site),
      size: Number((l.sizes ?? "0").split("x")[0]) || (/apple/i.test(l.rel ?? "") ? 180 : 32),
    }))
    .filter((i): i is { url: string; size: number } => !!i.url)
    .sort((a, b) => b.size - a.size);
  if (icons[0]) push({ url: icons[0].url, kind: "logo_icon", label: "Site icon" });

  for (const meta of tags(html, "meta")) {
    if ((meta.property ?? meta.name ?? "").toLowerCase() === "og:image") {
      const url = resolveUrl(meta.content, site);
      if (url) push({ url, kind: "other", label: "Website share image" });
      break;
    }
  }

  const email = await currentUserEmail();
  let assetCount = 0;
  for (const [i, cand] of candidates.entries()) {
    const img = await fetchImage(cand.url);
    if (!img) continue;
    const ext = img.type === "image/svg+xml" ? "svg" : (img.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
    const path = `${clientId}/scan/${Date.now()}-${i}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(BRAND_BUCKET)
      .upload(path, img.bytes, { contentType: img.type });
    if (upErr) continue;
    const { error } = await supabase.from("brand_assets").insert({
      client_id: clientId,
      kind: cand.kind,
      label: cand.label,
      source: "website_scan",
      storage_path: path,
      url: cand.url,
      file_name: path.split("/").pop() ?? null,
      mime_type: img.type,
      size_bytes: img.bytes.byteLength,
      notes: `Pulled from ${site}`,
      uploaded_by: email,
    });
    if (!error) assetCount += 1;
  }

  revalidateBrand(clientId);
  const parts = [
    `${colorRows.length} color${colorRows.length === 1 ? "" : "s"}`,
    `${fontRows.length} font${fontRows.length === 1 ? "" : "s"}`,
    `${assetCount} image${assetCount === 1 ? "" : "s"}`,
  ];
  return {
    ok: true,
    message:
      colorRows.length + fontRows.length + assetCount === 0
        ? "Scan finished — nothing new found (everything on the site is already on the board)."
        : `Added ${parts.join(", ")} from ${site}. Review them below: rename, assign roles, delete what doesn't belong.`,
  };
}
