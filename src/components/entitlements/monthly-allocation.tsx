import { targetText, type QuotaUsage } from "@/lib/entitlements";
import { cn } from "@/lib/utils";

// This month's agreed deliverables against the work planned or done (B5):
// "3 / 4 planned" per quota, from client_quota_usage(). Work beyond the
// allocation is shown, never hidden. When entitlements cannot be read the
// card says so: automatic planning is paused for the client until they can.
export function MonthlyAllocation({
  usage,
  unavailable,
  only,
  title = "This month's plan",
  className,
}: {
  usage: QuotaUsage[];
  unavailable?: string | null;
  only?: QuotaUsage["key"][];
  title?: string;
  className?: string;
}) {
  const rows = only ? usage.filter((u) => only.includes(u.key)) : usage;
  return (
    <section className={cn("rounded-xl bg-card p-3.5 ring-1 ring-border", className)} data-card="monthly-allocation">
      <h3 className="text-sm font-semibold text-navy-900">{title}</h3>
      {unavailable ? (
        <p role="alert" className="mt-1 text-sm text-amber-900" data-entitlements-unavailable>
          The client&apos;s entitlements could not be read, so automatic planning is paused for this client. {unavailable}
        </p>
      ) : (
        <>
          <ul className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {rows.map((u) => (
              <li key={u.key} data-quota={u.key} data-used={u.used} data-allocation={u.allocation}>
                <span className="text-muted-foreground">{u.name}:</span>{" "}
                <span className={cn("font-medium", u.overAllocation > 0 && "text-amber-800")}>{targetText(u)}</span>
                {u.used > 0 && (
                  <span className="text-xs text-muted-foreground"> ({u.completed} done, {u.planned} in progress)</span>
                )}
              </li>
            ))}
          </ul>
          {rows.some((u) => u.overAllocation > 0) && (
            <p className="mt-1 text-xs text-muted-foreground">
              Work beyond the agreement is kept; automation adds nothing more of that kind this month.
            </p>
          )}
        </>
      )}
    </section>
  );
}
