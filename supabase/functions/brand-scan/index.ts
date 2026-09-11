// Brand scan — pulls colors, fonts, the logo, favicon and share image from a
// client's live website into their brand board (brand_colors / brand_fonts /
// brand_assets + the private `brand-assets` bucket).
//
// Server-side twin of `scanWebsiteAction` in src/app/brand-actions.ts so the
// scan can run without a browser session: Claude seeds boards through pg_net
// with the cron secret, and the app can call it with a team member's JWT.
// Body: { client_id } for one client, or { all: true } for every client with
// a website. Responds synchronously with a per-client summary.
//
// Import mode — body { client_id, import: [...] , remove?: [...] } — skips the
// scan and files specific assets instead, for sites the heuristic scan can't
// read (JavaScript-rendered pages, logos that only exist on inner pages).
// Each import entry is { url } or { data_base64, mime_type } plus optional
// kind / label / notes / is_primary; `remove` lists brand_assets ids to
// delete (row + storage object) in the same call.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "brand-assets";
const FETCH_TIMEOUT_MS = 10_000;
const HTML_MAX = 2 * 1024 * 1024;
const CSS_MAX = 400 * 1024;
const IMAGE_MAX = 8 * 1024 * 1024;
const UA = "Mozilla/5.0 (compatible; CompassBrandScan/1.0; +https://compassmarketing.ai)";

type AssetKind =
  | "logo_primary" | "logo_alt" | "logo_icon" | "wordmark" | "photo"
  | "website_screenshot" | "social_post" | "ad" | "print" | "pattern" | "video" | "other";

// ── color helpers (mirror src/lib/brand.ts) ──────────────────────────────
function normalizeHex(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) {
    h = h.slice(0, 3).split("").map((c) => c + c).join("");
  }
  if (h.length === 8) h = h.slice(0, 6);
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : null;
}

function hexToHsl(hex: string): { s: number; l: number } {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - max - min) : d / (max + min);
  return { s, l };
}

function isChromatic(hex: string): boolean {
  const { s, l } = hexToHsl(hex);
  return s >= 0.2 && l >= 0.1 && l <= 0.92;
}

// ── fetch helpers ────────────────────────────────────────────────────────
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

