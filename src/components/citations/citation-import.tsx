"use client";
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { runCitationImportAction, type ImportFormat, type ImportResult } from "@/app/citation-actions";
import { IMPORT_FIELDS, IMPORT_MAX_BYTES, guessMapping, isCredentialHeader, parseCsv, sensitiveContent, type ColumnMapping, type ImportField, type LocationMapping } from "@/lib/citations";
import { BRIGHTLOCAL_CAMPAIGN_COLUMNS, isBrightLocalCampaign } from "@/lib/citations-brightlocal";
import { Button } from "@/components/ui/button";
import { PROVIDERS, type Option } from "@/components/citations/citation-forms";

const OUTCOME_STYLE = { added: "bg-emerald-50 text-emerald-800", updated: "bg-blue-50 text-blue-800", skipped: "bg-slate-100 text-slate-700", rejected: "bg-red-50 text-red-800", held: "bg-amber-50 text-amber-800" } as const;
// A cell value is shown only after the same screen the server applies; a flagged one is never rendered.
const shown = (v: string) => sensitiveContent(v) ? "[hidden: looks like a login or private link]" : v;

// The file is read in the browser only to offer the column choices; the
// server parses and validates it again before anything is written. No cell
// is rendered except the distinct location values, screened first.
export function CitationImport({ clientId, locations }: { clientId: string; locations: Option[] }) {
  const [importId, setImportId] = useState(() => crypto.randomUUID());
  const [file, setFile] = useState<{ name: string; text: string; rows: string[][] } | null>(null);
  const [fileError, setFileError] = useState("");
  const [provider, setProvider] = useState("manual");
  const [format, setFormat] = useState<ImportFormat>("generic");
  const [campaign, setCampaign] = useState("");
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [mode, setMode] = useState<"single" | "column">("single");
  const [single, setSingle] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [createDirectories, setCreateDirectories] = useState(false);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [pending, start] = useTransition();

  const headers = file?.rows[0] ?? [];
  const brightLocal = format === "brightlocal_campaign";
  const credentialColumns = headers.filter(isCredentialHeader);
  const distinctLocations = useMemo(() => {
    if (!file || mapping.location === undefined) return [];
    return [...new Set(file.rows.slice(1).map((r) => (r[mapping.location!] ?? "").trim()).filter(Boolean))].sort().slice(0, 100);
  }, [file, mapping.location]);
  const locationMapping: LocationMapping = brightLocal || mode === "single" ? { mode: "single", locationId: single } : { mode, values };

  async function choose(f: File | undefined) {
    setPreview(null); setDone(null); setFileError(""); setFile(null);
    if (!f) return;
    if (f.size > IMPORT_MAX_BYTES) { setFileError("The file is larger than 900 KB. Split it and import each part."); return; }
    try {
      const text = await f.text();
      const rows = parseCsv(text);
      if (rows.length < 2) throw new Error("The file needs a header row and at least one data row.");
      setFile({ name: f.name, text, rows });
      const bl = isBrightLocalCampaign(rows[0]);
      setFormat(bl ? "brightlocal_campaign" : "generic");
      if (bl) setProvider("brightlocal");
      const guess = bl ? {} : guessMapping(rows[0]);
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
      const result = await runCitationImportAction(clientId, { importId, fileName: file.name, csv: file.text, provider, format, campaign, mapping, locations: locationMapping, createDirectories }, commit);
      if (commit && !result.error) setDone(result); else setPreview(result);
    });
  }
  function reset() { setImportId(crypto.randomUUID()); setFile(null); setPreview(null); setDone(null); setMapping({}); setValues({}); }

  if (done) return <div className="surface space-y-3 p-5" data-import-done>
    <h3 className="font-semibold">{done.already_committed ? "This import was already saved" : (done.added ?? 0) + (done.updated ?? 0) === 0 ? "Import history saved" : "Import saved"}</h3>
    <Counts r={done} />
    <NewDirectories r={done} /><Source r={done} />
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
        <label className="space-y-1 text-sm">File format<select aria-label="File format" className="field-sm block" value={format} onChange={(e) => { setFormat(e.target.value as ImportFormat); setPreview(null); }}>
          <option value="generic">Generic CSV (map the columns)</option><option value="brightlocal_campaign">BrightLocal Citation Builder campaign export</option></select></label>
        {brightLocal && <label className="space-y-1 text-sm">Campaign id (optional)<input aria-label="Campaign id" className="field-sm block w-32" inputMode="numeric" value={campaign} onChange={(e) => { setCampaign(e.target.value.trim()); setPreview(null); }} /></label>}
      </div>
      {brightLocal && <div className="callout text-sm" data-brightlocal-contract>
        <p>Columns: {BRIGHTLOCAL_CAMPAIGN_COLUMNS.join(", ")}{file && !isBrightLocalCampaign(headers) && <strong className="text-red-700"> — this file does not match.</strong>}</p>
        <p className="mt-1">Live / Updated → provider complete; Submitted → submitted (neither is verification). Every other status (Unavailable, blank) is held for review, not imported. The footer row is skipped. The Submitted date is never used as an observation date. <strong>The Notes column is never imported</strong>: real exports carry logins and verification links there.</p>
      </div>}
      {fileError && <p role="alert" className="text-sm text-red-700">{fileError}</p>}
      {file && <p className="text-xs text-muted-foreground">{shown(file.name)}: {file.rows.length - 1} data rows, {headers.length} columns.</p>}
      {credentialColumns.length > 0 && <p className="callout text-sm" data-credential-notice>Ignored {credentialColumns.length} login-like column{credentialColumns.length > 1 ? "s" : ""} ({credentialColumns.map(shown).join(", ")}). Their values are not imported or stored. Keep credentials in the approved secret store.</p>}
    </section>

    {file && !brightLocal && <section className="surface space-y-3 p-5">
      <h3 className="font-semibold">2. Map columns</h3>
      <p className="text-sm text-muted-foreground">Exact header matches are pre-selected as a starting point. Confirm each one.</p>
      <div className="grid gap-3 sm:grid-cols-2">{(Object.keys(IMPORT_FIELDS) as ImportField[]).map((f) =>
        <label key={f} className="space-y-1 text-sm">{IMPORT_FIELDS[f].label}{IMPORT_FIELDS[f].hint && <span className="block text-xs text-muted-foreground">{IMPORT_FIELDS[f].hint}</span>}
          <select aria-label={`Column for ${IMPORT_FIELDS[f].label}`} className="field-sm block w-full" value={mapping[f] ?? ""} onChange={(e) => setField(f, e.target.value)}>
            <option value="">Not in this file</option>
            {headers.map((h, i) => isCredentialHeader(h) || sensitiveContent(h) ? null : <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
          </select></label>)}
      </div>
    </section>}

    {file && <section className="surface space-y-3 p-5">
      <h3 className="font-semibold">3. Business locations</h3>
      {!brightLocal && <fieldset className="space-y-2 text-sm">
        <label className="flex items-center gap-2"><input type="radio" checked={mode === "single"} onChange={() => { setMode("single"); setPreview(null); }} />Every row belongs to one location</label>
        <label className="flex items-center gap-2"><input type="radio" checked={mode === "column"} onChange={() => { setMode("column"); setPreview(null); }} />A column names each row&apos;s location</label>
      </fieldset>}
      {brightLocal || mode === "single" ? <label className="block space-y-1 text-sm">Location<select aria-label="Location for every row" className="field-sm block w-full sm:w-80" value={single} onChange={(e) => { setSingle(e.target.value); setPreview(null); }}>
        <option value="">Choose a location</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        : mapping.location === undefined ? <p className="text-sm text-amber-800">Map the &quot;Business location&quot; column above first.</p>
        : <div className="space-y-2" data-location-mapping>
          <p className="text-xs text-muted-foreground">Choose the location for each value. Unmapped values are rejected, never guessed.</p>
          {distinctLocations.map((v) => <label key={v} className="grid gap-2 text-sm sm:grid-cols-[1fr_20rem] sm:items-center"><span className="break-words" data-location-value>{shown(v)}</span>
            <select aria-label={`Location for ${shown(v)}`} className="field-sm block w-full" value={values[v] ?? ""} onChange={(e) => { setValues((m) => ({ ...m, [v]: e.target.value })); setPreview(null); }}>
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
        <Button disabled={pending || !preview || !!preview.error || toSave(preview) === 0} onClick={() => run(true)}>{commitLabel(preview)}</Button>
      </div>
      {preview?.error && <p role="alert" className="text-sm text-red-700">{preview.error}</p>}
      {preview && !preview.error && <div data-import-preview><Counts r={preview} /><NewDirectories r={preview} /><Source r={preview} /><Rows r={preview} /></div>}
    </section>}
  </div>;
}

// What a commit would write: listings added or updated, and held rows kept as history.
// A file of only held attempts (historical exceptions) is still worth saving.
const toSave = (r: ImportResult) => (r.added ?? 0) + (r.updated ?? 0) + (r.held ?? 0);
function commitLabel(r: ImportResult | null) {
  if (!r || r.error) return "Import";
  const listings = (r.added ?? 0) + (r.updated ?? 0), held = r.held ?? 0;
  if (listings && held) return `Import ${listings} rows and record ${held} held`;
  if (listings) return `Import ${listings} rows`;
  if (held) return `Save import history (${held} held, no listings)`;
  return "Nothing to import";
}
function Counts({ r }: { r: ImportResult }) {
  return <dl className="grid grid-cols-2 gap-2 sm:grid-cols-6" data-import-counts>{([["Rows", r.rows_total], ["Added", r.added], ["Updated", r.updated], ["Skipped", r.skipped], ["Rejected", r.rejected], ["Held", r.held]] as const).map(([k, v]) =>
    <div key={k} className="rounded-lg bg-royal-50 p-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="text-xl font-semibold" data-count={k.toLowerCase()}>{v ?? 0}</dd></div>)}</dl>;
}
function NewDirectories({ r }: { r: ImportResult }) {
  if (!r.new_directories?.length) return null;
  return <p className="mt-3 text-sm" data-new-directories>{r.committed ? "Added" : "Will add"} {r.new_directories.length} director{r.new_directories.length > 1 ? "ies" : "y"} to the shared registry: {r.new_directories.join(", ")}. Check none of them is another name for an existing directory.</p>;
}
function Source({ r }: { r: ImportResult }) {
  if (!r.source) return null;
  return <p className="mt-2 text-xs text-muted-foreground" data-source-counts>Source file: {r.source.directoryRows} directory rows ({Object.entries(r.source.byRawStatus).map(([k, v]) => `${v} ${k}`).join(", ")}), {r.source.footerRows} footer row skipped, Notes excluded on {r.source.rawNotesExcluded} rows.</p>;
}
function Rows({ r }: { r: ImportResult }) {
  const rows = (r.rows ?? []).filter((x) => x.outcome !== "added").slice(0, 300);
  if (!rows.length) return null;
  return <table className="mt-3 w-full text-left text-xs"><thead><tr><th className="py-1 pr-3">Row</th><th className="py-1 pr-3">Outcome</th><th className="py-1">Reason</th></tr></thead>
    <tbody>{rows.map((x) => <tr key={x.row_number} className="border-t"><td className="py-1 pr-3">{x.row_number}</td><td className="py-1 pr-3"><span className={`rounded-full px-2 py-0.5 ${OUTCOME_STYLE[x.outcome]}`}>{x.outcome}</span></td><td className="py-1 break-words">{x.message}</td></tr>)}</tbody></table>;
}
