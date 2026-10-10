"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
export function PaymentContinue({ token }: { token: string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function open() {
    setPending(true); setMessage("Opening secure payment…");
    try {
      const res = await fetch(`/pay/${token}/open`, { method: "POST" });
      const result = await res.json();
      if (res.ok && typeof result.url === "string" && /^https:\/\/checkout\.stripe\.com\//.test(result.url)) { window.location.assign(result.url); return; }
      setMessage(result.detail ?? "Could not open payment. Please try again or contact Compass.");
    } catch { setMessage("Could not open payment. Please try again shortly."); }
    setPending(false);
  }
  return <div className="space-y-3"><Button type="button" disabled={pending} onClick={open}>{pending ? "Opening…" : "Continue to secure payment"}</Button><p role="status" aria-live="polite" className="text-sm">{message}</p></div>;
}
