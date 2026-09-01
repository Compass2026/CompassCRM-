import type { BrandBoardData } from "@/lib/brand";
import { isLightColor, pickPrimary, splitAssets, googleFontsHref, isImage } from "@/lib/brand";
import {
  brandAssetKindLabels,
  brandColorRoleLabels,
  brandFontRoleLabels,
} from "@/lib/labels";

function esc(v: string | null | undefined): string {
  return (v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function para(v: string | null | undefined): string {
  if (!v) return "";
  return v
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function chips(items: string[]): string {
  return items.map((i) => `<span class="chip">${esc(i)}</span>`).join("");
}

/**
 * Self-contained HTML snapshot of the brand board. `images` maps asset id →
 * data URI (or a URL); assets missing from the map render as a placeholder.
 */
export function renderBrandBoardHtml(
  data: BrandBoardData,
  images: Record<string, string>
): string {
  const { client, brand, colors, fonts, assets } = data;
  const primary = colors.find((c) => c.role === "primary") ?? colors[0] ?? null;
  const secondary = colors.find((c) => c.role === "secondary") ?? null;
  const logo = pickPrimary(assets, "logo_primary") ?? pickPrimary(assets, "wordmark");
  const { logos, references } = splitAssets(assets);
  const fontsHref = googleFontsHref(fonts);
  const date = new Date().toISOString().slice(0, 10);
  const src = (id: string) => images[id];

  const logoBlock = logo && src(logo.id)
    ? `<div class="logos">
        <div class="logo on-white"><img src="${esc(src(logo.id))}" alt="${esc(logo.label)}"></div>
        <div class="logo" style="background:${esc(primary?.hex ?? "#0b162a")}"><img src="${esc(src(logo.id))}" alt=""></div>
        <div class="logo" style="background:#0b162a"><img src="${esc(src(logo.id))}" alt=""></div>
      </div>`
    : `<div class="placeholder">No primary logo uploaded yet.</div>`;

  const swatches = colors
    .map(
      (c) => `<div class="swatch" style="background:${esc(c.hex)};color:${isLightColor(c.hex) ? "#0b162a" : "#fff"}">
        <div class="swatch-name">${esc(c.name)}</div>
        <div class="swatch-hex">${esc(c.hex.toUpperCase())}</div>
        <div class="swatch-role">${esc(brandColorRoleLabels[c.role])}${c.usage ? " · " + esc(c.usage) : ""}</div>
      </div>`
    )
    .join("");

  const fontRows = fonts
    .map(
      (f) => `<div class="font">
        <div class="font-sample" style="font-family:'${esc(f.family)}', system-ui, sans-serif">Aa Bb Cc 0123 — The quick brown fox</div>
        <div class="font-meta"><strong>${esc(f.family)}</strong> · ${esc(brandFontRoleLabels[f.role])}${f.weights ? " · " + esc(f.weights) : ""}${f.source ? " · " + esc(f.source) : ""}${f.notes ? "<br>" + esc(f.notes) : ""}</div>
      </div>`
    )
    .join("");

  const gallery = (list: typeof assets) =>
    list
      .map((a) => {
        const s = src(a.id);
        const body = s && isImage(a)
          ? `<img src="${esc(s)}" alt="${esc(a.label)}">`
          : `<div class="file">${esc(a.file_name ?? a.url ?? a.label)}</div>`;
        return `<figure>${body}<figcaption><strong>${esc(a.label)}</strong><br>${esc(brandAssetKindLabels[a.kind])}${a.notes ? " · " + esc(a.notes) : ""}</figcaption></figure>`;
      })
      .join("");

  const section = (title: string, body: string) =>
    body.trim()
      ? `<section><h2>${esc(title)}</h2>${body}</section>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(client.name)} — Brand Board</title>
${fontsHref ? `<link rel="stylesheet" href="${esc(fontsHref)}">` : ""}
<style>
  :root { --ink:#0b162a; --muted:rgba(11,22,42,.62); --line:rgba(11,22,42,.12); --brand:${esc(primary?.hex ?? "#e85d04")}; --brand2:${esc(secondary?.hex ?? "#16294e")}; }
  * { box-sizing:border-box; }
  body { margin:0; font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--ink); background:#fff; }
  .page { max-width:1100px; margin:0 auto; padding:48px 40px; }
  header.top { border-bottom:4px solid var(--brand); padding-bottom:24px; margin-bottom:32px; display:flex; justify-content:space-between; gap:24px; align-items:flex-end; flex-wrap:wrap; }
  .kicker { font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); margin-bottom:8px; }
  h1 { margin:0; font-size:40px; line-height:1.05; letter-spacing:-.02em; }
  .tagline { font-size:20px; margin-top:8px; color:var(--brand2); }
  .meta { font-size:13px; color:var(--muted); text-align:right; }
  section { margin:36px 0; page-break-inside:avoid; }
  h2 { font-size:13px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); border-bottom:1px solid var(--line); padding-bottom:8px; margin:0 0 16px; }
  p { margin:0 0 10px; line-height:1.55; }
  .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:24px; }
  .label { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-bottom:6px; }
  .logos { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
  .logo { border-radius:12px; padding:32px; display:flex; align-items:center; justify-content:center; min-height:180px; border:1px solid var(--line); }
  .logo img { max-width:100%; max-height:140px; object-fit:contain; }
  .swatches { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; }
  .swatch { border-radius:12px; padding:18px 14px; min-height:120px; display:flex; flex-direction:column; justify-content:flex-end; border:1px solid var(--line); }
  .swatch-name { font-weight:600; }
  .swatch-hex { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px; opacity:.9; }
  .swatch-role { font-size:11px; opacity:.85; margin-top:4px; }
  .font { padding:14px 0; border-bottom:1px solid var(--line); }
  .font-sample { font-size:30px; line-height:1.2; }
  .font-meta { font-size:13px; color:var(--muted); margin-top:6px; }
  .chip { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:4px 12px; margin:0 6px 6px 0; font-size:13px; }
  .chip.avoid { text-decoration:line-through; color:var(--muted); }
  .gallery { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:16px; }
  figure { margin:0; border:1px solid var(--line); border-radius:12px; overflow:hidden; background:#fafafa; }
  figure img { display:block; width:100%; height:180px; object-fit:cover; background:#fff; }
  figcaption { padding:10px 12px; font-size:12px; color:var(--muted); }
  .file { padding:40px 12px; text-align:center; font-size:12px; color:var(--muted); word-break:break-all; }
  .placeholder { border:1px dashed var(--line); border-radius:12px; padding:32px; color:var(--muted); text-align:center; }
  .ai { background:#f7f4ef; border-radius:12px; padding:16px 18px; }
  footer { margin-top:48px; border-top:1px solid var(--line); padding-top:16px; font-size:12px; color:var(--muted); display:flex; justify-content:space-between; }
  @media print { .page { padding:0; } body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style>
</head>
<body>
<div class="page">
  <header class="top">
    <div>
      <div class="kicker">Brand board</div>
      <h1>${esc(client.name)}</h1>
      ${brand.tagline ? `<div class="tagline">${esc(brand.tagline)}</div>` : ""}
    </div>
    <div class="meta">
      ${client.industry ? esc(client.industry) + "<br>" : ""}
      ${client.website_url ? esc(client.website_url.replace(/^https?:\/\//, "")) + "<br>" : ""}
      ${brand.approved_at ? `Approved ${esc(brand.approved_at.slice(0, 10))}` : "Draft"} · Snapshot ${date}
    </div>
  </header>

  ${section("Logo", logoBlock)}
  ${section("Color palette", swatches ? `<div class="swatches">${swatches}</div>` : "")}
  ${section("Typography", fontRows + (brand.typography_notes ? `<p style="margin-top:12px">${esc(brand.typography_notes)}</p>` : ""))}
  ${section(
    "Positioning & voice",
    `<div class="cols">
      ${brand.positioning ? `<div><div class="label">Positioning</div>${para(brand.positioning)}</div>` : ""}
      ${brand.audience ? `<div><div class="label">Audience</div>${para(brand.audience)}</div>` : ""}
      ${brand.differentiators ? `<div><div class="label">Why choose us</div>${para(brand.differentiators)}</div>` : ""}
      ${brand.voice_tone ? `<div><div class="label">Voice &amp; tone</div>${para(brand.voice_tone)}</div>` : ""}
    </div>
    ${brand.story ? `<div style="margin-top:16px"><div class="label">Brand story</div>${para(brand.story)}</div>` : ""}`
  )}
  ${section(
    "Content pillars & language",
    `${brand.content_pillars.length ? `<div class="label">Content pillars</div><div>${chips(brand.content_pillars)}</div>` : ""}
     ${brand.words_we_use.length ? `<div class="label" style="margin-top:12px">Words we use</div><div>${chips(brand.words_we_use)}</div>` : ""}
     ${brand.words_we_avoid.length ? `<div class="label" style="margin-top:12px">Words we avoid</div><div>${brand.words_we_avoid.map((w) => `<span class="chip avoid">${esc(w)}</span>`).join("")}</div>` : ""}`
  )}
  ${section("Imagery style", para(brand.imagery_style))}
  ${section("Guidance for AI-generated content", brand.ai_guidance ? `<div class="ai">${para(brand.ai_guidance)}</div>` : "")}
  ${section("Logo variations", logos.length > 1 ? `<div class="gallery">${gallery(logos)}</div>` : "")}
  ${section("Reference material", references.length ? `<div class="gallery">${gallery(references)}</div>` : "")}

  <footer>
    <span>Compass Marketing Advisors · Client Platform</span>
    <span>${esc(client.name)} · ${date}</span>
  </footer>
</div>
</body>
</html>`;
}
