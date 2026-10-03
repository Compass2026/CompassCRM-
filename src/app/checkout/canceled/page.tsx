import { CheckoutMessage } from "../checkout-message";

export const metadata = { title: "Payment not completed — Compass Marketing Advisors", robots: { index: false } };

export default function CheckoutCanceledPage() {
  return (
    <CheckoutMessage title="Payment not completed">
      <p>Nothing was charged. You can reopen the payment link we sent you while it is still valid, or reply to our email for a new one.</p>
    </CheckoutMessage>
  );
}
