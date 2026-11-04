"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  checkClaimEvidenceAction,
  finalizeClaimEvidenceAction,
  prepareClaimEvidenceAction,
} from "@/app/claim-verification-actions";
import {
  EVIDENCE_TYPE_LABEL,
  formatBytes,
  formatDay,
  shortHash,
  type EvidenceType,
  type RegistryEvidence,
} from "@/lib/claim-registry";

const BUCKET = "claim-evidence";
const TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const MAX = 10 * 1024 * 1024;

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Evidence files for this client's claims (20261104200000). Any teammate may
// upload; only the verification owner cites a file in a decision. The file
// goes straight to private storage at its content address; the claim-evidence
// function then re-hashes the stored bytes and registers it. A registered file
// is never replaced or deleted.
export function ClaimEvidencePanel({
  clientId,
  evidence,
  today,
}: {
  clientId: string;
  evidence: RegistryEvidence[];
  today: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [type, setType] = useState<EvidenceType>("document");
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [checks, setChecks] = useState<Record<string, string>>({});

  function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get("file");
    const label = String(form.get("label") ?? "").trim();
    setError(null);
    setDone(null);
    if (!(file instanceof File) || file.size === 0) return setError("Choose a file.");
    if (!TYPES.includes(file.type)) return setError("Evidence must be a PDF, PNG, JPEG or WebP file.");
    if (file.size > MAX) return setError("Evidence files are up to 10 MB.");
    start(async () => {
      setStep("Hashing the file…");
      const hash = await sha256(file);
      setStep("Preparing a private upload…");
      const prep = await prepareClaimEvidenceAction(clientId, { sha256: hash, size: file.size, mimeType: file.type });
      if (!prep.ok) return (setStep(null), setError(prep.error));
      const status = prep.body.status as string;
      if (status === "exists") {
        setStep(null);
        setDone(`Already registered for this client · SHA-256 ${hash}`);
        router.refresh();
        return;
      }
      const path = String(prep.body.path);
      if (status === "upload") {
        setStep("Uploading…");
        const { error: upError } = await createClient()
          .storage.from(BUCKET)
          .uploadToSignedUrl(path, String(prep.body.token), file, { contentType: file.type });
        if (upError) return (setStep(null), setError(`The upload failed: ${upError.message}`));
      }
      setStep("Checking the stored file…");
      const fin = await finalizeClaimEvidenceAction(clientId, {
        path,
        evidenceType: type,
        label,
        originalName: file.name,
        sourceUrl: type === "capture" ? String(form.get("source_url") ?? "") : null,
        capturedOn: type === "capture" ? String(form.get("captured_on") ?? "") : null,
      });
      setStep(null);
      if (!fin.ok) return setError(fin.error);
      const ev = fin.body.evidence as { sha256: string };
      setDone(`Registered · SHA-256 ${ev.sha256}`);
      formRef.current?.reset();
      setType("document");
      router.refresh();
    });
  }

  function check(id: string) {
    setChecks((c) => ({ ...c, [id]: "Checking…" }));
    start(async () => {
      const r = await checkClaimEvidenceAction(id);
      const s = r.ok ? String(r.body.status) : null;
      setChecks((c) => ({
        ...c,
        [id]: !r.ok
          ? r.error
          : s === "intact"
            ? "The stored bytes still hash to the registered SHA-256."
            : s === "missing"
              ? "The stored file is missing."
              : "The stored bytes no longer match the registered SHA-256.",
      }));
    });
  }

  return (
    <div className="space-y-4">
      {evidence.length === 0 ? (
        <p className="text-sm text-muted-foreground">No evidence files uploaded for this client yet.</p>
      ) : (
        <ul className="divide-y rounded-xl ring-1 ring-border" aria-label="Evidence files">
          {evidence.map((e) => (
            <li key={e.id} className="space-y-1 px-3 py-2.5 text-sm" data-evidence={e.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-navy-900">{e.label}</span>
                <Badge variant="outline">{EVIDENCE_TYPE_LABEL[e.type]}</Badge>
                <Badge
                  variant="outline"
                  className={e.intact ? "bg-green-100 text-green-800 border-green-200" : "bg-red-100 text-red-800 border-red-200"}
                  data-intact={e.intact}
                >
                  {e.intact ? "stored file intact" : "stored file changed"}
                </Badge>
                <Button type="button" size="xs" variant="ghost" className="ml-auto" onClick={() => check(e.id)} data-action="check">
                  Re-check hash
                </Button>
              </div>
              <p className="text-xs break-all text-muted-foreground">
                <span title={e.sha256} data-sha256={e.sha256}>
                  SHA-256 {shortHash(e.sha256)}
                </span>
                {" · "}
                {formatBytes(e.size_bytes)} · uploaded by {e.uploaded_by_name ?? "a former teammate"} on {formatDay(e.created_at)}
                {e.source_url && (
                  <>
                    {" · captured "}
                    {formatDay(e.captured_on)} from{" "}
                    <a href={e.source_url} target="_blank" rel="noreferrer" className="text-royal-600 hover:underline">
                      {e.source_url}
                    </a>
                  </>
                )}
              </p>
              {checks[e.id] && (
                <p className="text-xs text-navy-900" role="status" data-check-result>
                  {checks[e.id]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <form ref={formRef} onSubmit={upload} className="space-y-2 rounded-lg bg-muted/40 p-3 ring-1 ring-border" data-form="evidence-upload">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="evidence-file">File (PDF, PNG, JPEG or WebP, up to 10 MB)</Label>
            <Input id="evidence-file" name="file" type="file" accept={TYPES.join(",")} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="evidence-type">What it is</Label>
            <select
              id="evidence-type"
              name="evidence_type"
              className="field w-full"
              value={type}
              onChange={(e) => setType(e.target.value as EvidenceType)}
            >
              <option value="document">Document (contract, manufacturer document, signed form, saved email)</option>
              <option value="capture">Page capture (a saved copy of a web page or listing)</option>
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="evidence-label">Label</Label>
          <Input id="evidence-label" name="label" required maxLength={200} placeholder="e.g. Signed project agreement, section 7" />
        </div>
        {type === "capture" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="evidence-url">Page address</Label>
              <Input id="evidence-url" name="source_url" type="url" required placeholder="https://" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="evidence-captured">Captured on</Label>
              <Input id="evidence-captured" name="captured_on" type="date" required defaultValue={today} max={today} />
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Files are private to the team. A Drive link or a live web address is not evidence on its own: upload the
          document, or a capture of the page.
        </p>
        <Button type="submit" size="sm" disabled={pending}>
          {pending && step ? step : "Upload evidence"}
        </Button>
        {error && (
          <p role="alert" className="text-xs font-medium text-red-800" data-upload-error>
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="text-xs break-all text-green-800" data-upload-done>
            {done}
          </p>
        )}
      </form>
    </div>
  );
}
