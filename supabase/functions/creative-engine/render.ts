// The deterministic Creative Engine renderer.
//
// spec (fixed design) + plan (governed words and reviewed photos) + the
// source bytes → one PNG. Text is drawn as glyph paths from the pinned fonts,
// photos are cropped around their reviewed focal point (never enlarged), and
// resvg (pinned WASM, identical in Node and Deno) rasterises the SVG. The same
// inputs give the same bytes; the brief records every input and its hash.
import { EMBEDDED_FONTS } from "./fonts.generated.ts";
import { BRIEF_SCHEMA, plan as makePlan, type Facts, type Line, type Plan, type RenderRequest } from "./govern.ts";
import { CopyRefusal, alignX, layout, linePath, measure, type OtFont } from "./text.ts";
import { jsonbText, sha256Hex, specHash, type ColorToken, type Element, type FontId, type ListSlot, type PillSlot,
  type RegisteredTemplate, type Stack, type TemplateSpec, type TextSlot } from "./spec.ts";

export const RENDERER_VERSION = 1;
export const RESVG_WASM_VERSION = "2.6.2";
export const RESVG_WASM_SHA256 = "22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70";
export const OPENTYPE_VERSION = "1.3.4";
export const RENDERER_ID = `creative-engine/${RENDERER_VERSION} resvg-wasm@${RESVG_WASM_VERSION} opentype.js@${OPENTYPE_VERSION}`;
export const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // Business Profile's upload limit

export type Deps = {
  parseFont(buf: ArrayBuffer): OtFont;
  rasterize(svg: string): Uint8Array;
};

export type Engine = { fonts: Record<FontId, OtFont>; rasterize(svg: string): Uint8Array };

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Fonts are checked against their pinned hashes before the engine exists.
export async function createEngine(deps: Deps): Promise<Engine> {
  const fonts = {} as Record<FontId, OtFont>;
  for (const f of EMBEDDED_FONTS) {
    const bytes = b64ToBytes(f.base64);
    if (await sha256Hex(bytes) !== f.sha256) throw new Error(`font ${f.id} does not match its pinned hash`);
    fonts[f.id as FontId] = deps.parseFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }
  return { fonts, rasterize: deps.rasterize };
}

export async function checkWasm(bytes: Uint8Array): Promise<void> {
  const h = await sha256Hex(bytes);
  if (h !== RESVG_WASM_SHA256) throw new Error(`resvg wasm hash ${h} is not the pinned ${RESVG_WASM_SHA256}`);
}

function sniff(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  throw new CopyRefusal("source_format", "A source file is not a JPEG, PNG or WebP image");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => String(Math.round(v * 100) / 100);

type Ctx = { spec: TemplateSpec; engine: Engine; col: (t: ColorToken) => string; defs: string[]; body: string[]; clip: number };

function drawText(c: Ctx, s: TextSlot, text: string, x: number, y: number): number {
  const font = c.engine.fonts[s.style.font];
  const laid = layout(font, text, s.style, s.w, s.max_lines, s.slot);
  laid.lines.forEach((l, i) => {
    const lx = alignX(x, s.w, l.width, s.style.align);
    c.body.push(`<path d="${linePath(font, l.text, s.style, lx, y + i * s.style.line_height)}" fill="${c.col(s.style.color)}"/>`);
  });
  return laid.height;
}

function drawPill(c: Ctx, s: PillSlot, text: string, x: number, y: number): number {
  const font = c.engine.fonts[s.style.font];
  const laid = layout(font, text, s.style, s.max_w - 2 * s.pad_x, 1, s.slot);
  const w = laid.lines[0].width + 2 * s.pad_x;
  const h = s.style.line_height + 2 * s.pad_y;
  const px = s.align === "right" ? x + s.max_w - w : x;
  c.body.push(`<rect x="${n(px)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(h / 2)}" fill="${c.col(s.fill)}"/>`);
  c.body.push(`<path d="${linePath(font, laid.lines[0].text, s.style, px + s.pad_x, y + s.pad_y)}" fill="${c.col(s.style.color)}"/>`);
  return h;
}

// A check mark in a ring: a fixed vector, part of the design.
function checkIcon(c: Ctx, x: number, y: number, size: number, color: ColorToken): void {
  const r = size / 2, cx = x + r, cy = y + r, sw = Math.max(2, size / 11);
  c.body.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r - sw / 2)}" fill="none" stroke="${c.col(color)}" stroke-width="${n(sw)}"/>`);
  c.body.push(`<path d="M${n(cx - r * 0.42)} ${n(cy + r * 0.02)} L${n(cx - r * 0.1)} ${n(cy + r * 0.34)} L${n(cx + r * 0.46)} ${n(cy - r * 0.3)}" fill="none" stroke="${c.col(color)}" stroke-width="${n(sw * 1.15)}" stroke-linecap="round" stroke-linejoin="round"/>`);
}

