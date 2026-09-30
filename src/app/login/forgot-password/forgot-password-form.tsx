"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { AUTH_CONFIRM_PATH } from "@/lib/password-recovery";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ForgotPasswordForm({
  initialEmail,
  notice,
}: {
  initialEmail: string;
  // Why an earlier reset did not save (?error=), until they send again.
  notice: string | null;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(notice);
  const [loading, setLoading] = useState(false);

  async function sendResetLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    // This deployment's own /auth/confirm (production or a Vercel preview;
    // both must be on Supabase's Redirect URLs list). The Reset Password
    // template adds ?token_hash=…&type=recovery, so the link works in any
    // browser (docs/password-recovery.md).
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${AUTH_CONFIRM_PATH}`,
    });
    setLoading(false);
    // Only a rate limit is worth showing, and it reads the same for every
    // address. Any other answer (including a failure Supabase Auth reports
    // only for a real account) shows the same confirmation and is not
    // logged, so the page never reveals who has an account.
    if (error?.status === 429) {
      setError("Too many requests. Wait a few minutes and try again.");
      return;
    }
    setSent(true);
  }

  return (
    <AuthCard description="Reset your password">
      {sent ? (
        <div className="space-y-4 text-sm">
          <p>
            If <span className="font-medium">{email}</span> has an account, a
            link to set a new password is on its way. It works once, on any
            device, and expires after an hour.
          </p>
          <Link
            href="/login"
            className="font-medium underline-offset-4 hover:underline"
          >
            Back to sign-in
          </Link>
        </div>
      ) : (
        <form onSubmit={sendResetLink} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@compassmarketing.ai"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Sending…" : "Email me a reset link"}
          </Button>
          <Link
            href="/login"
            className="block text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Back to sign-in
          </Link>
        </form>
      )}
    </AuthCard>
  );
}
