"use client";
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { runCitationImportAction, type ImportResult } from "@/app/citation-actions";
import { IMPORT_FIELDS, IMPORT_MAX_BYTES, guessMapping, isCredentialHeader, parseCsv, type ColumnMapping, type ImportField, type LocationMapping } from "@/lib/citations";
import { Button } from "@/components/ui/button";
import { PROVIDERS, type Option } from "@/components/citations/citation-forms";

const OUTCOME_STYLE = { added: "bg-emerald-50 text-emerald-800", updated: "bg-blue-50 text-blue-800", skipped: "bg-slate-100 text-slate-700", rejected: "bg-red-50 text-red-800" } as const;

// The file is read in the browser only to offer the column choices; the
// server parses and validates it again before anything is written.
export function CitationImport({ clientId, locations }: { clientId: string; locations: Option[] }) {
  const [importId, setImportId] = useState(() => crypto.randomUUID());
  const [file, setFile] = useState<{ name: string; text: string; rows: string[][] } | null>(null);
  const [fileError, setFileError] = useState("");
  const [provider, setProvider] = useState("manual");
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [mode, setMode] = useState<"single" | "column">("single");
  const [single, setSingle] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [createDirectories, setCreateDirectories] = useState(false);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [pending, start] = useTransition();

  const headers = file?.rows[0] ?? [];
  const credentialColumns = headers.filter(isCredentialHeader);
  const distinctLocations = useMemo(() => {
    if (!file || mapping.location === undefined) return [];
    return [...new Set(file.rows.slice(1).map((r) => (r[mapping.location!] ?? "").trim()).filter(Boolean))].sort().slice(0, 100);
  }, [file, mapping.location]);
  const locationMapping: LocationMapping = mode === "single" ? { mode, locationId: single } : { mode, values };

  async function choose(f: File | undefined) {
    setPreview(null); setDone(null); setFileError(""); setFile(null);
    if (!f) return;
    if (f.size > IMPORT_MAX_BYTES) { setFileError("The file is larger than 900 KB. Split it and import each part."); return; }
    try {
      const text = await f.text();
      const rows = parseCsv(text);
      if (rows.length < 2) throw new Error("The file needs a header row and at least one data row.");
      setFile({ name: f.name, text, rows });
      const guess = guessMapping(rows[0]);
      setMapping(guess);
      setMode(guess.location !== undefined ? "column" : "single");
      setValues({});
    } catch (e) { setFileError(e instanceof Error ? e.message : "The file could not be read."); }
  }
  function setField(field: ImportField, v: string) {
    setPreview(null);
    setMapping((m) => { const next = { ...m }; if (v === "") delete next[field]; else next[field] = Number(v); return next; });
  }
  function run(commit: boolean) {
    if (!file) return;
    start(async () => {
      const result = await runCitationImportAction(clientId, { importId, fileName: file.name, csv: file.text, provider, mapping, locations: locationMapping, createDirectories }, commit);
      if (commit && !result.error) setDone(result); else setPreview(result);
    });
  }
  function reset() { setImportId(crypto.randomUUID()); setFile(null); setPreview(null); setDone(null); setMapping({}); setValues({}); }

  if (done) return <div className="surface space-y-3 p-5" data-import-done>
    <h3 className="font-semibold">{done.already_committed ? "This import was already saved" : "Import saved"}</h3>
    <Counts r={done} />
    <Rows r={done} />
    <div className="flex gap-2"><Button variant="outline" onClick={reset}>Import another file</Button><Link className="inline-flex items-center px-3 text-sm text-blue-700 underline" href={`/clients/${clientId}/citations`}>Back to citations</Link></div>
  </div>;

  return <div className="space-y-5">
    <section className="surface space-y-3 p-5">
      <h3 className="font-semibold">1. File and source</h3>
      <p className="text-sm text-muted-foreground">A CSV with a header row, up to 5,000 rows. Columns are mapped by you; no provider format is assumed. Login, password and token columns are refused and never stored.</p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1 text-sm">CSV file<input type="file" accept=".csv,text/csv" onChange={(e) => choose(e.target.files?.[0])} className="block text-sm" /></label>
        <label className="space-y-1 text-sm">Where it came from<select className="field-sm block" value={provider} onChange={(e) => setProvider(e.target.value)}>{Object.entries(PROVIDERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      {fileError && <p role="alert" className="text-sm text-red-700">{fileError}</p>}
      {file && <p className="text-xs text-muted-foreground">{file.name}: {file.rows.length - 1} data rows, {headers.length} columns.</p>}
      {credentialColumns.length > 0 && <p className="callout text-sm" data-credential-notice>Ignored {credentialColumns.length} login-like column{credentialColumns.length > 1 ? "s" : ""} ({credentialColumns.join(", ")}). Their values are not imported or stored. Keep credentials in the approved secret store.</p>}
    </section>

    {file && <section className="surface space-y-3 p-5">
      <h3 className="font-semibold">2. Map columns</h3>
      <p className="text-sm text-muted-foreground">Exact header matches are pre-selected as a starting point. Confirm each one.</p>
      <div className="grid gap-3 sm:grid-cols-2">{(Object.keys(IMPORT_FIELDS) as ImportField[]).map((f) =>
        <label key={f} className="space-y-1 text-sm">{IMPORT_FIELDS[f].label}{IMPORT_FIELDS[f].hint && <span className="block text-xs text-muted-foreground">{IMPORT_FIELDS[f].hint}</span>}
          <select aria-label={`Column for ${IMPORT_FIELDS[f].label}`} className="field-sm block w-full" value={mapping[f] ?? ""} onChange={(e) => setField(f, e.target.value)}>
            <option value="">Not in this file</option>
            {headers.map((h, i) => isCredentialHeader(h) ? null : <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
          </select></label>)}
      </div>
    </section>}

    {file && <section className="surface space-y-3 p-5">
      <h3 className="font-semibold">3. Business locations</h3>
      <fieldset className="space-y-2 text-sm">
        <label className="flex items-center gap-2"><input type="radio" checked={mode === "single"} onChange={() => { setMode("single"); setPreview(null); }} />Every row belongs to one location</label>
        <label className="flex items-center gap-2"><input type="radio" checked={mode === "column"} onChange={() => { setMode("column"); setPreview(null); }} />A column names each row&apos;s location</label>
      </fieldset>
      {mode === "single" ? <label className="block space-y-1 text-sm">Location<select aria-label="Location for every row" className="field-sm block w-full sm:w-80" value={single} onChange={(e) => { setSingle(e.target.value); setPreview(null); }}>
        <option value="">Choose a location</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        : mapping.location === undefined ? <p className="text-sm text-amber-800">Map the &quot;Business location&quot; column above first.</p>
        : <div className="space-y-2" data-location-mapping>
          <p className="text-xs text-muted-foreground">Choose the location for each value. Unmapped values are rejected, never guessed.</p>
          {distinctLocations.map((v) => <label key={v} className="grid gap-2 text-sm sm:grid-cols-[1fr_20rem] sm:items-center"><span className="break-words">{v}</span>
            <select aria-label={`Location for ${v}`} className="field-sm block w-full" value={values[v] ?? ""} onChange={(e) => { setValues((m) => ({ ...m, [v]: e.target.value })); setPreview(null); }}>
              <option value="">Leave unmapped (rows rejected)</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>)}
        </div>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={createDirectories} onChange={(e) => { setCreateDirectories(e.target.checked); setPreview(null); }} />
        <span>Add directories that are not in the registry yet (otherwise those rows are rejected).</span></label>
    </section>}

    {file && <section className="surface space-y-3 p-5">
      <h3 className="font-semibold">4. Preview and import</h3>
      <p className="text-sm text-muted-foreground">The preview runs the real import and rolls it back. Importing the same rows again updates or skips them; it never duplicates. Provider status never marks a listing verified.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={pending} onClick={() => run(false)}>{pending ? "Working…" : "Preview import"}</Button>
        <Button disabled={pending || !preview || !!preview.error || (preview.added ?? 0) + (preview.updated ?? 0) === 0} onClick={() => run(true)}>Import {preview && !preview.error ? `${(preview.added ?? 0) + (preview.updated ?? 0)} rows` : ""}</Button>
      </div>
      {preview?.error && <p role="alert" className="text-sm text-red-700">{preview.error}</p>}
      {preview && !preview.error && <div data-import-preview><Counts r={preview} /><Rows r={preview} /></div>}
    </section>}
  </div>;
}

function Counts({ r }: { r: ImportResult }) {
  return <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-import-counts>{([["Rows", r.rows_total], ["Added", r.added], ["Updated", r.updated], ["Skipped", r.skipped], ["Rejected", r.rejected]] as const).map(([k, v]) =>
    <div key={k} className="rounded-lg bg-royal-50 p-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="text-xl font-semibold" data-count={k.toLowerCase()}>{v ?? 0}</dd></div>)}</dl>;
}
function Rows({ r }: { r: ImportResult }) {
  const rows = (r.rows ?? []).filter((x) => x.outcome !== "added").slice(0, 300);
  if (!rows.length) return null;
  return <table className="mt-3 w-full text-left text-xs"><thead><tr><th className="py-1 pr-3">Row</th><th className="py-1 pr-3">Outcome</th><th className="py-1">Reason</th></tr></thead>
    <tbody>{rows.map((x) => <tr key={x.row_number} className="border-t"><td className="py-1 pr-3">{x.row_number}</td><td className="py-1 pr-3"><span className={`rounded-full px-2 py-0.5 ${OUTCOME_STYLE[x.outcome]}`}>{x.outcome}</span></td><td className="py-1 break-words">{x.message}</td></tr>)}</tbody></table>;
}
