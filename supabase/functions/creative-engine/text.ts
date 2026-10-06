// Text for the Creative Engine: measured and drawn from the pinned font
// files glyph by glyph (opentype.js), then emitted as SVG paths, so the
// rasteriser never shapes text itself and the same words give the same
// pixels everywhere. Copy that does not fit its box at the spec's size is
// refused; it is never shrunk, squeezed or cut.
import type { TextStyle } from "./spec.ts";

// The slice of opentype.js the engine uses (1.3.4, pinned).
export type OtPath = { toPathData(decimals: number): string };
export type OtGlyph = { index: number; advanceWidth: number; getPath(x: number, y: number, size: number): OtPath };
export type OtFont = {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  charToGlyph(c: string): OtGlyph;
  getKerningValue(a: OtGlyph, b: OtGlyph): number;
};

export class CopyRefusal extends Error {
  code: string;
  slot?: string;
  constructor(code: string, message: string, slot?: string) {
    super(message);
    this.code = code;
    this.slot = slot;
  }
}

export function displayText(text: string, style: Pick<TextStyle, "transform">): string {
  return style.transform === "uppercase" ? text.toUpperCase() : text;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function glyphs(font: OtFont, text: string, slot: string): OtGlyph[] {
  return [...text].map((c) => {
    const g = font.charToGlyph(c);
    if (!g || g.index === 0) {
      throw new CopyRefusal("unsupported_character", `"${c}" is not in the pinned font`, slot);
    }
    return g;
  });
}

export function measure(font: OtFont, text: string, style: TextStyle, slot = ""): number {
  const s = style.size / font.unitsPerEm;
  const gs = glyphs(font, text, slot);
  let w = 0;
  gs.forEach((g, i) => {
    w += g.advanceWidth * s;
    if (i + 1 < gs.length) w += font.getKerningValue(g, gs[i + 1]) * s + (style.tracking ?? 0);
  });
  return w;
}

export type Laid = { lines: { text: string; width: number }[]; height: number };

// Greedy word wrap at the fixed size. Refuses when a word is wider than the
// box or the text needs more lines than the slot allows.
export function layout(font: OtFont, raw: string, style: TextStyle, width: number, maxLines: number, slot: string): Laid {
  const text = displayText(raw.trim().replace(/\s+/g, " "), style);
  const words = text.split(" ");
  const lines: { text: string; width: number }[] = [];
  let cur = "";
  for (const word of words) {
    const wWord = measure(font, word, style, slot);
    if (wWord > width) {
      throw new CopyRefusal("copy_does_not_fit", `"${word}" is wider than the ${slot} box at ${style.size}px`, slot);
    }
    const next = cur ? `${cur} ${word}` : word;
    if (cur && measure(font, next, style, slot) > width) {
      lines.push({ text: cur, width: measure(font, cur, style, slot) });
      cur = word;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push({ text: cur, width: measure(font, cur, style, slot) });
  if (lines.length > maxLines) {
    throw new CopyRefusal("copy_does_not_fit",
      `${slot} needs ${lines.length} lines at ${style.size}px; the layout allows ${maxLines}. Use a shorter governed line.`, slot);
  }
  return { lines, height: lines.length * style.line_height };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// One SVG path per line; the baseline centres the font's ascender-descender
// box in the line box. x is the line's left edge after alignment.
export function linePath(font: OtFont, text: string, style: TextStyle, x: number, top: number): string {
  const s = style.size / font.unitsPerEm;
  const box = (font.ascender - font.descender) * s;
  const baseline = top + (style.line_height - box) / 2 + font.ascender * s;
  const gs = glyphs(font, text, "");
  let pen = x;
  const parts: string[] = [];
  gs.forEach((g, i) => {
    const d = g.getPath(r2(pen), r2(baseline), style.size).toPathData(2);
    if (d) parts.push(d);
    pen += g.advanceWidth * s;
    if (i + 1 < gs.length) pen += font.getKerningValue(g, gs[i + 1]) * s + (style.tracking ?? 0);
  });
  return parts.join("");
}

export function alignX(x: number, boxW: number, lineW: number, align: TextStyle["align"]): number {
  if (align === "right") return x + boxW - lineW;
  if (align === "center") return x + (boxW - lineW) / 2;
  return x;
}
