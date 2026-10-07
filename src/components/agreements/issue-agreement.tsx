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
  ready,
}: {
  clientId: string;
  id: string;
  providerName: string;
  issued: boolean;
  ready: boolean;
}) {
  const [result, action] = useActionState(
    issueContractAction.bind(null, clientId, id),
    {} as IssueResult,
  );
  const [emailResult, setEmailResult] = useState<IssueResult>({});
  const [emailPending, startEmail] = useTransition();
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
      {result.url && (
        <div className="space-y-3 rounded-lg bg-green-50 p-4 text-sm text-green-900">
          <p role="status">{result.notice}</p>
          <input
            aria-label="Signing link"
            readOnly
            value={result.url}
            className="w-full rounded border bg-white p-2"
          />
          <div className="flex flex-wrap gap-2">
            <CopyLinkButton url={result.url} label="Copy signing link" />
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
                      result.url!.split("/").pop()!,
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
