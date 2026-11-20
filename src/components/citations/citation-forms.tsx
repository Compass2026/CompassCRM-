"use client";
import { useActionState, useState } from "react";
import {
  addCitationDirectoryAction, addCitationListingAction, createCitationLocationAction, createCitationRequestAction, enrichCitationListingAction, openCitationTaskAction,
  queueVerificationAction, recordCitationCheckAction, recordCreditEntryAction, updateCitationLocationAction, updateCitationRequestAction, updateCitationTaskAction,
  type CitationActionState, type EnrichmentState,
} from "@/app/citation-actions";
import {
  CHECK_FIELDS, CHECK_METHODS, CHECK_RESULTS, FIELD_STATUSES, FULFILLMENT_STATUSES, REQUEST_ACTIONS, REQUEST_STATUSES, RESULT_METHODS, TASK_KINDS, TASK_STATUSES,
  VERIFICATION_STATUSES, deriveCheckResult, unpublishedFields,
  type CheckField, type CitationIdentity, type CitationLocation, type CitationRequest, type CitationTask, type FieldStatus, type FieldStatuses,
} from "@/lib/citations";
import { agencyToday } from "@/lib/reporting";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export type Option = { id: string; name: string };
export const PROVIDERS = { manual: "Manual (team)", brightlocal: "BrightLocal", advice_local: "Advice Local", synup: "Synup", whitespark: "Whitespark", other: "Other" } as const;

