export type Fact = { label: string; value: string; source: string };
export type Faq = { q: string; a: string };
export type Img = { src: string; alt: string };

export type Service = {
  slug: string;
  name: string;
  primaryKeyword: string;
  /** 70–160 chars; the meta description */
  description: string;
  /** The question a searcher asks, as an H2 */
  question: string;
  /** 40–60 words, direct. This is the AEO block. */
  answer: string;
  body: string[];
  faqs: Faq[];
  facts?: Fact[];
  image?: Img | null;
};

export type City = {
  slug: string;
  name: string;
  tier: 1 | 2;
  primaryKeyword: string;
  description: string;
  question: string;
  answer: string;
  body: string[];
  faqs: Faq[];
  /** service slugs offered here; defaults to all */
  services?: string[];
};

export type Placeholder = {
  page: string;
  type: "image" | "claim" | "fact" | "project";
  description: string;
};

export type SiteConfig = {
  url: string;
  business: {
    name: string;
    /** schema.org type: LocalBusiness or a subtype such as RoofingContractor */
    schemaType: string;
    phone: string;
    email?: string;
    address?: { street?: string; city: string; region: string; postal?: string; country?: string };
    serviceArea: string[];
    sameAs: string[];
    logo?: string;
    hours?: string[];
    priceRange?: string;
  };
  brand: {
    colors: {
      ground: string;
      surface: string;
      text: string;
      muted: string;
      primary: string;
      primaryHover: string;
      accent: string;
    };
    fonts: { display: string; body: string };
    tagline: string;
    positioning: string;
    cta: { label: string; href: string };
    hardRules: string[];
  };
  facts: Fact[];
  services: Service[];
  cities: City[];
  homeFaqs: Faq[];
  about: { title: string; body: string[] };
  placeholders: Placeholder[];
  /** GA4 measurement id (G-XXXX). Null until Tracking Setup; the layout emits gtag only when set. */
  analytics?: { ga4MeasurementId: string | null };
};
