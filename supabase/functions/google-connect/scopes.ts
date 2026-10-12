// Analytics Admin access (analytics.edit) does not authorize Data API reports.
export const SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
  "https://www.googleapis.com/auth/analytics.edit",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/analytics.readonly",
  "openid",
  "email",
];
export function missingGoogleScopes(granted: string[]): string[] {
  return SCOPES.filter(scope => scope !== "openid" && scope !== "email")
    .filter(scope => !granted.includes(scope) && !(scope === "https://www.googleapis.com/auth/analytics.readonly" && granted.includes("https://www.googleapis.com/auth/analytics")));
}