function drawList(c: Ctx, s: ListSlot, items: Line[], x: number, y: number): number {
  const font = c.engine.fonts[s.style.font];
  const tx = x + s.icon.size + s.icon.gap;
  const tw = s.w - s.icon.size - s.icon.gap;
  let cy = y;
  items.forEach((it, i) => {
    const laid = layout(font, it.text, s.style, tw, s.max_lines_each, s.slot);
    const h = Math.max(s.icon.size, laid.height);
    checkIcon(c, x, cy + (Math.min(s.style.line_height, h) - s.icon.size) / 2, s.icon.size, s.icon.color);
    laid.lines.forEach((l, j) => {
      c.body.push(`<path d="${linePath(font, l.text, s.style, tx, cy + j * s.style.line_height)}" fill="${c.col(s.style.color)}"/>`);
    });
    cy += h + (i + 1 < items.length ? s.item_gap : 0);
  });
  return cy - y;
}

// Heights first (every refusal happens before anything is drawn), then the
// stack is placed at its anchor inside [y, max_bottom].
function itemHeight(c: Ctx, it: Stack["items"][number], text: Map<string, Line>, lists: Record<string, Line[]>, w: number): number | null {
  if (it.type === "list") {
    const items = lists[it.slot];
    if (!items?.length) return null;
    const font = c.engine.fonts[it.style.font];
    const tw = Math.min(it.w, w) - it.icon.size - it.icon.gap;
    return items.reduce((sum, l, i) =>
      sum + Math.max(it.icon.size, layout(font, l.text, it.style, tw, it.max_lines_each, it.slot).height) + (i ? it.item_gap : 0), 0);
  }
  const l = text.get(it.slot);
  if (!l) return null;
  const font = c.engine.fonts[it.style.font];
  if (it.type === "pill") {
    layout(font, l.text, it.style, it.max_w - 2 * it.pad_x, 1, it.slot);
    return it.style.line_height + 2 * it.pad_y;
  }
  return layout(font, l.text, it.style, Math.min(it.w, w), it.max_lines, it.slot).height;
}

function drawStack(c: Ctx, st: Stack, text: Map<string, Line>, lists: Record<string, Line[]>): void {
  const present = st.items.map((it) => ({ it, h: itemHeight(c, it, text, lists, st.w) })).filter((x) => x.h !== null) as
    { it: Stack["items"][number]; h: number }[];
  const total = present.reduce((s, x, i) => s + x.h + (i ? st.gap : 0), 0);
  const room = st.max_bottom - st.y;
  if (total > room) {
    const last = present[present.length - 1]?.it.slot ?? "";
    throw new CopyRefusal("copy_does_not_fit",
      `The copy runs ${Math.ceil(total - room)} px past its area (through ${last}). Use shorter governed lines.`, last);
  }
  const anchor = st.anchor ?? "top";
  let y = anchor === "bottom" ? st.max_bottom - total : anchor === "center" ? st.y + Math.round((room - total) / 2) : st.y;
  for (const { it, h } of present) {
    if (it.type === "list") drawList(c, { ...it, w: Math.min(it.w, st.w) }, lists[it.slot], st.x, y);
    else if (it.type === "pill") drawPill(c, it, text.get(it.slot)!.text, st.x, y);
    else drawText(c, { ...it, w: Math.min(it.w, st.w) }, text.get(it.slot)!.text, st.x, y);
    y += h + st.gap;
  }
}

function drawPhoto(c: Ctx, e: Extract<Element, { type: "photo" }>, bytes: Uint8Array, p: Plan["photos"][number]): void {
  const mime = sniff(bytes);
  const id = `clip${c.clip++}`;
  const r = e.radius ?? 0;
  c.defs.push(`<clipPath id="${id}"><rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="${r}"/></clipPath>`);
  const { x, y, w, h } = p.crop;
  c.body.push(`<g clip-path="url(#${id})"><svg x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" viewBox="${x} ${y} ${w} ${h}" preserveAspectRatio="xMidYMid slice">` +
    `<image width="${p.asset.width}" height="${p.asset.height}" preserveAspectRatio="none" href="data:${mime};base64,${bytesToB64(bytes)}"/></svg></g>`);
  if (e.keyline) {
    const k = e.keyline.width;
    c.body.push(`<rect x="${n(e.x + k / 2)}" y="${n(e.y + k / 2)}" width="${n(e.w - k)}" height="${n(e.h - k)}" rx="${r}" fill="none" stroke="${c.col(e.keyline.color)}" stroke-width="${k}"/>`);
  }
}

