"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { UPDATE_PASSWORD_PATH } from "@/lib/password-recovery";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ForgotPasswordForm({ initialEmail }: { initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function sendResetLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    // PKCE: the link comes back to /auth/confirm with a code this browser
    // exchanges for a recovery session, then lands on /update-password.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent(UPDATE_PASSWORD_PATH)}`,
    });
    setLoading(false);
    // Only a rate limit is worth showing: any other answer reads the same
    // whether or not the address has an account, so the page never reveals
    // who does.
    if (error && error.status === 429) {
      setError("Too many requests. Wait a few minutes and try again.");
      return;
    }
    if (error) console.error("resetPasswordForEmail", error.message);
    setSent(true);
  }

  return (
    <AuthCard description="Reset your password">
      {sent ? (
        <div className="space-y-4 text-sm">
          <p>
            If <span className="font-medium">{email}</span> has an account, a
            link to set a new password is on its way. Open it in this browser;
            it expires after an hour.
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
          {error && <p className="text-sm text-destructive">{error}</p>}
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
