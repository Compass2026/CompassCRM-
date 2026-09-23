import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Where the app layout sends a sign-in that is not a team member: end the
// session (a layout render cannot write cookies) and go back to /login.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login?error=not_team", request.url));
}