// ── html helpers ─────────────────────────────────────────────────────────
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
    const url = m[0].replace(/&amp;/g, "&").replace(/&#0?38;/g, "&");
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

// ── the scan ─────────────────────────────────────────────────────────────
async function scanClient(
  supabase: SupabaseClient,
  client: { id: string; name: string; website_url: string | null }
) {
  const clientId = client.id;
  const site = client.website_url ? resolveUrl(client.website_url, "https://example.com") : null;
  if (!site) return { client: client.name, ok: false, message: "no website_url" };

  const html = await fetchText(site, HTML_MAX, "text/html,*/*;q=0.8");
  if (!html) return { client: client.name, ok: false, message: `could not fetch ${site}` };

  const colorCounts = new Map<string, number>();
  const fontCounts = new Map<string, number>();
  const cssSources: string[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) cssSources.push(m[1]);
  for (const m of html.matchAll(/style\s*=\s*"([^"]*)"/gi)) cssSources.push(m[1]);

  const links = tags(html, "link");
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

  const [{ data: existingColors }, { data: existingFonts }, { data: existingAssets }] =
    await Promise.all([
      supabase.from("brand_colors").select("hex").eq("client_id", clientId),
      supabase.from("brand_fonts").select("family").eq("client_id", clientId),
      supabase.from("brand_assets").select("url, kind").eq("client_id", clientId),
    ]);
  const haveHex = new Set((existingColors ?? []).map((c: { hex: string }) => c.hex));
  const haveFont = new Set((existingFonts ?? []).map((f: { family: string }) => f.family.toLowerCase()));
  const haveUrl = new Set((existingAssets ?? []).map((a: { url: string | null }) => a.url).filter(Boolean));
  const haveLogo = (existingAssets ?? []).some((a: { kind: string }) => a.kind === "logo_primary");

  const ranked = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]);
  const chromatic = ranked.filter(([hex]) => isChromatic(hex) && !haveHex.has(hex)).slice(0, 6);
  const neutrals = ranked
    .filter(([hex]) => !isChromatic(hex) && !haveHex.has(hex))
    .filter(([hex]) => hex !== "#ffffff" && hex !== "#000000")
    .slice(0, 2);
  const colorRows = [
    ...chromatic.map(([hex, n], i) => ({
      client_id: clientId, name: `Site color ${i + 1}`, hex, role: "other",
      usage: `Found on website (${n} uses)`, sort_order: 100 + i,
    })),
    ...neutrals.map(([hex, n], i) => ({
      client_id: clientId, name: `Site neutral ${i + 1}`, hex, role: "neutral",
      usage: `Found on website (${n} uses)`, sort_order: 200 + i,
    })),
  ];
  if (colorRows.length) {
    const { error } = await supabase.from("brand_colors").insert(colorRows);
    if (error) return { client: client.name, ok: false, message: error.message };
  }

  const fontRows: Record<string, unknown>[] = [];
  for (const g of googleFamilies(html)) {
    if (haveFont.has(g.family.toLowerCase())) continue;
    haveFont.add(g.family.toLowerCase());
    fontRows.push({
      client_id: clientId, family: g.family, role: "other", source: "google",
      url: g.url, notes: "Found on website", sort_order: 100 + fontRows.length,
    });
  }
  for (const [family] of [...fontCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    if (haveFont.has(family.toLowerCase())) continue;
    haveFont.add(family.toLowerCase());
    fontRows.push({
      client_id: clientId, family, role: "other", source: null,
      notes: "Found in website CSS", sort_order: 100 + fontRows.length,
    });
  }
  if (fontRows.length) {
    const { error } = await supabase.from("brand_fonts").insert(fontRows);
    if (error) return { client: client.name, ok: false, message: error.message };
  }

  type Candidate = { url: string; kind: AssetKind; label: string };
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

  let assetCount = 0;
  const assetErrors: string[] = [];
  for (const [i, cand] of candidates.entries()) {
    const img = await fetchImage(cand.url);
    if (!img) continue;
    const ext = img.type === "image/svg+xml" ? "svg" : (img.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
    const path = `${clientId}/scan/${Date.now()}-${i}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, img.bytes, { contentType: img.type });
    if (upErr) {
      assetErrors.push(`${cand.url}: ${upErr.message}`);
      continue;
    }
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
      uploaded_by: "brand-scan",
    });
    if (error) assetErrors.push(`${cand.url}: ${error.message}`);
    else assetCount += 1;
  }

  return {
    client: client.name,
    ok: true,
    site,
    colors: colorRows.map((c) => c.hex),
    fonts: fontRows.map((f) => f.family),
    assets: assetCount,
    candidates: candidates.map((c) => c.url),
    errors: assetErrors,
  };
}

type ImportItem = {
  url?: string;
  data_base64?: string;
  mime_type?: string;
  kind?: AssetKind;
  label?: string;
  notes?: string;
  is_primary?: boolean;
  file_name?: string;
};

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importAssets(
  supabase: SupabaseClient,
  clientId: string,
  items: ImportItem[],
  remove: string[]
) {
  const removed: string[] = [];
  const errors: string[] = [];
  if (remove.length) {
    const { data: rows } = await supabase
      .from("brand_assets").select("id, storage_path").eq("client_id", clientId).in("id", remove);
    const paths = (rows ?? []).map((r: { storage_path: string | null }) => r.storage_path).filter(Boolean) as string[];
    if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
    const { error } = await supabase.from("brand_assets").delete().eq("client_id", clientId).in("id", remove);
    if (error) errors.push(`remove: ${error.message}`);
    else removed.push(...(rows ?? []).map((r: { id: string }) => r.id));
  }

  const imported: { id: string; label: string | null; storage_path: string }[] = [];
  for (const [i, item] of items.entries()) {
    let bytes: Uint8Array | null = null;
    let type = item.mime_type ?? "";
    if (item.data_base64) {
      bytes = decodeBase64(item.data_base64);
      if (!type) type = "image/png";
    } else if (item.url) {
      const img = await fetchImage(item.url);
      if (!img) { errors.push(`${item.url}: fetch failed or not an image`); continue; }
      bytes = img.bytes;
      type = img.type;
    } else {
      errors.push(`item ${i}: needs url or data_base64`);
      continue;
    }
    const ext = type === "image/svg+xml" ? "svg" : (type.split("/")[1] ?? "png").replace("jpeg", "jpg");
    const path = `${clientId}/import/${Date.now()}-${i}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET).upload(path, bytes, { contentType: type });
    if (upErr) { errors.push(`item ${i}: ${upErr.message}`); continue; }
    if (item.is_primary) {
      await supabase.from("brand_assets").update({ is_primary: false }).eq("client_id", clientId);
    }
    const { data, error } = await supabase.from("brand_assets").insert({
      client_id: clientId,
      kind: item.kind ?? "other",
      label: item.label ?? null,
      source: item.data_base64 ? "upload" : "link",
      storage_path: path,
      url: item.url ?? null,
      file_name: item.file_name ?? path.split("/").pop() ?? null,
      mime_type: type,
      size_bytes: bytes.byteLength,
      is_primary: item.is_primary ?? false,
      notes: item.notes ?? null,
      uploaded_by: "brand-scan",
    }).select("id, label, storage_path").single();
    if (error) errors.push(`item ${i}: ${error.message}`);
    else if (data) imported.push(data);
  }
  return { ok: errors.length === 0, imported, removed, errors };
}

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Authorize: a signed-in team member (JWT in Authorization) or the cron
  // secret (x-cron-secret matching the vault secret) — same as the sync jobs.
  const { data: cronSecret } = await supabase.rpc("get_secret", {
    secret_name: "SYNC_CRON_SECRET",
  });
  const isCron =
    req.headers.get("x-cron-secret") &&
    req.headers.get("x-cron-secret") === cronSecret;
  if (!isCron) {
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData } = await supabase.auth.getUser(jwt);
    if (!userData?.user) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const body = await req.json().catch(() => ({}));
  if (body.client_id && (Array.isArray(body.import) || Array.isArray(body.remove))) {
    const result = await importAssets(
      supabase, body.client_id, body.import ?? [], body.remove ?? []
    );
    return Response.json(result, { status: result.ok ? 200 : 207 });
  }
  let query = supabase.from("clients").select("id, name, website_url");
  if (body.client_id) query = query.eq("id", body.client_id);
  else if (!body.all) return Response.json({ error: "pass client_id or all: true" }, { status: 400 });
  const { data: clients, error } = await query.not("website_url", "is", null).order("name");
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results = [];
  for (const c of clients ?? []) results.push(await scanClient(supabase, c));
  return Response.json({ results });
});
