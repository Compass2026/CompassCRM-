import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  // Cookie-authenticated browser writes must originate on this exact host.
  if (req.headers.get("origin") !== req.nextUrl.origin)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const raw = await req.text();
  if (raw.length > 20000)
    return NextResponse.json({ error: "request_too_large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/client-phone`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...body, origin: req.nextUrl.origin }),
        cache: "no-store",
        signal: AbortSignal.timeout(55000),
      },
    );
    const data = await response
      .json()
      .catch(() => ({ error: "service_unavailable" }));
    return NextResponse.json(data, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "request_uncertain_refresh" },
      { status: 504 },
    );
  }
}
