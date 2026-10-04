import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { creativeFileName } from "@/lib/creative-post";

export const dynamic = "force-dynamic";

// One recorded creative (creative_assets), read from the private
// creative-assets bucket with the teammate's own session (team-only read
// policy). The bytes are re-hashed and refused if they are not the recorded
// content hash, so what a teammate downloads is exactly what was approved.
// ?download=1 saves it as a file; otherwise it is shown inline.
export async function GET(req: NextRequest, { params }: { params: Promise<{ clientId: string; assetId: string }> }) {
  const { clientId, assetId } = await params;
  if (!isUuid(clientId) || !isUuid(assetId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const supabase = await createClient();
  if (!(await getCurrentTeamMember(supabase))) return NextResponse.json({ error: "team members only" }, { status: 403 });
  const { data: a } = await supabase
    .from("creative_assets")
    .select("id, storage_path, content_hash, mime_type, creative_templates(key), clients(name)")
    .eq("id", assetId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (!a) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { data: file, error } = await supabase.storage.from("creative-assets").download(a.storage_path);
  if (error || !file) return NextResponse.json({ error: "the file could not be read" }, { status: 502 });
  const bytes = Buffer.from(await file.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== a.content_hash) {
    return NextResponse.json({ error: "the stored file is not the recorded creative" }, { status: 409 });
  }
  const name = creativeFileName(a.clients?.name ?? "client", a.creative_templates?.key ?? null, a.content_hash);
  const download = req.nextUrl.searchParams.get("download") === "1";
  return new NextResponse(bytes, {
    headers: {
      "content-type": a.mime_type,
      "cache-control": "private, max-age=3600, immutable",
      "x-creative-content-hash": a.content_hash,
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
    },
  });
}
