import { cookies } from "next/headers";
import { agreementSigner, sealedAgreementPdf } from "@/lib/agreements-server";
import type { Contract } from "@/lib/agreements";
export const runtime = "nodejs";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    const session = (await cookies()).get("agreement_session")?.value;
    const c = await agreementSigner<
      Contract & { error?: string; verified?: boolean }
    >(token, session, "read");
    if (!c.verified || c.status !== "signed")
      return new Response(
        "Verify your email to download the signed agreement.",
        { status: 403 },
      );
    const pdf = await sealedAgreementPdf(c, { token, session });
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
