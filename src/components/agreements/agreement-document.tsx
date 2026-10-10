import Image from "next/image";
import { agreementPrice, agreementTermBlocks, serviceLine, type Contract } from "@/lib/agreements";

export function AgreementDocument({ contract: c }: { contract: Contract }) {
  const s = c.snapshot;
  return (
    <article className="rounded-xl border border-t-4 border-t-orange-500 bg-white p-6 text-slate-900 shadow-sm sm:p-9">
      <header className="mb-7 border-b border-slate-200 pb-6 text-center">
      {s.issuer_name === "Compass Marketing Advisors LLC" ? (
        <Image src="/compass-agreement-logo.png" alt="Compass Marketing" width={1045} height={1037} sizes="112px" className="mx-auto mb-4 h-auto w-28 rounded-lg" />
      ) : null}
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
        {s.issuer_name}
      </p>
      <h2 className="mt-3 font-serif text-3xl font-semibold leading-tight">{c.title}</h2>
      </header>
      <p className="mt-4 font-medium">{s.scope.client_name}</p>
      {c.recipient_name && (
        <p className="text-sm text-slate-600">
          For {c.recipient_name} ({c.recipient_email})
        </p>
      )}
      <dl className="my-6 grid gap-4 rounded-lg bg-slate-50 p-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-slate-500">Fee</dt>
          <dd className="font-semibold">{agreementPrice(s.scope)}</dd>
        </div>
        <div>
          <dt className="text-sm text-slate-500">Service start</dt>
          <dd>{s.scope.plan.start_date ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt className="text-sm text-slate-500">Term</dt>
          <dd>
            {s.scope.plan.term_months
              ? `${s.scope.plan.term_months} months`
              : "Month-to-month"}
          </dd>
        </div>
      </dl>
      <h3 className="font-semibold">Included services</h3>
      <ul className="mt-3 grid list-disc gap-1 pl-5 text-sm sm:grid-cols-2">
        {s.scope.services.map((s) => (
          <li key={s.name}>{serviceLine(s)}</li>
        ))}
      </ul>
      {!!s.scope.plan.managed_ad_budget_cents && (
        <p className="mt-3 text-sm">
          Managed advertising budget:{" "}
          {s.scope.plan.managed_ad_budget_cents / 100}{" "}
          {s.scope.plan.currency.toUpperCase()}
        </p>
      )}
      <h3 className="mt-7 font-semibold">Agreement terms</h3>
      <div className="mt-4 space-y-4 break-words text-sm leading-7">
        {s.terms ? agreementTermBlocks(s.terms).map((block, index) => (
          block.heading
            ? <h4 key={index} className="pt-3 font-serif text-lg font-semibold leading-snug">{block.text}</h4>
            : <p key={index} className="whitespace-pre-wrap">{block.text}</p>
        )) : "Add your existing contract terms before issuing this agreement."}
      </div>
      {c.provider_name && (
        <p className="mt-7 text-sm">
          Signed for {s.issuer_name}: <strong>{c.provider_name}</strong>
          <br />
          {c.provider_signed_at}
        </p>
      )}
      {c.signed_at && (
        <p className="mt-4 text-sm">
          Signed for {s.scope.client_name}: <strong>{c.signer_name}</strong>
          <br />
          {c.signed_at}
          <br />
          Email verified: {c.recipient_email}
        </p>
      )}
      {c.content_hash && (
        <p className="mt-6 break-all text-xs text-slate-500">
          Agreement {c.id}
          <br />
          Content SHA-256: {c.content_hash}
        </p>
      )}
    </article>
  );
}