// Entered values stay when an action returns an error; create forms are
// replaced on success (a new id per entry makes a retry the same record).
function Outcome({ state }: { state: CitationActionState }) {
  return <>{state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}{state.savedId && <p role="status" className="text-sm text-emerald-700">Saved.</p>}</>;
}
function Select({ name, label, options, defaultValue, required, onChange, value }: { name: string; label: string; options: [string, string][]; defaultValue?: string; required?: boolean; onChange?: (v: string) => void; value?: string }) {
  return <label className="space-y-1 text-sm">{label}<select name={name} required={required} className="field-sm block w-full" defaultValue={value === undefined ? defaultValue : undefined} value={value} onChange={onChange ? (e) => onChange(e.target.value) : undefined}>{options.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>;
}
function Fresh({ children, label }: { children: (id: string, again: () => void) => React.ReactNode; label: string }) {
  const [entry, setEntry] = useState<string | null>(null);
  return entry ? <div key={entry}>{children(entry, () => setEntry(crypto.randomUUID()))}</div> : <Button variant="outline" size="sm" onClick={() => setEntry(crypto.randomUUID())}>{label}</Button>;
}

function IdentityFields({ location, trackingLocations, brands }: { location?: CitationLocation; trackingLocations: Option[]; brands: Option[] }) {
  const [hidden, setHidden] = useState(location?.hide_address ?? false);
  return <>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-sm">Location label<Input name="label" required maxLength={120} defaultValue={location?.label} placeholder="Main office" /></label>
      <label className="space-y-1 text-sm">Approved business name<Input name="business_name" required maxLength={200} defaultValue={location?.business_name} /></label>
      <label className="space-y-1 text-sm">Street address<Input name="address_line1" maxLength={200} defaultValue={location?.address_line1} required={!hidden} /></label>
      <label className="space-y-1 text-sm">Suite / unit<Input name="address_line2" maxLength={200} defaultValue={location?.address_line2} /></label>
      <label className="space-y-1 text-sm">City<Input name="city" maxLength={100} defaultValue={location?.city} required={!hidden} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 text-sm">State<Input name="region" maxLength={50} defaultValue={location?.region} /></label>
        <label className="space-y-1 text-sm">ZIP<Input name="postal_code" maxLength={20} defaultValue={location?.postal_code} /></label>
      </div>
      <label className="space-y-1 text-sm">Approved phone<Input name="phone" maxLength={40} defaultValue={location?.phone} /></label>
      <label className="space-y-1 text-sm">Approved website<Input name="website_url" type="url" maxLength={2000} defaultValue={location?.website_url ?? ""} placeholder="https://" /></label>
      {trackingLocations.length > 0 && <Select name="tracking_location_id" label="Linked rank / GBP location (optional)" defaultValue={location?.tracking_location_id ?? ""} options={[["", "None"], ...trackingLocations.map((l): [string, string] => [l.id, l.name])]} />}
      {brands.length > 0 && <Select name="brand_workspace_id" label="Brand (optional)" defaultValue={location?.brand_workspace_id ?? ""} options={[["", "Client"], ...brands.map((b): [string, string] => [b.id, b.name])]} />}
    </div>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="hide_address" checked={hidden} onChange={(e) => setHidden(e.target.checked)} className="mt-1" />
      <span>Hide the street address (service-area business). It is kept for the team but never appears in client-safe reports or exports.</span></label>
    <p className="text-xs text-muted-foreground">One location per real, listing-eligible business. Several websites do not by themselves make several locations.</p>
  </>;
}

export function NewLocationForm({ clientId, trackingLocations, brands }: { clientId: string; trackingLocations: Option[]; brands: Option[] }) {
  return <details className="surface p-5"><summary className="cursor-pointer font-semibold">Add a business location</summary>
    <div className="mt-4"><Fresh label="Start a location">{(id, again) => <CreateLocation id={id} again={again} clientId={clientId} trackingLocations={trackingLocations} brands={brands} />}</Fresh></div>
  </details>;
}
function CreateLocation({ id, again, clientId, trackingLocations, brands }: { id: string; again: () => void; clientId: string; trackingLocations: Option[]; brands: Option[] }) {
  const [state, action, pending] = useActionState(createCitationLocationAction.bind(null, clientId), {});
  if (state.savedId) return <div className="space-y-3"><Outcome state={state} /><Button variant="outline" size="sm" onClick={again}>Add another location</Button></div>;
  return <form action={action} onReset={(e) => e.preventDefault()} className="space-y-4"><input type="hidden" name="id" value={id} />
    <IdentityFields trackingLocations={trackingLocations} brands={brands} />
    <label className="block space-y-1 text-sm">Internal notes<Textarea name="notes" maxLength={2000} /></label>
    <Outcome state={state} /><Button disabled={pending}>{pending ? "Saving…" : "Save approved identity"}</Button></form>;
}

export function EditLocationForm({ location, trackingLocations, brands }: { location: CitationLocation; trackingLocations: Option[]; brands: Option[] }) {
  const [state, action, pending] = useActionState(updateCitationLocationAction.bind(null, location.client_id, location.id), {});
  return <form action={action} onReset={(e) => e.preventDefault()} className="space-y-4"><input type="hidden" name="updated_at" value={location.updated_at} />
    <IdentityFields location={location} trackingLocations={trackingLocations} brands={brands} />
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-sm">Why the identity changed (required when it does)<Input name="identity_note" maxLength={1000} placeholder="Client confirmed the new suite number" /></label>
      <Select name="status" label="Status" defaultValue={location.status} options={[["active", "Active"], ["archived", "Archived"]]} />
    </div>
    <label className="block space-y-1 text-sm">Internal notes<Textarea name="notes" maxLength={2000} defaultValue={location.notes} /></label>
    <p className="text-xs text-muted-foreground">Each change to the name, address, phone, website or hidden-address setting is kept as a new approved version; checks record the version they compared against.</p>
    <Outcome state={state} /><Button size="sm" variant="outline" disabled={pending}>{pending ? "Saving…" : "Save identity"}</Button></form>;
}

export function AddListingForm({ clientId, locationId, directories }: { clientId: string; locationId: string; directories: Option[] }) {
  return <Fresh label="Add a listing">{(id, again) => <CreateListing id={id} again={again} clientId={clientId} locationId={locationId} directories={directories} />}</Fresh>;
}
function CreateListing({ id, again, clientId, locationId, directories }: { id: string; again: () => void; clientId: string; locationId: string; directories: Option[] }) {
  const [state, action, pending] = useActionState(addCitationListingAction.bind(null, clientId, locationId), {});
  if (state.savedId) return <div className="space-y-2"><Outcome state={state} /><Button variant="outline" size="sm" onClick={again}>Add another listing</Button></div>;
  return <form action={action} onReset={(e) => e.preventDefault()} className="surface space-y-3 p-4"><input type="hidden" name="id" value={id} />
    <div className="grid gap-3 sm:grid-cols-2">
      <Select name="directory_id" label="Directory" required options={[["", "Choose a directory"], ...directories.map((d): [string, string] => [d.id, d.name])]} />
      <label className="space-y-1 text-sm">Listing URL<Input name="listing_url" type="url" maxLength={2000} placeholder="https://" /></label>
      <label className="space-y-1 text-sm">External listing id<Input name="external_id" maxLength={200} /></label>
      <Select name="fulfillment_status" label="Provider status" options={Object.entries(FULFILLMENT_STATUSES)} />
    </div>
    <label className="block space-y-1 text-sm">Notes<Textarea name="notes" maxLength={2000} /></label>
    <p className="text-xs text-muted-foreground">A new listing starts unverified whatever the provider status says. Record a check to verify it.</p>
    <Outcome state={state} /><Button size="sm" disabled={pending}>{pending ? "Saving…" : "Save listing"}</Button></form>;
}

type CheckIdentity = Pick<CitationIdentity, "hide_address" | "phone" | "website_url">;
export function CheckForm({ clientId, listingId, identity }: { clientId: string; listingId: string; identity: CheckIdentity }) {
  return <Fresh label="Record a check">{(id, again) => <Check id={id} again={again} clientId={clientId} listingId={listingId} identity={identity} />}</Fresh>;
}
const REVIEWS = {
  content: "Reviewed the listing's fields",
  inaccessible: CHECK_RESULTS.inaccessible,
  not_found: CHECK_RESULTS.not_found,
  confirmed_absent: CHECK_RESULTS.confirmed_absent,
} as const;
const FIELD_LABELS: Record<CheckField, string> = { name: "Name", address: "Address", phone: "Phone", website: "Website" };
const OBSERVED_MAX: Record<CheckField, number> = { name: 300, address: 500, phone: 50, website: 2000 };
function Check({ id, again, clientId, listingId, identity }: { id: string; again: () => void; clientId: string; listingId: string; identity: CheckIdentity }) {
  const [state, action, pending] = useActionState(recordCitationCheckAction.bind(null, clientId, listingId), {});
  const [review, setReview] = useState<keyof typeof REVIEWS>("content");
  const [statuses, setStatuses] = useState<FieldStatuses>({ name: "not_checked", address: "not_checked", phone: "not_checked", website: "not_checked" });
  const unpublished = unpublishedFields(identity);
  let verdict: string;
  try { verdict = `This check will record: ${VERIFICATION_STATUSES[{ accurate: "verified_accurate", discrepancy: "discrepancy", partial: "partially_verified" }[deriveCheckResult(statuses, identity)] as keyof typeof VERIFICATION_STATUSES]}.`; }
  catch (e) { verdict = e instanceof Error ? e.message : ""; }
  if (state.savedId) return <div className="space-y-2"><Outcome state={state} /><Button variant="outline" size="sm" onClick={again}>Record another check</Button></div>;
  const methods = RESULT_METHODS[review === "content" ? "accurate" : review];
  return <form action={action} onReset={(e) => e.preventDefault()} className="space-y-3"><input type="hidden" name="id" value={id} />
    <p className="text-xs text-muted-foreground">Open the listing yourself and record, field by field, what you saw. Only the fields you mark verified count as verified: a name-only review is &quot;partially verified&quot;, never &quot;verified accurate&quot;. The check counts against today&apos;s approved identity only if it is dated on or after that identity was approved. This form does not crawl the directory.</p>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="space-y-1 text-sm">Checked on<Input name="checked_on" type="date" required defaultValue={agencyToday()} max={agencyToday()} /></label>
      <Select name="review" label="What you found" value={review} onChange={(v) => setReview(v as keyof typeof REVIEWS)} options={Object.entries(REVIEWS)} />
      <Select key={review} name="method" label="How you checked" options={methods.map((m): [string, string] => [m, CHECK_METHODS[m]])} />
    </div>
    {review === "content" && <div className="space-y-2" data-field-review>
      {CHECK_FIELDS.map((f) => {
        const seen = statuses[f] === "verified" || statuses[f] === "discrepancy";
        const options = (Object.entries(FIELD_STATUSES) as [FieldStatus, string][]).filter(([k]) => !(k === "verified" && unpublished.has(f)));
        return <div key={f} className="grid gap-2 sm:grid-cols-[12rem_1fr]">
          <Select name={`${f}_status`} label={`${FIELD_LABELS[f]} check`} value={statuses[f]} onChange={(v) => setStatuses({ ...statuses, [f]: v as FieldStatus })} options={options} />
          <label className="space-y-1 text-sm">{FIELD_LABELS[f]} shown<Input name={`observed_${f}`} maxLength={OBSERVED_MAX[f]} disabled={!seen} required={seen}
            placeholder={seen ? "Exactly as the listing shows it" : "Kept only for a field you saw"} /></label>
        </div>;
      })}
      {unpublished.has("address") && <p className="text-xs text-amber-800">Hidden-address business: choose &quot;not displayed&quot; when no street is shown. A shown street is a discrepancy; record it here only as evidence, it never appears in client-safe output.</p>}
      <p className="text-sm font-medium" data-derived-verdict>{verdict}</p>
    </div>}
    <label className="block space-y-1 text-sm">Evidence<Textarea name="evidence" required maxLength={2000} placeholder="What you saw, where, and the screenshot or audit reference" /></label>
    <label className="block space-y-1 text-sm">Evidence link (optional)<Input name="evidence_url" type="url" maxLength={2000} placeholder="https:// screenshot in Drive" /></label>
    <Outcome state={state} /><Button size="sm" disabled={pending}>{pending ? "Saving…" : "Save check"}</Button></form>;
}

/** Adds the URL and / or external id an existing listing is missing; never replaces one. */
export function EnrichListingForm({ clientId, listingId, hasUrl, hasExternalId }: { clientId: string; listingId: string; hasUrl: boolean; hasExternalId: boolean }) {
  return <Fresh label="Add URL / id">{(id, again) => <Enrich id={id} again={again} clientId={clientId} listingId={listingId} hasUrl={hasUrl} hasExternalId={hasExternalId} />}</Fresh>;
}
function Enrich({ id, again, clientId, listingId, hasUrl, hasExternalId }: { id: string; again: () => void; clientId: string; listingId: string; hasUrl: boolean; hasExternalId: boolean }) {
  const [state, action, pending] = useActionState<EnrichmentState, FormData>(enrichCitationListingAction.bind(null, clientId, listingId), {});
  if (state.savedId) return <div className="space-y-2"><Outcome state={state} /><Button variant="outline" size="sm" onClick={again}>Done</Button></div>;
  return <form action={action} onReset={(e) => e.preventDefault()} className="space-y-3" data-enrich-form><input type="hidden" name="id" value={id} />
    <div className="grid gap-3 sm:grid-cols-2">
      {!hasUrl && <label className="space-y-1 text-sm">Public listing URL<Input name="listing_url" type="url" maxLength={2000} placeholder="https://" /></label>}
      {!hasExternalId && <label className="space-y-1 text-sm">External listing id<Input name="external_id" maxLength={200} placeholder="The publisher's id for this listing" /></label>}
    </div>
    <label className="block space-y-1 text-sm">Where you found it<Textarea name="reason" required maxLength={1000} placeholder="e.g. Apple Maps directions link seen in the audit on (date)" /></label>
    {state.matches && <fieldset className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm" data-enrich-matches>
      <legend className="px-1 font-medium text-amber-900">Already on another listing</legend>
      {state.matches.map((m) => <label key={m.id} className="flex items-start gap-2"><input type="checkbox" name="acknowledge" value={m.id} required className="mt-1" /><span>{m.label}: I reviewed it; this listing is a separate record.</span></label>)}
    </fieldset>}
    <p className="text-xs text-muted-foreground">Fills only what this listing is missing; its checks, tasks, provider status and import history stay as they are, and the before / after is kept. A public listing link only: no logins or private verification links. A different URL is a different listing.</p>
    <Outcome state={state} /><Button size="sm" disabled={pending}>{pending ? "Saving…" : "Save URL / id"}</Button></form>;
}

export function OpenTaskForm({ clientId, locationId, listings, team, defaultListing }: { clientId: string; locationId: string; listings: Option[]; team: Option[]; defaultListing?: string }) {
  return <Fresh label="Open a task">{(id, again) => <OpenTask id={id} again={again} clientId={clientId} locationId={locationId} listings={listings} team={team} defaultListing={defaultListing} />}</Fresh>;
}
function OpenTask({ id, again, clientId, locationId, listings, team, defaultListing }: { id: string; again: () => void; clientId: string; locationId: string; listings: Option[]; team: Option[]; defaultListing?: string }) {
  const [state, action, pending] = useActionState(openCitationTaskAction.bind(null, clientId, locationId), {});
  if (state.savedId) return <div className="space-y-2"><Outcome state={state} /><Button variant="outline" size="sm" onClick={again}>Open another task</Button></div>;
  return <form action={action} onReset={(e) => e.preventDefault()} className="space-y-3"><input type="hidden" name="id" value={id} />
    <div className="grid gap-3 sm:grid-cols-2">
      <Select name="kind" label="Task" options={Object.entries(TASK_KINDS)} defaultValue="correct" />
      <Select name="listing_id" label="Listing" defaultValue={defaultListing ?? ""} options={[["", "The location (no listing yet)"], ...listings.map((l): [string, string] => [l.id, l.name])]} />
      <Select name="assignee_id" label="Owner" options={[["", "Unassigned"], ...team.map((t): [string, string] => [t.id, t.name])]} />
      <label className="space-y-1 text-sm">Due<Input name="due_on" type="date" /></label>
    </div>
    <label className="block space-y-1 text-sm">Reason<Textarea name="reason" required maxLength={2000} placeholder="What is wrong and what has to change" /></label>
    <Outcome state={state} /><Button size="sm" disabled={pending}>{pending ? "Saving…" : "Open task"}</Button></form>;
}

export function TaskUpdateForm({ task, team, checks }: { task: CitationTask; team: Option[]; checks: Option[] }) {
  const [state, action, pending] = useActionState(updateCitationTaskAction.bind(null, task.client_id, task.id), {});
  const [status, setStatus] = useState(task.status);
  const closing = status === "resolved" || status === "cancelled";
  return <form action={action} onReset={(e) => e.preventDefault()} className="space-y-3"><input type="hidden" name="updated_at" value={task.updated_at} />
    <div className="grid gap-3 sm:grid-cols-3">
      <Select name="status" label="Status" value={status} onChange={(v) => setStatus(v as CitationTask["status"])} options={Object.entries(TASK_STATUSES)} />
      <Select name="assignee_id" label="Owner" defaultValue={task.assignee_id ?? ""} options={[["", "Unassigned"], ...team.map((t): [string, string] => [t.id, t.name])]} />
      <label className="space-y-1 text-sm">Due<Input name="due_on" type="date" defaultValue={task.due_on ?? ""} /></label>
    </div>
    {closing && <>
      <label className="block space-y-1 text-sm">Resolution<Textarea name="resolution" required maxLength={2000} defaultValue={task.resolution} /></label>
      {status === "resolved" && <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm">Confirmed on<Input name="resolved_on" type="date" required defaultValue={task.resolved_on ?? agencyToday()} max={agencyToday()} /></label>
        <Select name="check_id" label="Check that proves it" defaultValue={task.check_id ?? ""} options={[["", "No check (give a reference)"], ...checks.map((c): [string, string] => [c.id, c.name])]} />
        <label className="space-y-1 text-sm">Evidence reference<Input name="evidence_ref" maxLength={2000} defaultValue={task.evidence_ref} placeholder="Screenshot / ticket / email ref" /></label>
      </div>}
    </>}
    {!closing && <input type="hidden" name="evidence_ref" value="" />}
    <Outcome state={state} /><Button size="sm" variant="outline" disabled={pending}>{pending ? "Saving…" : "Save task"}</Button></form>;
}

export function RequestForm({ clientId, locationId, directories, listings }: { clientId: string; locationId: string; directories: Option[]; listings: (Option & { directory_id: string })[] }) {
  return <Fresh label="Record a fulfillment request">{(id, again) => <CreateRequest id={id} again={again} clientId={clientId} locationId={locationId} directories={directories} listings={listings} />}</Fresh>;
}
function CreateRequest({ id, again, clientId, locationId, directories, listings }: { id: string; again: () => void; clientId: string; locationId: string; directories: Option[]; listings: (Option & { directory_id: string })[] }) {
  const [state, action, pending] = useActionState(createCitationRequestAction.bind(null, clientId, locationId), {});
  const [directory, setDirectory] = useState("");
  if (state.savedId) return <div className="space-y-2"><Outcome state={state} /><Button variant="outline" size="sm" onClick={again}>Record another request</Button></div>;
  return <form action={action} onReset={(e) => e.preventDefault()} className="space-y-3"><input type="hidden" name="id" value={id} />
    <div className="grid gap-3 sm:grid-cols-3">
      <Select name="directory_id" label="Directory" required value={directory} onChange={setDirectory} options={[["", "Choose a directory"], ...directories.map((d): [string, string] => [d.id, d.name])]} />
      <Select key={directory} name="listing_id" label="Existing listing" options={[["", "None (new listing)"], ...listings.filter((l) => l.directory_id === directory).map((l): [string, string] => [l.id, l.name])]} />
      <Select name="action" label="Requested action" options={Object.entries(REQUEST_ACTIONS)} />
      <Select name="provider" label="Provider" options={Object.entries(PROVIDERS)} />
      <Select name="status" label="Status" options={[["draft", "Draft"], ["pending_approval", "Pending approval"]]} />
      <div className="grid grid-cols-[1fr_5rem] gap-2"><label className="space-y-1 text-sm">Budget to approve<Input name="approved_budget" inputMode="decimal" placeholder="3.20" /></label><label className="space-y-1 text-sm">Currency<Input name="budget_currency" defaultValue="USD" maxLength={3} /></label></div>
    </div>
    <label className="block space-y-1 text-sm">Notes<Textarea name="notes" maxLength={2000} /></label>
    <p className="text-xs text-muted-foreground">This records a request; it does not order anything or spend credits. An admin approves it before it can be marked submitted.</p>
    <Outcome state={state} /><Button size="sm" disabled={pending}>{pending ? "Saving…" : "Save request"}</Button></form>;
}

export function RequestUpdateForm({ request, isAdmin }: { request: CitationRequest; isAdmin: boolean }) {
  const [state, action, pending] = useActionState(updateCitationRequestAction.bind(null, request.client_id, request.id), {});
  const approved = !!request.approved_at;
  const statuses = Object.entries(REQUEST_STATUSES).filter(([k]) => isAdmin || approved || k !== "approved" || request.status === "approved");
  return <form action={action} onReset={(e) => e.preventDefault()} className="space-y-3"><input type="hidden" name="updated_at" value={request.updated_at} />
    <div className="grid gap-3 sm:grid-cols-3">
      <Select name="status" label="Status" defaultValue={request.status} options={statuses} />
      <label className="space-y-1 text-sm">Provider reference<Input name="provider_reference" maxLength={300} defaultValue={request.provider_reference} /></label>
      <div className="grid grid-cols-[1fr_5rem] gap-2"><label className="space-y-1 text-sm">Approved budget<Input name="approved_budget" inputMode="decimal" defaultValue={request.approved_budget ?? ""} readOnly={approved && !isAdmin} /></label><label className="space-y-1 text-sm">Currency<Input name="budget_currency" defaultValue={request.budget_currency} maxLength={3} readOnly={approved && !isAdmin} /></label></div>
      <div className="grid grid-cols-[1fr_5rem] gap-2"><label className="space-y-1 text-sm">Actual cash paid<Input name="actual_amount" inputMode="decimal" defaultValue={request.actual_amount ?? ""} /></label><label className="space-y-1 text-sm">Currency<Input name="actual_currency" defaultValue={request.actual_currency} maxLength={3} /></label></div>
      <label className="space-y-1 text-sm">Prepaid credits used<Input name="credits_used" inputMode="numeric" defaultValue={request.credits_used ?? ""} /></label>
    </div>
    <label className="block space-y-1 text-sm">Notes<Textarea name="notes" maxLength={2000} defaultValue={request.notes} /></label>
    {!isAdmin && !approved && <p className="text-xs text-muted-foreground">Only an admin can approve. Set it to pending approval and an admin will decide.</p>}
    <Outcome state={state} /><Button size="sm" variant="outline" disabled={pending}>{pending ? "Saving…" : "Save request"}</Button></form>;
}

export function CreditEntryForm() {
  return <Fresh label="Record credits">{(id, again) => <CreditEntry id={id} again={again} />}</Fresh>;
}
function CreditEntry({ id, again }: { id: string; again: () => void }) {
  const [state, action, pending] = useActionState(recordCreditEntryAction, {});
  const [kind, setKind] = useState("opening_balance");
  if (state.savedId) return <div className="space-y-2"><Outcome state={state} /><Button variant="outline" size="sm" onClick={again}>Record another entry</Button></div>;
  return <form action={action} onReset={(e) => e.preventDefault()} className="space-y-3"><input type="hidden" name="id" value={id} />
    <div className="grid gap-3 sm:grid-cols-3">
      <Select name="provider" label="Provider" options={Object.entries(PROVIDERS)} />
      <Select name="kind" label="Entry" value={kind} onChange={setKind} options={[["opening_balance", "Opening balance"], ["purchase", "Purchase"], ["adjustment", "Adjustment"]]} />
      <label className="space-y-1 text-sm">Credits<Input name="credits" required inputMode="numeric" /></label>
      {kind === "purchase" && <div className="grid grid-cols-[1fr_5rem] gap-2"><label className="space-y-1 text-sm">One-time cash paid<Input name="cash_amount" inputMode="decimal" /></label><label className="space-y-1 text-sm">Currency<Input name="currency" defaultValue="USD" maxLength={3} /></label></div>}
      <label className="space-y-1 text-sm">Date<Input name="occurred_on" type="date" required defaultValue={agencyToday()} max={agencyToday()} /></label>
      <label className="space-y-1 text-sm">Reference<Input name="reference" maxLength={300} placeholder="Invoice / account page" /></label>
    </div>
    <label className="block space-y-1 text-sm">Note<Input name="note" maxLength={1000} /></label>
    <Outcome state={state} /><Button size="sm" disabled={pending}>{pending ? "Saving…" : "Save entry"}</Button></form>;
}

export function DirectoryForm({ clientId }: { clientId: string }) {
  return <Fresh label="Add a directory">{(id, again) => <Directory key={id} again={again} clientId={clientId} />}</Fresh>;
}
function Directory({ again, clientId }: { again: () => void; clientId: string }) {
  const [state, action, pending] = useActionState(addCitationDirectoryAction.bind(null, clientId), {});
  if (state.savedId) return <div className="space-y-2"><Outcome state={state} /><Button variant="outline" size="sm" onClick={again}>Add another directory</Button></div>;
  return <form action={action} onReset={(e) => e.preventDefault()} className="flex flex-wrap items-end gap-3">
    <label className="space-y-1 text-sm">Directory name<Input name="name" required maxLength={120} /></label>
    <label className="space-y-1 text-sm">Domain<Input name="domain" maxLength={200} placeholder="example.com" /></label>
    <Button size="sm" disabled={pending}>{pending ? "Saving…" : "Add directory"}</Button><Outcome state={state} /></form>;
}

/** Opens a verify task for each linked, not-currently-verified listing that has none. Repeating it adds nothing. */
export function QueueVerificationButton({ clientId, locationId }: { clientId: string; locationId: string }) {
  const [state, action, pending] = useActionState(queueVerificationAction.bind(null, clientId, locationId), {});
  return <form action={action} className="flex flex-wrap items-center gap-2">
    <Button size="sm" variant="outline" disabled={pending}>{pending ? "Queuing…" : "Queue verification for linked listings"}</Button>
    {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
    {state.savedId && <p role="status" className="text-sm text-emerald-700" data-queued={state.created}>{state.created ? `Opened ${state.created} verification task${state.created > 1 ? "s" : ""}.` : "Nothing new to queue."}</p>}
  </form>;
}
