import { paymentLinkCall } from "@/lib/payment-links";
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "forbidden" }, { status: 403, headers });
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return Response.json({ error: "unavailable" }, { status: 410, headers });
  const answer = await paymentLinkCall({ action: "open", token });
  return Response.json(answer, { status: answer.error ? 409 : 200, headers });
}
