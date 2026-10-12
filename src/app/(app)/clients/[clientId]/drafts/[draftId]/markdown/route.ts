import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { toMarkdown } from "../../../../../../../../supabase/functions/content-drafter/markdown.ts";

export const dynamic = "force-dynamic";

// The draft as a Markdown file (Download .md), read with the teammate's own
// session. ?download=1 saves it; otherwise it is shown as text.
export async function GET(req: NextRequest, { params }: { params: Promise<{ clientId: string; draftId: string }> }) {
  const { clientId, draftId } = await params;
  if (!isUuid(clientId) || !isUuid(draftId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const supabase = await createClient();
  if (!(await getCurrentTeamMember(supabase))) return NextResponse.json({ error: "team members only" }, { status: 403 });
  const { data: d } = await supabase.from("content_drafts")
    .select("title, slug, meta_title, meta_description, h1, body_markdown, cta, primary_keyword")
    .eq("id", draftId).eq("client_id", clientId).maybeSingle();
  if (!d || !d.title) return NextResponse.json({ error: "not found" }, { status: 404 });
  const md = toMarkdown({ ...d, cta: (d.cta ?? null) as { text?: string; url?: string | null } | null });
  const name = `${d.slug || "draft"}.md`;
  return new NextResponse(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "private, no-store",
      "content-disposition": `${req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${name}"`,
    },
  });
}
