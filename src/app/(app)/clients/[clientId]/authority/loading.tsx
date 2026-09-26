// Shown while the Authority reads load.
export default function AuthorityLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading Authority analysis">
      <div className="surface-tint h-36 animate-pulse" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />)}
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}
