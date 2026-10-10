"use client";

import { useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function PasswordChangeForm() {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<"save" | "code" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsCode, setNeedsCode] = useState(false);

  async function sendCode() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("code");
    setError("");
    setNotice("");
    try {
      const { error } = await createClient().auth.reauthenticate();
      if (error) setError(error.message);
      else setNotice("Verification code sent. Enter the code from your email, then save your password.");
    } catch {
      setError("Could not send the code. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    setError("");
    setNotice("");
    if (password !== values.get("confirmation")) {
      setError("Your passwords do not match. Please enter them again.");
      return;
    }
    inFlight.current = true;
    setBusy("save");
    try {
      const currentPassword = String(values.get("currentPassword") ?? "");
      const nonce = String(values.get("nonce") ?? "").trim();
      // Submit credentials only to Supabase from this signed-in browser.
      const { error } = await createClient().auth.updateUser({
        password,
        ...(currentPassword ? { current_password: currentPassword } : {}),
        ...(nonce ? { nonce } : {}),
      });
      if (error) {
        if (["reauthentication_needed", "reauth_nonce_missing", "reauthentication_not_valid"].includes(error.code ?? "")) {
          setNeedsCode(true);
          setError("Please verify your email before changing your password. Send a verification code below.");
        } else {
          setError(error.message);
        }
        return;
      }
      form.reset();
      setNeedsCode(false);
      setNotice("Password updated. You can now sign in with your email and new password in another browser.");
    } catch {
      setError("Could not update your password. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <form onSubmit={savePassword} className="space-y-5" aria-busy={busy !== null}>
      <fieldset disabled={busy !== null} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="new-password">New password</Label>
          <Input id="new-password" name="password" type="password" autoComplete="new-password" minLength={12} required aria-describedby="password-help" />
          <p id="password-help" className="text-xs text-muted-foreground">Use at least 12 characters. Your password manager can generate and save one.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-password">Confirm new password</Label>
          <Input id="confirm-password" name="confirmation" type="password" autoComplete="new-password" minLength={12} required />
        </div>
        <details className="space-y-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">Current password, if required</summary>
          <Label htmlFor="current-password">Current password</Label>
          <Input id="current-password" name="currentPassword" type="password" autoComplete="current-password" />
          <p className="text-xs text-muted-foreground">Leave this blank if you signed in with a magic link. If prompted for your current password, enter it here.</p>
        </details>
        {needsCode ? (
          <div className="space-y-3 rounded-lg border p-4">
            <Button type="button" variant="outline" onClick={sendCode} loading={busy === "code"} loadingLabel="Sending code…">Send verification code</Button>
            <Label htmlFor="verification-code">Email verification code</Label>
            <Input id="verification-code" name="nonce" autoComplete="one-time-code" required />
          </div>
        ) : null}
      </fieldset>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p> : null}
      <Button type="submit" disabled={busy !== null} loading={busy === "save"} loadingLabel="Saving password…">Save password</Button>
    </form>
  );
}
