"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CONSENT_TEXT } from "@/lib/agreements";

export function SignAgreement({
  token,
  verified,
  contentHash,
  recipientName,
}: {
  token: string;
  verified: boolean;
  contentHash?: string | null;
  recipientName?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  async function run(action: string, values: Record<string, unknown> = {}) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/sign/${token}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...values }),
      });
      const result = await res.json();
      if (!res.ok || result.error) {
        setError(
          result.error ||
            "The action could not be completed. Please try again.",
        );
        return;
      }
      if (action === "code") {
        setSent(true);
        setNotice(
          "Verification code sent to the email address selected by the sender.",
        );
      } else {
        setNotice(result.notice || "Saved.");
        router.refresh();
      }
    } catch {
      setError(
        "Connection interrupted. Reload to check the agreement status before trying again.",
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="rounded-xl border bg-white p-6 text-slate-900 shadow-sm">
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mb-4 rounded-lg bg-green-50 p-3 text-sm text-green-900"
        >
          {notice}
        </p>
      )}
      {!verified ? (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Verify your email</h2>
          <p className="text-sm text-slate-600">
            We’ll send a code to the recipient email on this agreement. You can
            then review the complete terms before deciding whether to sign.
          </p>
          <Button
            type="button"
            onClick={() => run("code")}
            loading={busy === "code"}
            loadingLabel="Sending code…"
            disabled={!!busy}
          >
            {sent ? "Request another code" : "Email verification code"}
          </Button>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run("verify", {
                code: new FormData(e.currentTarget).get("code"),
              });
            }}
          >
            <label className="block text-sm">
              Six-digit code
              <Input
                name="code"
                required
                pattern="[0-9]{6}"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="mt-2"
              />
            </label>
            <Button
              type="submit"
              loading={busy === "verify"}
              loadingLabel="Verifying…"
              disabled={!!busy}
            >
              Verify and review agreement
            </Button>
          </form>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            void run("sign", {
              name: form.get("name"),
              consent: form.get("consent") === "on",
              content_hash: contentHash,
            });
          }}
        >
          <h2 className="text-lg font-semibold">Sign this agreement</h2>
          <p className="text-sm text-slate-600">
            Read the complete agreement above. Contact the sender if you need
            changes, a paper copy, or another way to sign.
          </p>
          <label className="block text-sm font-medium">
            Your full name as your electronic signature
            <Input
              name="name"
              required
              minLength={2}
              maxLength={160}
              autoComplete="name"
              defaultValue={recipientName}
              className="mt-2"
            />
          </label>
          <label className="flex items-start gap-3 text-sm leading-6">
            <input type="checkbox" name="consent" required className="mt-1.5" />
            {CONSENT_TEXT}
          </label>
          <Button
            type="submit"
            loading={busy === "sign"}
            loadingLabel="Saving signature…"
            disabled={!!busy}
          >
            Agree and sign
          </Button>
          <Button
            type="button"
            variant="outline"
            loading={busy === "decline"}
            loadingLabel="Declining…"
            disabled={!!busy}
            onClick={() => run("decline")}
          >
            Decline agreement
          </Button>
        </form>
      )}
    </section>
  );
}
