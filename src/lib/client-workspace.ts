import type { InquiryRow } from "./inquiries-data";
import type { InquiryStatus } from "./inquiries";

// A website label is a display value from an already-authorized inquiry,
// never a client identifier or an authorization decision.
export function inquiryWebsite(url: string | null): string {
  try {
    const parsed = new URL(url ?? "");
    return ["https:", "http:"].includes(parsed.protocol)
      ? parsed.hostname.toLowerCase().replace(/^www\./, "")
      : "Website not recorded";
  } catch {
    return "Website not recorded";
  }
}

export function workspaceSummary(rows: InquiryRow[], now: number) {
  const statuses: Record<InquiryStatus, number> = {
    new: 0,
    contacted: 0,
    closed: 0,
  };
  const websites: Record<string, number> = {};
  let lastSevenDays = 0;
  for (const row of rows) {
    statuses[row.status]++;
    const website = inquiryWebsite(row.page_url);
    websites[website] = (websites[website] ?? 0) + 1;
    const received = Date.parse(row.received_at);
    if (received <= now && received >= now - 7 * 86400000) lastSevenDays++;
  }
  return { statuses, websites, lastSevenDays, total: rows.length };
}

export function filterWorkspace(
  rows: InquiryRow[],
  query: string,
  status: string,
  website: string,
) {
  const q = query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (!status || row.status === status) &&
      (!website || inquiryWebsite(row.page_url) === website) &&
      (!q ||
        [
          row.name,
          row.email,
          row.phone,
          row.phone_e164,
          row.service_type,
          row.message,
        ].some((value) => value?.toLocaleLowerCase().includes(q))),
  );
}
