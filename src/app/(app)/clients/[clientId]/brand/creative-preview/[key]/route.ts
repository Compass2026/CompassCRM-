import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamMember } from "@/lib/team";
import { previewEngine, previewReader } from "@/lib/creative-preview";
import { render } from "../../../../../../../../supabase/functions/creative-engine/render.ts";
import { findTemplate } from "../../../../../../../../supabase/functions/creative-engine/registry.ts";
import { lucasPreviewRefs } from "../../../../../../../../supabase/functions/creative-engine/previews.ts";
import { KITS } from "../../../../../../../../supabase/functions/creative-engine/kits.ts";
import { specHash } from "../../../../../../../../supabase/functions/creative-engine/spec.ts";
import { CopyRefusal } from "../../../../../../../../supabase/functions/creative-engine/text.ts";

export const dynamic = "force-dynamic";

// One preview image, rendered on request from the governed record with the
// teammate's own session. Read-only: nothing is stored or recorded.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ clientId: string; key: string }> }) {
  const { clientId, key } = await params;
  const supabase = await createClient();
  if (!(await getCurrentTeamMember(supabase))) return NextResponse.json({ error: "team members only" }, { status: 403 });
  const kit = Object.values(KITS).find((k) => k.client_id === clientId);
  const t = findTemplate(key, 1);
  const refs = lucasPreviewRefs(key);
  if (!kit || !t || !refs || t.spec.logo_asset_id !== kit.logo_asset_id) {
    return NextResponse.json({ error: "no preview for this client and template" }, { status: 404 });
  }
  const { facts, read } = previewReader(supabase);
  const f = await facts(clientId);
  if (!f) return NextResponse.json({ error: "no such client" }, { status: 404 });
  try {
    const r = await render(await previewEngine(), t, f,
      { template: { key: t.key, version: t.version, spec_hash: await specHash(t.spec) }, client_id: clientId, ...refs },
      (a) => read(a.storage_path));
    return new NextResponse(Buffer.from(r.png), {
      headers: {
        "content-type": "image/png",
        "cache-control": "private, no-store",
        "x-creative-content-hash": r.content_hash,
        "x-creative-brief-hash": r.brief_hash,
        "x-creative-copy-hash": r.copy_hash,
        "content-disposition": `inline; filename="${t.key}-preview-${r.content_hash.slice(0, 12)}.png"`,
      },
    });
  } catch (e) {
    if (e instanceof CopyRefusal) {
      return NextResponse.json({ status: "refused", code: e.code, message: e.message, slot: e.slot ?? null }, { status: 409 });
    }
    throw e;
  }
}
