import { CheckoutMessage } from "../checkout-message";

export const metadata = { title: "Thank you — Compass Marketing Advisors", robots: { index: false } };

export default function CheckoutCompletePage() {
  return (
    <CheckoutMessage title="Thank you">
      <p>Your details were submitted to Stripe, our payment processor.</p>
      <p>
        Card payments are confirmed within moments. Bank (ACH) payments take a few business days to clear;
        Stripe will email your receipt once they do.
      </p>
      <p>You can close this page.</p>
    </CheckoutMessage>
  );
}
