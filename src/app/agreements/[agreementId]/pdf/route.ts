import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamMember } from "@/lib/team";
import { agreementStaff, sealedAgreementPdf } from "@/lib/agreements-server";
import type { Contract } from "@/lib/agreements";
export const runtime = "nodejs";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ agreementId: string }> },
) {
  const supabase = await createClient();
  const me = await getCurrentTeamMember(supabase);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!me || !user) return new Response("Unauthorized", { status: 401 });
  try {
    const { agreementId } = await params;
    const c = await agreementStaff<Contract>(user.id, "read", {
      id: agreementId,
    });
    const pdf = await sealedAgreementPdf(c, { actor: user.id });
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="agreement-${c.id}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Signed agreement unavailable", { status: 404 });
  }
}
