"use client";
import { useActionState, useState, useTransition } from "react";
import {
  issueContractAction,
  sendContractLinkAction,
  type IssueResult,
} from "@/app/contract-actions";
import { Button } from "@/components/ui/button";
import { CopyLinkButton } from "@/components/billing/copy-link-button";
import { Input } from "@/components/ui/input";

export function IssueAgreement({
  clientId,
  id,
  providerName,
  issued,
  origin,
  ready,
}: {
  clientId: string;
  id: string;
  providerName: string;
  issued: boolean;
  origin: string;
  ready: boolean;
}) {
  const [result, action] = useActionState(
    issueContractAction.bind(null, clientId, id),
    {} as IssueResult,
  );
  const [emailResult, setEmailResult] = useState<IssueResult>({});
  const [emailPending, startEmail] = useTransition();
  const [existingUrl, setExistingUrl] = useState("");
  let restoredUrl: string | undefined;
  try {
    const parsed = new URL(existingUrl.trim());
    if (parsed.origin === origin && /^\/sign\/[A-Za-z0-9_-]{43}$/.test(parsed.pathname) && !parsed.search && !parsed.hash)
      restoredUrl = parsed.href;
  } catch { /* A partial URL is not ready to send. */ }
  const signingUrl = result.url ?? restoredUrl;
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-4">
        {!issued && (
          <label className="block text-sm font-medium">
            Your full name, signing for Compass
            <Input
              name="provider_name"
              required
              minLength={2}
              maxLength={160}
              defaultValue={providerName}
              className="mt-2"
            />
          </label>
        )}
        <label className="flex items-start gap-3 text-sm">
          <input name="reviewed" type="checkbox" required className="mt-1" />
          {issued
            ? "Replace the signing link and invalidate the previous link and verification session."
            : "I reviewed the complete terms, scope, fee, dates, and recipient. I am authorized to sign for Compass and intend my typed name as my electronic signature."}
        </label>
        <Button type="submit" disabled={!ready} loadingLabel="Preparing link…">
          {issued ? "Replace signing link" : "Sign for Compass and create link"}
        </Button>
      </form>
      {result.error && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 p-3 text-sm text-red-800"
        >
          {result.error}
        </p>
      )}
      {issued && !result.url && (
        <div className="space-y-2 rounded-lg border p-3">
          <label className="block text-sm font-medium">
            Already copied the signing link?
            <Input type="url" value={existingUrl} onChange={(event) => { setExistingUrl(event.target.value); setEmailResult({}); }} placeholder="Paste the existing signing link" className="mt-2" />
          </label>
          <p className="text-xs text-muted-foreground">Use it here to send the branded email without replacing the link. You can preview the email below without a link.</p>
          {existingUrl && !restoredUrl && <p role="alert" className="text-xs text-red-800">Paste the complete signing link for this Compass site.</p>}
        </div>
      )}
      {signingUrl && (
        <div className="space-y-3 rounded-lg bg-green-50 p-4 text-sm text-green-900">
          <p role="status">{result.notice ?? "Existing link ready. Its validity will be checked before sending."}</p>
          <input
            aria-label="Signing link"
            readOnly
            value={signingUrl}
            className="w-full rounded border bg-white p-2"
          />
          <div className="flex flex-wrap gap-2">
            <CopyLinkButton url={signingUrl} label="Copy signing link" />
            <Button
              type="button"
              loading={emailPending}
              loadingLabel="Sending email…"
              onClick={() =>
                startEmail(async () =>
                  setEmailResult(
                    await sendContractLinkAction(
                      clientId,
                      id,
                      signingUrl.split("/").pop()!,
                    ),
                  ),
                )
              }
            >
              Email signing link
            </Button>
          </div>
          {emailResult.notice && <p role="status">{emailResult.notice}</p>}
          {emailResult.error && (
            <p role="alert" className="text-red-800">
              {emailResult.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
