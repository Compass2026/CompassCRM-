"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { StatusControls } from "@/components/inquiries/inquiry-forms";
import type { InquiryRow } from "@/lib/inquiries-data";
import { formatWhen, type InquiryStatus } from "@/lib/inquiries";
import { inquiryWebsite } from "@/lib/client-workspace";
import { cn } from "@/lib/utils";

const stages = [
  { key: "new", label: "New", hint: "Ready for first contact", color: "border-orange-200 bg-orange-50 text-orange-900" },
  { key: "contacted", label: "Contacted", hint: "Keep following up", color: "border-blue-200 bg-blue-50 text-blue-900" },
  { key: "closed", label: "Closed", hint: "Finished or no longer pursuing", color: "border-slate-200 bg-slate-100 text-slate-700" },
] as const;

export function LeadPipeline({ rows, basePath, board = false, unavailable = false, onStage, onOpen }: {
  rows: InquiryRow[];
  basePath: string;
  board?: boolean;
  unavailable?: boolean;
  onStage: (status: InquiryStatus) => void;
  onOpen: () => void;
}) {
  return (
    <section aria-label="Lead pipeline" className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-5">
        <h2 className="font-semibold">Your lead pipeline</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          {board ? "Open a lead to follow up, or move it to the next stage below." : "Choose a stage to see the leads that need your attention."}
        </p>
      </div>
      <div className={cn("grid gap-3", board ? "xl:grid-cols-3" : "grid-cols-3")}>
        {stages.map((stage, index) => {
          const leads = rows.filter((row) => row.status === stage.key);
          return (
            <div key={stage.key} data-pipeline-stage={stage.key} className={cn("min-w-0", board && "rounded-xl bg-slate-50 p-3")}>
              <button type="button" onClick={() => onStage(stage.key)} disabled={unavailable}
                aria-label={`${stage.label}: ${unavailable ? "unavailable" : leads.length} leads`}
                className="group relative flex w-full flex-col items-center rounded-xl py-2 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50">
                <span className={cn("grid size-14 place-items-center rounded-full border-2 text-xl font-semibold transition group-hover:shadow-md sm:size-16", stage.color)}>
                  {unavailable ? "?" : leads.length}
                </span>
                <span className="mt-2 text-sm font-semibold">{stage.label}</span>
                <span className="mt-1 text-[11px] leading-4 text-slate-500">{stage.hint}</span>
                {!board && index < stages.length - 1 && <ArrowRight aria-hidden="true" className="absolute top-7 -right-3 size-4 text-slate-300" />}
              </button>
              {board && !unavailable && (
                <ul className="mt-4 space-y-3">
                  {leads.map((lead) => (
                    <li key={lead.id} data-pipeline-lead={lead.id} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                      <Link href={`${basePath}?lead=${encodeURIComponent(lead.id)}`} onClick={onOpen} scroll={false}
                        className="block rounded-md focus-visible:outline-2 focus-visible:outline-blue-600">
                        <p className="break-words text-sm font-semibold text-slate-900">{lead.name}</p>
                        <p className="mt-1 truncate text-[11px] text-blue-700">{inquiryWebsite(lead.page_url)}</p>
                        <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{lead.message}</p>
                        <time dateTime={lead.received_at} className="mt-2 block text-[10px] text-slate-400">{formatWhen(lead.received_at)}</time>
                        <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-700">Open lead <ArrowRight className="size-3" aria-hidden="true" /></span>
                      </Link>
                      <div className="mt-3 border-t border-slate-100 pt-3">
                        <StatusControls key={lead.status} inquiryId={lead.id} status={lead.status} path={basePath} />
                      </div>
                    </li>
                  ))}
                  {!leads.length && <li className="rounded-xl border border-dashed border-slate-200 p-5 text-center text-xs text-slate-500">No leads in this stage.</li>}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
