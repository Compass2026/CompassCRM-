import Link from "next/link";
import { PasswordChangeForm } from "@/components/password-change-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PasswordPage() {
  // The app layout verifies the signed-in user and team membership.
  return (
    <div className="max-w-xl space-y-6">
      <Link href="/settings" className="text-sm text-muted-foreground underline">Back to settings</Link>
      <h1 className="page-title kicker">Change password</h1>
      <Card>
        <CardHeader>
          <CardTitle>Set your sign-in password</CardTitle>
          <p className="text-sm text-muted-foreground">Set a password here to sign in to Compass CRM from any browser.</p>
        </CardHeader>
        <CardContent><PasswordChangeForm /></CardContent>
      </Card>
    </div>
  );
}