function drawLogo(c: Ctx, e: Extract<Element, { type: "logo" }>, bytes: Uint8Array, dims: { width: number; height: number }): void {
  const mime = sniff(bytes);
  const k = e.keyline.width;
  c.body.push(`<rect x="${n(e.x + k / 2)}" y="${n(e.y + k / 2)}" width="${n(e.w - k)}" height="${n(e.h - k)}" rx="${e.radius}" fill="${c.col(e.fill)}" stroke="${c.col(e.keyline.color)}" stroke-width="${k}"/>`);
  const iw = e.w - 2 * e.pad, ih = e.h - 2 * e.pad;
  const s = Math.min(iw / dims.width, ih / dims.height);
  const w = dims.width * s, h = dims.height * s;
  c.body.push(`<image x="${n(e.x + (e.w - w) / 2)}" y="${n(e.y + (e.h - h) / 2)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none" href="data:${mime};base64,${bytesToB64(bytes)}"/>`);
}

export function composeSvg(spec: TemplateSpec, engine: Engine, p: Plan, bytes: Map<string, Uint8Array>): string {
  const c: Ctx = { spec, engine, col: (t) => spec.palette[t], defs: [], body: [], clip: 0 };
  const { width: W, height: H } = spec.canvas;
  c.body.push(`<rect width="${W}" height="${H}" fill="${c.col(spec.canvas.background)}"/>`);
  const text = new Map(p.lines.map((l) => [l.slot, l]));
  for (const e of spec.elements) {
    switch (e.type) {
      case "rect":
        c.body.push(`<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}"${e.radius ? ` rx="${e.radius}"` : ""} fill="${c.col(e.fill)}"/>`);
        break;
      case "photo": {
        const pp = p.photos.find((x) => x.slot === e.slot && x.index === e.index)!;
        drawPhoto(c, e, bytes.get(pp.asset.content_hash!)!, pp);
        break;
      }
      case "logo":
        drawLogo(c, e, bytes.get(p.logo.content_hash!)!, { width: p.logo.width ?? 1, height: p.logo.height ?? 1 });
        break;
      case "stack":
        drawStack(c, e, text, p.lists);
        break;
      case "text": {
        const l = text.get(e.slot);
        if (l) drawText(c, e, l.text, e.x, e.y);
        break;
      }
      case "pill": {
        const l = text.get(e.slot);
        if (l) drawPill(c, e, l.text, e.x, e.y);
        break;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>${c.defs.join("")}</defs>${c.body.join("")}</svg>`;
}

// PNG sanity: signature, IHDR size, and every chunk's CRC.
export function checkPng(png: Uint8Array, w: number, h: number): void {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => png[i] === b)) throw new Error("render is not a PNG");
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (dv.getUint32(16) !== w || dv.getUint32(20) !== h) throw new Error("render has the wrong size");
  const table = Array.from({ length: 256 }, (_, k) => {
    let c = k;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let off = 8, sawEnd = false;
  while (off < png.length) {
    const len = dv.getUint32(off);
    let crc = 0xffffffff;
    for (let i = off + 4; i < off + 8 + len; i++) crc = table[(crc ^ png[i]) & 0xff] ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== dv.getUint32(off + 8 + len)) throw new Error("render has a corrupt PNG chunk");
    if (String.fromCharCode(...png.subarray(off + 4, off + 8)) === "IEND") sawEnd = true;
    off += 12 + len;
  }
  if (!sawEnd || off !== png.length) throw new Error("render PNG is truncated");
}

const FAMILY_NAMES: Record<string, string> = {
  service_spotlight: "service graphic", trust_know_how: "credentials graphic", seasonal: "seasonal graphic",
  real_work: "project photo graphic", service_light: "service graphic",
};

export type Rendered = {
  png: Uint8Array;
  content_hash: string;
  width: number;
  height: number;
  size_bytes: number;
  brief: Record<string, unknown>;
  brief_hash: string;
  copy_hash: string;
  overlay: { role: string; text: string; source_id: string | null }[];
  sources: { brand_asset_id: string; role: "photo" | "logo"; source_content_hash: string; crop?: unknown; focal?: unknown }[];
  alt_text: string;
  strategy: "source_photo" | "brand_graphic";
  ms: { plan: number; compose: number; rasterize: number };
};

// The post a render is for (purpose 'post'): copy_hash is drafter_copy_hash
// of the post's copy, which creative_begin_run / creative_write check.
export type PostBinding = { id: string; copy_hash: string; creative_version: number };

// Plan, verify the source bytes, compose, rasterise, check, hash.
export async function render(engine: Engine, t: RegisteredTemplate, facts: Facts, req: RenderRequest,
  read: (asset: { id: string; storage_path: string; content_hash: string }) => Promise<Uint8Array>,
  opts: { post?: PostBinding } = {}): Promise<Rendered> {
  const t0 = performance.now();
  const hash = await specHash(t.spec);
  if (req.template.key !== t.key || req.template.version !== t.version) {
    throw new CopyRefusal("template_mismatch", `The request names ${req.template.key} v${req.template.version}; this is ${t.key} v${t.version}`);
  }
  if (req.template.spec_hash !== hash) {
    throw new CopyRefusal("template_version_mismatch", "The template's spec is not the version the request was made for");
  }
  const p = await makePlan(t.spec, facts, req, req.template.id ?? null);
  const bytes = new Map<string, Uint8Array>();
  for (const a of [...p.photos.map((x) => x.asset), p.logo]) {
    if (bytes.has(a.content_hash!)) continue;
    const b = await read({ id: a.id, storage_path: a.storage_path!, content_hash: a.content_hash! });
    if (b.byteLength > MAX_SOURCE_BYTES) throw new CopyRefusal("source_too_large", `Asset ${a.id} is over ${MAX_SOURCE_BYTES} bytes`);
    if (await sha256Hex(b) !== a.content_hash) {
      throw new CopyRefusal("source_hash_mismatch", `The stored bytes of ${a.id} no longer match its reviewed hash`);
    }
    bytes.set(a.content_hash!, b);
  }
  const t1 = performance.now();
  const svg = composeSvg(t.spec, engine, p, bytes);
  const t2 = performance.now();
  const png = engine.rasterize(svg);
  const t3 = performance.now();
  checkPng(png, t.output_width, t.output_height);
  if (png.byteLength > MAX_OUTPUT_BYTES) throw new CopyRefusal("output_too_large", `The render is ${png.byteLength} bytes`);

  const headlineFirst = [...p.lines].sort((a, b) => Number(b.slot === "headline") - Number(a.slot === "headline"));
  const overlay = [...headlineFirst, ...Object.keys(p.lists).sort().flatMap((k) => p.lists[k])]
    .map((l) => ({ role: l.role, text: l.text, source_id: l.source_id }));
  const photosBrief = p.photos.map((x) => ({
    slot: x.slot, index: x.index, role: x.role, brand_asset_id: x.asset.id, content_hash: x.asset.content_hash,
    width: x.asset.width, height: x.asset.height, focal: x.crop.focal,
    crop: { x: x.crop.x, y: x.crop.y, w: x.crop.w, h: x.crop.h, scale: x.crop.scale },
  }));
  const brief = {
    schema: BRIEF_SCHEMA,
    renderer: RENDERER_ID,
    template: { key: t.key, version: t.version, spec_hash: hash },
    client_id: facts.client.id,
    service_id: p.service_id,
    lines: p.lines, lists: p.lists,
    photos: photosBrief,
    logo: { brand_asset_id: p.logo.id, content_hash: p.logo.content_hash },
    copy_hash: p.copy_hash,
    // A post's render also binds the post: its copy (the creative is made for
    // that copy) and the creative version it replaces. Previews carry no key.
    ...(opts.post ? { post: opts.post } : {}),
  };
  const headline = p.lines.find((l) => l.slot === "headline")?.text ?? facts.client.name;
  const first = p.photos[0]?.asset;
  const alt = `${facts.client.name} ${FAMILY_NAMES[t.spec.family] ?? "graphic"}: ${headline}.` +
    (first ? ` ${p.photos.length > 1 ? "Photos" : "Photo"} of the client's own work: ${first.subjects.join(", ")}.` : "");
  return {
    png,
    content_hash: await sha256Hex(png),
    width: t.output_width,
    height: t.output_height,
    size_bytes: png.byteLength,
    brief,
    brief_hash: "sha256:" + await sha256Hex(jsonbText(brief)),
    copy_hash: p.copy_hash,
    overlay,
    sources: [
      ...p.photos.map((x) => ({ brand_asset_id: x.asset.id, role: "photo" as const, source_content_hash: x.asset.content_hash!,
        crop: { x: x.crop.x, y: x.crop.y, w: x.crop.w, h: x.crop.h }, focal: x.crop.focal })),
      { brand_asset_id: p.logo.id, role: "logo" as const, source_content_hash: p.logo.content_hash! },
    ],
    alt_text: alt,
    strategy: p.photos.length ? "source_photo" : "brand_graphic",
    ms: { plan: t1 - t0, compose: t2 - t1, rasterize: t3 - t2 },
  };
}
