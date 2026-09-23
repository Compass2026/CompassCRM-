import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type TeamMember = { id: string; name: string; email: string };

// The signed-in team member, or null for anyone else (a portal contact, a
// stranger, no session). RLS on team_members already hides the table from
// non-team sign-ins, so a null here and a refused query agree.
export async function getCurrentTeamMember(supabase: Supabase): Promise<TeamMember | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from("team_members")
    .select("id, name, email")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  return data ?? null;
}

// Server actions call this first. The app layout keeps non-team sign-ins out
// of the pages, but a server action is a public endpoint and has to check
// for itself.
export async function requireTeamMember(supabase: Supabase): Promise<TeamMember> {
  const member = await getCurrentTeamMember(supabase);
  if (!member) throw new Error("Only Compass team members can change tasks.");
  return member;
}

export async function listTeamMembers(supabase: Supabase): Promise<TeamMember[]> {
  const { data } = await supabase.from("team_members").select("id, name, email").order("name");
  return data ?? [];
}
