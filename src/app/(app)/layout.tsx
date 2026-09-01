import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen">
      <header className="bg-navy-900 text-cream">
        <div className="mx-auto max-w-6xl px-4 flex h-14 items-center gap-6">
          <Link
            href="/"
            className="flex items-center gap-2 font-heading font-semibold tracking-tight text-white"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-5 text-orange-400"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88" fill="currentColor" stroke="none" />
            </svg>
            Compass<span className="text-cream/60 font-normal">&nbsp;Client Platform</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/" className="text-cream/70 transition-colors hover:text-white">
              Dashboard
            </Link>
            <Link href="/clients" className="text-cream/70 transition-colors hover:text-white">
              Clients
            </Link>
            <Link href="/tasks" className="text-cream/70 transition-colors hover:text-white">
              Tasks
            </Link>
            <Link href="/settings" className="text-cream/70 transition-colors hover:text-white">
              Settings
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-cream/50 hidden sm:inline">
              {user.email}
            </span>
            <form action={signOut}>
              <Button
                variant="ghost"
                size="sm"
                type="submit"
                className="text-cream/80 hover:bg-white/10 hover:text-white"
              >
                Sign out
              </Button>
            </form>
          </div>
        </div>
        <div className="h-0.5 bg-gradient-to-r from-orange-600 via-orange-500 to-orange-400" />
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
