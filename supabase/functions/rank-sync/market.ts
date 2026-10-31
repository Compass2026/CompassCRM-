// Until national rank locations are supported, never turn an online store's
// mailing city into its search market or collect it as national evidence.
export function localRankBlock(businessType: string | null | undefined): string | null {
  return businessType === "ecommerce"
    ? "National e-commerce rank tracking is not configured; no city fallback used."
    : null;
}
