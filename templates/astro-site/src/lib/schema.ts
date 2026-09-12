import { site } from "../config/site";
import type { Faq, Service, City } from "../config/types";

const abs = (path: string) => new URL(path, site.url).toString();

export function localBusiness() {
  const b = site.business;
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": b.schemaType,
    "@id": abs("/#business"),
    name: b.name,
    url: site.url,
    telephone: b.phone,
    areaServed: b.serviceArea.map((name) => ({ "@type": "City", name })),
    sameAs: b.sameAs,
  };
  if (b.email) node.email = b.email;
  if (b.logo) node.logo = abs(b.logo);
  if (b.priceRange) node.priceRange = b.priceRange;
  if (b.hours?.length) node.openingHours = b.hours;
  if (b.address) {
    node.address = {
      "@type": "PostalAddress",
      ...(b.address.street ? { streetAddress: b.address.street } : {}),
      addressLocality: b.address.city,
      addressRegion: b.address.region,
      ...(b.address.postal ? { postalCode: b.address.postal } : {}),
      addressCountry: b.address.country ?? "US",
    };
  }
  return node;
}

export function service(s: Service, path: string) {
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": abs(path + "#service"),
    name: s.name,
    serviceType: s.name,
    description: s.description,
    url: abs(path),
    provider: { "@id": abs("/#business") },
    areaServed: site.business.serviceArea.map((name) => ({ "@type": "City", name })),
  };
}

export function cityService(c: City, path: string) {
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": abs(path + "#service"),
    name: `${site.business.name} — ${c.name}`,
    serviceType: c.primaryKeyword,
    description: c.description,
    url: abs(path),
    provider: { "@id": abs("/#business") },
    areaServed: { "@type": "City", name: c.name },
  };
}

export function faqPage(faqs: Faq[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

export function breadcrumbs(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: abs(it.path),
    })),
  };
}
