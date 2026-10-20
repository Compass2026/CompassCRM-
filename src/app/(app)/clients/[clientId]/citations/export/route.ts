import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { citationsEnabled } from "@/lib/citations-flag";
import { exportCsv, listingView } from "@/lib/citations-data";
import { agencyToday } from "@/lib/reporting";

export const dynamic = "force-dynamic";

// The client's listings as CSV, read with the teammate's own session.
// ?variant=client (default) never carries a hidden-address business's street;
// ?variant=internal does, marked internal only. Cells are spreadsheet-safe.
export async function GET(req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  if (!citationsEnabled()) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { clientId } = await params;
  const location = req.nextUrl.searchParams.get("location") ?? undefined;
  if (!isUuid(clientId) || (location && !isUuid(location))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const supabase = await createClient();
  if (!(await getCurrentTeamMember(supabase))) return NextResponse.json({ error: "team members only" }, { status: 403 });
  const { data: client } = await supabase.from("clients").select("id, name").eq("id", clientId).maybeSingle();
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  const variant = req.nextUrl.searchParams.get("variant") === "internal" ? "internal" : "client";
  const csv = await exportCsv(supabase, clientId, variant, location, listingView(req.nextUrl.searchParams.get("view") ?? undefined));
  if (csv === null) return NextResponse.json({ error: "export failed, retry" }, { status: 500 });
  const slug = client.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="citations-${slug}-${variant}-${agencyToday()}.csv"`,
    },
  });
}
