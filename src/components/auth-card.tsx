import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// The centred card every signed-out page uses: /login, forgot password and
// update password.
export function AuthCard({
  description,
  children,
}: {
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="relative w-full max-w-sm shadow-float">
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-600 via-orange-500 to-orange-300"
        />
        <CardHeader>
          <span className="mb-2 grid size-11 place-items-center rounded-xl bg-navy-900 shadow-[0_6px_16px_-6px_rgba(11,22,42,0.55)]">
          <svg
            viewBox="0 0 24 24"
            className="size-6 text-orange-400"
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
          </span>
          <CardTitle className="text-xl font-bold">Compass Client Platform</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}
