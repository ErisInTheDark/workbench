/*
 * Exports:
 * - default ThreadProofOfWorkItem: show consecutive checklist proofs as one card, leaving out hidden checklists.
 */
import { useContext, type ReactNode } from "react";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { mergeProofs, presentProofOfWork, readProofOfWorkSubmission } from "workbench-shared/workbench/thread/proof-of-work";
import { CertificateIcon, CheckIcon, ClockIcon, MinusIcon } from "../workbench-icons";
import ThreadCard from "./ThreadCard";
import { ThreadProofOfWorkCatalogueContext } from "./use-proof-of-work-catalogue";

function Count({ count, icon }: { count: number; icon: ReactNode }) {
  return count ? <span className="inline-flex shrink-0 items-center gap-1">{icon}{count}</span> : null;
}

function LabelList({ icon, labels, title }: { icon: ReactNode; labels: readonly string[]; title: string }) {
  if (!labels.length) return null;
  return (
    <div className="flex gap-2 text-fg/muted">
      <span className="mt-1 shrink-0 translate-y-[2px]">{icon}</span>
      <span><span className="font-semibold">{title}: </span>{labels.join(", ")}</span>
    </div>
  );
}

export default function ThreadProofOfWorkItem({ items }: { items: Extract<ThreadItem, { type: "mcpToolCall" }>[] }) {
  const checklists = useContext(ThreadProofOfWorkCatalogueContext);
  const proof = presentProofOfWork(mergeProofs(items.flatMap(item => readProofOfWorkSubmission(item) ?? [])), checklists);
  if (!proof.families.length) return null;
  return (
    <ThreadCard
      icon={<CertificateIcon size={16} />}
      label="Proof of work:"
      subject={(
        <span className="inline-flex min-w-0 items-center gap-3.5">
          <span className="truncate font-semibold text-text">{proof.families.join(", ")}</span>
          <Count count={proof.answered.length} icon={<CheckIcon className="translate-y-px" size={14} />} />
          <Count count={proof.notApplicable.length} icon={<MinusIcon className="translate-y-px" size={14} />} />
          <Count count={proof.deferred.length} icon={<ClockIcon className="translate-y-px" size={14} />} />
        </span>
      )}
    >
      <div className="space-y-2">
        <dl className="space-y-2">
          {proof.answered.map(({ answer, id, label }) => (
            <div className="flex gap-2" key={id}>
              <span className="mt-1 shrink-0 translate-y-[2px] text-success"><CheckIcon size={14} /></span>
              <div><dt className="font-semibold text-text">{label}</dt><dd className="m-0 text-fg/muted">{answer}</dd></div>
            </div>
          ))}
        </dl>
        <LabelList icon={<MinusIcon size={14} />} labels={proof.notApplicable.map(entry => entry.label)} title="Not applicable" />
        <LabelList icon={<ClockIcon size={14} />} labels={proof.deferred.map(entry => entry.label)} title="Deferred" />
      </div>
    </ThreadCard>
  );
}
