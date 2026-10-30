"use client";

import { useActionState } from "react";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-recovery";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updatePasswordAction, type UpdatePasswordState } from "./actions";

export function UpdatePasswordForm() {
  const [state, action, pending] = useActionState<UpdatePasswordState, FormData>(
    updatePasswordAction,
    null,
  );

  return (
    <AuthCard description="Set a new password">
      <form action={action} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Choose a new password for the account this reset link was sent to.
          The link works once.
        </p>
        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            autoComplete="new-password"
          />
          <p className="text-xs text-muted-foreground">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm new password</Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            autoComplete="new-password"
          />
        </div>
        {state?.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Saving…" : "Save new password"}
        </Button>
      </form>
    </AuthCard>
  );
}
