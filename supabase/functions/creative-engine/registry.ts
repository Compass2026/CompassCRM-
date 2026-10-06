// The template versions this code can render: key, version, channel, output
// and spec. Registration (creative_register_template) stores exactly these;
// a changed spec is a new version, never an edit (0054 refuses both).
import { buildSpec } from "./families.ts";
import { KITS } from "./kits.ts";
import type { Channel, Family, RegisteredTemplate } from "./spec.ts";

export const FAMILY_NAMES: Record<Family, string> = {
  service_spotlight: "Service Spotlight",
  trust_know_how: "Trust & Know-How (authority)",
  seasonal: "Seasonal (non-offer)",
  real_work: "Real Work Showcase",
  service_light: "Service Light",
};
const FAMILY_KEYS: Record<Family, string> = {
  service_spotlight: "service-spotlight", trust_know_how: "trust-know-how", seasonal: "seasonal",
  real_work: "real-work", service_light: "service-light",
};
// One registered channel per canvas: the 4:5 social version is registered for
// facebook and instagram separately (0054 keys a template to one channel).
const CHANNELS: { channel: Channel; tag: string; label: string }[] = [
  { channel: "google_business", tag: "gbp", label: "Business Profile 1200×900" },
  { channel: "facebook", tag: "facebook", label: "Facebook 1080×1350" },
  { channel: "instagram", tag: "instagram", label: "Instagram 1080×1350" },
];
export const FAMILIES = Object.keys(FAMILY_KEYS) as Family[];

export function lucasTemplates(): RegisteredTemplate[] {
  const kit = KITS.lucas;
  const out: RegisteredTemplate[] = [];
  for (const family of FAMILIES) {
    for (const ch of CHANNELS) {
      const spec = buildSpec(family, ch.channel, kit);
      out.push({
        key: `${kit.slug}-${FAMILY_KEYS[family]}-${ch.tag}`,
        version: 1,
        channel: ch.channel,
        name: `Lucas ${FAMILY_NAMES[family]} — ${ch.label}`,
        description: `Deterministic ${FAMILY_NAMES[family]} layout for Lucas Construction (${ch.label}). Governed slots only.`,
        output_width: spec.canvas.width,
        output_height: spec.canvas.height,
        mime_type: "image/png",
        spec,
      });
    }
  }
  return out;
}

export function findTemplate(key: string, version: number): RegisteredTemplate | null {
  return lucasTemplates().find((t) => t.key === key && t.version === version) ?? null;
}
