import type { Database } from "@/lib/database.types";

export type ClientStatus = Database["public"]["Enums"]["client_status"];
export type StageStatus = Database["public"]["Enums"]["stage_status"];
export type OwnerType = Database["public"]["Enums"]["owner_type"];
export type TaskStatus = Database["public"]["Enums"]["task_status"];
export type AccessSystem = Database["public"]["Enums"]["access_system"];
export type AccessStatus = Database["public"]["Enums"]["access_status"];
export type PipelineKey = Database["public"]["Enums"]["pipeline_key"];
export type DocumentCategory = Database["public"]["Enums"]["document_category"];

export const clientStatusStyles: Record<ClientStatus, string> = {
  launching: "bg-blue-100 text-blue-800 border-blue-200",
  active: "bg-green-100 text-green-800 border-green-200",
  paused: "bg-amber-100 text-amber-800 border-amber-200",
  offboarded: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

export const stageStatusStyles: Record<StageStatus, string> = {
  not_started: "bg-zinc-100 text-zinc-500 border-zinc-300",
  in_progress: "bg-blue-500 text-white border-blue-600",
  blocked: "bg-red-500 text-white border-red-600",
  skipped: "bg-zinc-200 text-zinc-400 border-zinc-300 line-through",
  complete: "bg-green-500 text-white border-green-600",
};

export const stageStatusLabels: Record<StageStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  skipped: "Skipped",
  complete: "Complete",
};

export const ownerLabels: Record<OwnerType, string> = {
  TOM: "TOM",
  CLAUDE: "CLAUDE",
  CLAUDE_APPROVAL: "CLAUDE+APPROVAL",
  DELEGATED: "DELEGATED",
  WAITING: "WAITING",
};

export const owners: OwnerType[] = [
  "TOM",
  "CLAUDE",
  "CLAUDE_APPROVAL",
  "DELEGATED",
  "WAITING",
];

export const accessSystemLabels: Record<AccessSystem, string> = {
  gsc: "Google Search Console",
  ga4: "GA4",
  gbp: "Google Business Profile",
  hosting: "Hosting",
  dns: "DNS",
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  crm: "CRM",
  other: "Other",
};

// Access systems shown in the Overview tracker by default (spec §6.1)
export const defaultAccessSystems: AccessSystem[] = [
  "gsc",
  "ga4",
  "gbp",
  "hosting",
  "dns",
  "meta_ads",
  "google_ads",
  "facebook",
  "instagram",
];

export const accessStatusStyles: Record<AccessStatus, string> = {
  not_needed: "bg-zinc-100 text-zinc-500 border-zinc-200",
  requested: "bg-amber-100 text-amber-800 border-amber-200",
  granted: "bg-green-100 text-green-800 border-green-200",
};

export const documentCategories: DocumentCategory[] = [
  "contract",
  "proposal",
  "brand",
  "audit",
  "report",
  "other",
];

// ── Brand board ────────────────────────────────────────────────────────────
export type BrandColorRole = Database["public"]["Enums"]["brand_color_role"];
export type BrandFontRole = Database["public"]["Enums"]["brand_font_role"];
export type BrandAssetKind = Database["public"]["Enums"]["brand_asset_kind"];

export const brandColorRoles: BrandColorRole[] = [
  "primary",
  "secondary",
  "accent",
  "neutral",
  "background",
  "text",
  "other",
];

export const brandColorRoleLabels: Record<BrandColorRole, string> = {
  primary: "Primary",
  secondary: "Secondary",
  accent: "Accent",
  neutral: "Neutral",
  background: "Background",
  text: "Text",
  other: "Other",
};

export const brandFontRoles: BrandFontRole[] = ["heading", "body", "accent", "other"];

export const brandFontRoleLabels: Record<BrandFontRole, string> = {
  heading: "Headings",
  body: "Body",
  accent: "Accent",
  other: "Other",
};

export const brandAssetKinds: BrandAssetKind[] = [
  "logo_primary",
  "logo_alt",
  "logo_icon",
  "wordmark",
  "photo",
  "website_screenshot",
  "social_post",
  "ad",
  "print",
  "pattern",
  "video",
  "other",
];

export const brandAssetKindLabels: Record<BrandAssetKind, string> = {
  logo_primary: "Primary logo",
  logo_alt: "Alternate logo",
  logo_icon: "Icon / favicon",
  wordmark: "Wordmark",
  photo: "Photo",
  website_screenshot: "Website screenshot",
  social_post: "Social post",
  ad: "Ad creative",
  print: "Print piece",
  pattern: "Pattern / texture",
  video: "Video",
  other: "Other",
};

// Kinds that render in the logo block of the board (vs. the reference gallery)
export const brandLogoKinds: BrandAssetKind[] = [
  "logo_primary",
  "logo_alt",
  "logo_icon",
  "wordmark",
];
