import type { Json } from "@/lib/database.types";

// brand_boards.palette / typography are jsonb and two shapes exist in the data:
// the reconciliation doc's array `[{role, hex, usage, source}]` (Show Me
// Electrical) and the Shewmaker load's object
// `{sourced: {name: hex}, derived: {name: hex}, rules: [], contrast: {}}`.
// These helpers render both; only the array shape is editable in the UI.

export type PaletteEntry = {
  name: string;
  hex: string;
  role?: string;
  usage?: string;
  source?: string;
};

export type TypographyEntry = { role: string; family: string; details?: string };

type Rec = { [key: string]: Json | undefined };

function isRecord(v: Json | undefined): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: Json | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function paletteEntries(palette: Json): PaletteEntry[] {
  if (Array.isArray(palette)) {
    return palette.flatMap((p) => {
      if (!isRecord(p)) return [];
      const hex = str(p.hex);
      if (!hex) return [];
      return [
        {
          hex,
          name: str(p.name) ?? str(p.role) ?? hex,
          role: str(p.role),
          usage: str(p.usage),
          source: str(p.source),
        },
      ];
    });
  }
  if (isRecord(palette)) {
    const out: PaletteEntry[] = [];
    for (const source of ["sourced", "derived"] as const) {
      const group = palette[source];
      if (!isRecord(group)) continue;
      for (const [name, hex] of Object.entries(group)) {
        if (typeof hex === "string") out.push({ name, hex, source });
      }
    }
    return out;
  }
  return [];
}

export function paletteIsEditable(palette: Json): boolean {
  return palette === null || Array.isArray(palette);
}

export function paletteRules(palette: Json): string[] {
  if (!isRecord(palette) || !Array.isArray(palette.rules)) return [];
  return palette.rules.filter((r): r is string => typeof r === "string");
}

export function paletteContrast(palette: Json): [string, string][] {
  if (!isRecord(palette) || !isRecord(palette.contrast)) return [];
  return Object.entries(palette.contrast).flatMap(([k, v]) =>
    typeof v === "string" ? [[k, v] as [string, string]] : []
  );
}

const TYPOGRAPHY_META = new Set(["notes", "source", "approved", "prohibited", "scale"]);

export function typographyEntries(typography: Json): TypographyEntry[] {
  if (!isRecord(typography)) return [];
  const out: TypographyEntry[] = [];
  for (const [role, v] of Object.entries(typography)) {
    if (TYPOGRAPHY_META.has(role)) continue;
    if (typeof v === "string") {
      out.push({ role, family: v });
    } else if (isRecord(v) && typeof v.family === "string") {
      const details = [str(v.rationale), str(v.case), str(v.delivery)]
        .filter(Boolean)
        .join(" · ");
      out.push({ role, family: v.family, details: details || undefined });
    }
  }
  return out;
}

export function typographyNotes(typography: Json): string[] {
  if (!isRecord(typography)) return [];
  const notes: string[] = [];
  for (const key of ["notes", "approved", "source"]) {
    const v = typography[key];
    if (typeof v === "string") notes.push(`${key}: ${v}`);
  }
  if (Array.isArray(typography.prohibited)) {
    const p = typography.prohibited.filter((x): x is string => typeof x === "string");
    if (p.length) notes.push(`prohibited: ${p.join(", ")}`);
  }
  return notes;
}

// The simple shape ({heading, body, accent, notes} strings) is editable in
// the UI; the structured Shewmaker shape is read-only here.
export function typographyIsSimple(typography: Json): boolean {
  if (typography === null) return true;
  if (!isRecord(typography)) return false;
  return Object.values(typography).every((v) => typeof v === "string");
}

export function typographyField(typography: Json, key: string): string {
  return isRecord(typography) ? (str(typography[key]) ?? "") : "";
}

export function driveFolderLinks(
  folders: Json
): { name: string; url: string }[] {
  if (!isRecord(folders)) return [];
  const order = ["01 Onboarding", "02 Brand", "03 Keywords", "04 Website", "05 Reports", "Media"];
  return order.flatMap((name) => {
    const id = str(folders[name]);
    return id ? [{ name, url: `https://drive.google.com/drive/folders/${id}` }] : [];
  });
}
