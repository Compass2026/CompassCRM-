"use client";

import { startTransition, useActionState, useState } from "react";
import { recordMeasurementAction } from "@/app/report-actions";
import { METRICS, REPORT_AREAS, STATUS_LABELS, PLATFORMS, agencyToday, type Measurement } from "@/lib/reporting";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

export function ReportMeasurementForm({ clientId, period, series }: { clientId: string; period: string; series: Measurement[] }) {
  const [entryId, setEntryId] = useState<string | null>(null);
  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer font-medium">Record a measurement</summary>
      <p className="my-3 text-sm text-muted-foreground">Add verified data one metric at a time. The first measured value becomes its permanent baseline. Later entries preserve the original and its evidence.</p>
      {entryId ? <Entry key={entryId} entryId={entryId} clientId={clientId} period={period} series={series} onNew={() => setEntryId(crypto.randomUUID())} /> :
        <Button variant="outline" onClick={() => setEntryId(crypto.randomUUID())}>Start an entry</Button>}
    </details>
  );
}

function Entry({ entryId, clientId, period, series, onNew }: { entryId: string; clientId: string; period: string; series: Measurement[]; onNew: () => void }) {
  const [state, action, pending] = useActionState(recordMeasurementAction.bind(null, clientId), {});
  const [selected, setSelected] = useState("");
  const [metricKey, setMetricKey] = useState<string>(METRICS[0].key);
  const [status, setStatus] = useState("measured");
  const existing = series.find((r) => r.id === selected);
  const metric = METRICS.find((m) => m.key === (existing?.metric ?? metricKey))!;
  const today = agencyToday();
  if (state.savedId) return <div role="status" className="space-y-3"><p className="text-sm">Measurement saved with its source and history.</p><Button variant="outline" onClick={onNew}>Record another measurement</Button></div>;
  return (
    <form action={action} onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      startTransition(() => action(data));
    }} className="space-y-4">
      <input type="hidden" name="id" value={entryId} />
      <label className="block space-y-1 text-sm">Measurement series
        <select className={selectClass} value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">New metric or scope</option>
          {series.map((row) => <option key={row.id} value={row.id}>{METRICS.find((m) => m.key === row.metric)?.label} · {row.scope} · {row.source}{row.platform !== "none" ? ` · ${row.platform}/${row.channel}` : ""}</option>)}
        </select>
      </label>
      <div key={selected} className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">Metric
          <select name="metric" className={selectClass} value={existing?.metric ?? metricKey} onChange={(e) => { setSelected(""); setMetricKey(e.target.value); }}>
            {REPORT_AREAS.map((area) => <optgroup key={area.key} label={area.label}>{area.metrics.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</optgroup>)}
          </select>
        </label>
        <label className="space-y-1 text-sm">Starting point
          <select name="context" className={selectClass} defaultValue={existing?.context ?? "existing_client"}>
            <option value="existing_client">Work already started / first available measurement</option>
            <option value="before_work">Verified before improvements began</option>
          </select>
        </label>
        <label className="space-y-1 text-sm">Scope / measurement definition
          <Input name="scope" required maxLength={300} defaultValue={existing?.scope} readOnly={!!existing} placeholder="Property or profile; page/keyword list version, location, device" />
        </label>
        <label className="space-y-1 text-sm">Source / provider
          <Input name="source" required maxLength={150} defaultValue={existing?.source} readOnly={!!existing} placeholder="e.g. Search Console property export" />
        </label>
        {metric.area === "social" ? <>
          <label className="space-y-1 text-sm">Social platform
            <select name="platform" className={selectClass} defaultValue={existing?.platform ?? "facebook"}>{PLATFORMS.filter((p) => p !== "none").map((p) => <option key={p} value={p}>{p}</option>)}</select>
          </label>
          <label className="space-y-1 text-sm">Channel
            <select name="channel" className={selectClass} defaultValue={existing?.channel ?? "organic"}><option value="organic">Organic</option><option value="paid">Paid</option></select>
          </label>
        </> : <><input name="platform" type="hidden" value="none" /><input name="channel" type="hidden" value="none" /></>}
        <label className="space-y-1 text-sm">Data month (clear for initial baseline)
          <Input name="report_period" type="month" defaultValue={period.slice(0, 7)} max={today.slice(0, 7)} />
        </label>
        <label className="space-y-1 text-sm">Availability
          <select name="status" value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass}>{Object.entries(STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        </label>
        <label className="space-y-1 text-sm">Measurement start
          <Input name="window_start" type="date" required max={today} />
        </label>
        <label className="space-y-1 text-sm">Measurement end
          <Input name="window_end" type="date" required max={today} />
        </label>
        <p className="text-xs text-muted-foreground sm:col-span-2">{metric.kind === "point" ? "Use the same date for start and end: this metric is a snapshot." : "Use the actual inclusive dates from the source. Compare full calendar months or non-overlapping windows of equal length."} Changing a source, scope, platform or channel starts a separate baseline.</p>
        <label className="space-y-1 text-sm">Verified value
          <Input key={status} name="value" type="number" step={metric.key === "reviews_rating" ? "0.01" : "1"} min={metric.key === "social_followers" ? undefined : 0} max={metric.key === "reviews_rating" ? 5 : 1e12} required={status === "measured"} disabled={status !== "measured"} />
          {status !== "measured" && <input type="hidden" name="value" value="" />}
        </label>
        <label className="space-y-1 text-sm">Evidence reference
          <Input name="evidence" required={status === "measured"} maxLength={1000} placeholder="Export/document reference or CRM snapshot IDs; no secrets or personal lead data" />
        </label>
        <label className="space-y-1 text-sm">What this means / why data is unavailable
          <Textarea name="meaning" required maxLength={1000} rows={2} />
        </label>
        <label className="space-y-1 text-sm">Next action
          <Textarea name="next_action" required maxLength={1000} rows={2} />
        </label>
      </div>
      {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save verified entry"}</Button>
    </form>
  );
}
