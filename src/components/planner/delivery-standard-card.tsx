import { countText, DELIVERY_KEYS, deliveryLabels, sharedBusinessProfile, totalText, type ClientDelivery, type Count } from "@/lib/delivery-standard";
import { cn } from "@/lib/utils";
import { PlanMonthForm } from "@/components/planner/plan-month-form";

export const monthLabel = (m: string) =>
  new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}T00:00:00Z`));

function Counts({ counts, total = false }: { counts: Record<string, Count>; total?: boolean }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
      {DELIVERY_KEYS.map((k) => (
        <li key={k} data-deliverable={k} data-used={counts[k].used} data-target={counts[k].target}
          data-remaining={counts[k].remaining} data-credited={counts[k].credited}>
          <span className="text-muted-foreground">{deliveryLabels[k]}:</span>{" "}
          <span className={cn("font-medium", counts[k].over > 0 && "text-amber-800")}>{total ? totalText(counts[k]) : countText(counts[k])}</span>
          {!total && counts[k].used > 0 && <span className="text-xs text-muted-foreground"> ({counts[k].completed} done, {counts[k].planned} planned)</span>}
        </li>
      ))}
    </ul>
  );
}

// One calendar month of the delivery standard against work done and
// planned, per brand site (or the client), with the client's total. Items
// count in the month of their own date, so a week that crosses a month shows
// one card per month. Absent when the client is not on a standard that
// month; an unreadable standard is said, never guessed.
export function DeliveryStandardCard({ clientId, month, delivery, error, canPlan }: {
  clientId: string; month: string; delivery: ClientDelivery | null; error: string | null; canPlan: boolean;
}) {
  if (error) {
    return (
      <section className="rounded-xl bg-card p-3.5 ring-1 ring-border" data-card="delivery-standard" data-month={month}>
        <p role="alert" className="text-sm text-amber-900">The {monthLabel(month)} delivery standard could not be read: {error}</p>
      </section>
    );
  }
  if (!delivery) {
    return (
      <section className="rounded-xl bg-card p-3.5 ring-1 ring-border" data-card="delivery-standard" data-month={month} data-standard="none">
        <p className="text-sm text-muted-foreground">This client is not on a monthly delivery standard for {monthLabel(month)}.</p>
      </section>
    );
  }
  const sites = delivery.units.filter((u) => u.kind !== "unattributed");
  const multi = sites.length > 1;
  const gbp = sharedBusinessProfile(delivery);
  const unattributed = DELIVERY_KEYS.some((k) => delivery.unattributed[k].used > 0);
  const unverified = DELIVERY_KEYS.reduce((n, k) => n + delivery.total[k].unverified, 0);
  const remaining = DELIVERY_KEYS.reduce((n, k) => n + delivery.total[k].remaining, 0);
  return (
    <section className="space-y-2 rounded-xl bg-card p-3.5 ring-1 ring-border" data-card="delivery-standard" data-month={month} data-standard={delivery.standardVersion}>
      <h3 className="text-sm font-semibold text-navy-900">Delivery standard · {monthLabel(month)}</h3>
      <p className="text-xs text-muted-foreground">
        Per {multi ? "brand site" : "client"} for {monthLabel(month)}; each item counts in the month of its own date. Social is
        Facebook only; a refresh updates an existing page and counts once a live check is recorded. New pages are not part of
        the standard. Planned work is not delivered work, and nothing here schedules or publishes.
      </p>
      {sites.map((u) => (
        <div key={u.brandId ?? "client"} className="space-y-0.5" data-unit={u.kind} data-brand={u.brandId ?? ""}>
          {multi && <p className="text-xs font-medium">{u.name}</p>}
          <Counts counts={u.counts} />
          <p className="text-xs text-muted-foreground" data-facebook-destination={u.destinations.facebook_posts ?? ""}>
            {u.destinations.facebook_posts ? `Facebook Page: ${u.destinations.facebook_posts}` : "No verified Facebook Page"}
          </p>
        </div>
      ))}
      {multi && (
        <div className="border-t pt-2" data-unit="total">
          <p className="text-xs font-medium">All {sites.length} brand sites · each site&apos;s own target, summed</p>
          <Counts counts={delivery.total} total />
        </div>
      )}
      <p className="text-xs text-muted-foreground" data-gbp-destination={gbp ?? ""}>
        {gbp
          ? multi
            ? `Business Profile posts for every brand go to ${gbp}, the client's one verified location; each post counts once, for the brand of its service.`
            : `Business Profile posts go to ${gbp}.`
          : "No verified Business Profile location is recorded for this client; Business Profile posts cannot be delivered yet."}
      </p>
      {unverified > 0 && (
        <p className="text-xs text-amber-900" data-unverified-refreshes={unverified}>
          {unverified} refresh{unverified === 1 ? " is" : "es are"} approved without a live receipt (URL, commit, check time, HTTP 200),
          so {unverified === 1 ? "it is" : "they are"} counted as planned, not done.
        </p>
      )}
      {unattributed && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2" data-unit="unattributed">
          <p className="text-xs text-amber-900">Work with no brand service is not credited to any brand. Assign its service to a brand.</p>
          <Counts counts={delivery.unattributed} />
        </div>
      )}
      {canPlan && remaining > 0 && <PlanMonthForm clientId={clientId} month={month} remaining={remaining} />}
    </section>
  );
}
