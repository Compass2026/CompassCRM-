import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Where Stripe Checkout returns a client (B3). Public: the client is not a
// Compass user. Deliberately static — it reads no session, no query string
// and no data, so it can say nothing about anyone's billing. Reaching the
// success page is not proof of payment: Stripe confirms that to Compass
// through its webhook, and ACH debit settles days later.
export function CheckoutMessage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen grid place-items-center p-6">
      <Card className="max-w-md w-full">
        <CardHeader>
          <CardTitle className="text-lg">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          {children}
          <p>Compass Marketing Advisors</p>
        </CardContent>
      </Card>
    </main>
  );
}
