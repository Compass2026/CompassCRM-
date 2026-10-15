import { countText, DELIVERY_KEYS, deliveryLabels, sharesBusinessProfile, type ClientDelivery, type Count } from "@/lib/delivery-standard";
import { cn } from "@/lib/utils";

const monthLabel = (m: string) =>
  new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}T00:00:00Z`));

function Counts({ counts }: { counts: Record<string, Count> }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
      {DELIVERY_KEYS.map((k) => (
        <li key={k} data-deliverable={k} data-used={counts[k].used} data-target={counts[k].target}>
          <span className="text-muted-foreground">{deliveryLabels[k]}:</span>{" "}
          <span className={cn("font-medium", counts[k].over > 0 && "text-amber-800")}>{countText(counts[k])}</span>
          {counts[k].used > 0 && <span className="text-xs text-muted-foreground"> ({counts[k].completed} done, {counts[k].planned} planned)</span>}
        </li>
      ))}
    </ul>
  );
}

// The month's delivery standard against work done and planned, per brand site
// (or the client), with the client's total. Absent when the client is not on
// a standard for the month; an unreadable standard is said, never guessed.
export function DeliveryStandardCard({ month, delivery, error }: { month: string; delivery: ClientDelivery | null; error: string | null }) {
  if (error) {
    return (
      <section className="rounded-xl bg-card p-3.5 ring-1 ring-border" data-card="delivery-standard">
        <p role="alert" className="text-sm text-amber-900">The monthly delivery standard could not be read: {error}</p>
      </section>
    );
  }
  if (!delivery) {
    return (
      <section className="rounded-xl bg-card p-3.5 ring-1 ring-border" data-card="delivery-standard" data-standard="none">
        <p className="text-sm text-muted-foreground">This client is not on a monthly delivery standard for {monthLabel(month)}.</p>
      </section>
    );
  }
  const brands = delivery.units.filter((u) => u.kind !== "unattributed");
  const unattributed = delivery.units.find((u) => u.kind === "unattributed" && DELIVERY_KEYS.some((k) => u.counts[k].used > 0));
  return (
    <section className="space-y-2 rounded-xl bg-card p-3.5 ring-1 ring-border" data-card="delivery-standard" data-standard={delivery.standardVersion}>
      <h3 className="text-sm font-semibold text-navy-900">Monthly delivery standard · {monthLabel(month)}</h3>
      <p className="text-xs text-muted-foreground">
        Per {brands.length > 1 ? "brand site" : "client"} each month. Social is Facebook only; a refresh updates an existing
        page and new pages are not part of the standard. Planned counts are targets, not permission to schedule or publish.
      </p>
      {brands.map((u) => (
        <div key={u.brandId ?? "client"} data-unit={u.kind} data-brand={u.brandId ?? ""}>
          {brands.length > 1 && <p className="text-xs font-medium">{u.name}</p>}
          <Counts counts={u.counts} />
        </div>
      ))}
      {brands.length > 1 && (
        <div className="border-t pt-2" data-unit="total">
          <p className="text-xs font-medium">All {brands.length} brands</p>
          <Counts counts={delivery.total} />
        </div>
      )}
      {sharesBusinessProfile(delivery) && (
        <p className="text-xs text-muted-foreground">
          The brands share one Business Profile: each post counts once, for the brand of its service.
        </p>
      )}
      {unattributed && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2" data-unit="unattributed">
          <p className="text-xs text-amber-900">Work with no brand service is not counted toward any brand. Assign its service to a brand.</p>
          <Counts counts={unattributed.counts} />
        </div>
      )}
    </section>
  );
}
