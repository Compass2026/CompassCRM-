// Renders the reason Postgres refused an action (a sequencing gate, or the
// Foundation enrollment protection). Server actions redirect here with the
// message rather than throwing into the error boundary.
export function BlockedBanner({
  message,
  hint,
}: {
  message?: string;
  hint?: string;
}) {
  if (!message) return null;
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <p className="font-medium">{message}</p>
      {hint && <p className="text-xs mt-0.5 text-amber-800">{hint}</p>}
    </div>
  );
}
