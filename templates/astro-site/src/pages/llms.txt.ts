import type { APIRoute } from "astro";
import { site } from "../config/site";

// GEO: a plain-text summary generative engines can read without rendering.
export const GET: APIRoute = () => {
  const b = site.business;
  const abs = (p: string) => new URL(p, site.url).toString();
  const lines = [
    `# ${b.name}`,
    ``,
    `> ${site.brand.positioning}`,
    ``,
    `Phone: ${b.phone}`,
    b.address ? `Based in: ${b.address.city}, ${b.address.region}` : `Service-area business`,
    `Serves: ${b.serviceArea.join(", ")}`,
    ``,
    `## Services`,
    ...site.services.map((s) => `- [${s.name}](${abs(`/services/${s.slug}/`)}): ${s.answer}`),
    ``,
    `## Service area`,
    ...site.cities.map((c) => `- [${c.name}](${abs(`/areas/${c.slug}/`)}): ${c.answer}`),
    ``,
    `## Facts (sourced)`,
    ...site.facts.map((f) => `- ${f.label}: ${f.value} (${f.source})`),
    ``,
    `## Pages`,
    `- [About](${abs("/about/")})`,
    `- [Contact](${abs("/contact/")})`,
    ``,
  ];
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
