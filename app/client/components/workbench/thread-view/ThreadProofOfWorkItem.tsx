/*
 * Exports:
 * - default ThreadProofOfWorkItem: show consecutive checklist proofs as one card.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { countProofs, formatProofId, isNotApplicable, mergeProofs, proofFamilies, ProofOfWorkSchema } from "workbench-shared/workbench/thread/proof-of-work";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import { CertificateIcon, CheckIcon, MinusIcon } from "../workbench-icons";
import ThreadCard from "./ThreadCard";

export default function ThreadProofOfWorkItem({ items }: { items: Extract<ThreadItem, { type: "mcpToolCall" }>[] }) {
  const proofs = mergeProofs(items.flatMap(item => {
    const parsed = conformToZodSchema(ProofOfWorkSchema, item.arguments);
    return parsed.success ? [parsed.data.proofs] : [];
  }));
  const counts = countProofs(proofs);
  const entries = Object.entries(proofs);
  const answered = entries.filter(([, answer]) => !isNotApplicable(answer));
  const notApplicable = entries.filter(([, answer]) => isNotApplicable(answer));
  return (
    <ThreadCard
      icon={<CertificateIcon size={16} />}
      label="Proof of work:"
      subject={<span className="inline-flex min-w-0 items-center gap-3.5"><span className="truncate font-semibold text-text">{proofFamilies(proofs).join(", ")}</span><span className="inline-flex shrink-0 items-center gap-1"><CheckIcon className="translate-y-px" size={14} />{counts.answered}</span><span className="inline-flex shrink-0 items-center gap-1"><MinusIcon className="translate-y-px" size={14} />{counts.notApplicable}</span></span>}
    >
      <div className="space-y-2">
        <dl className="space-y-2">
          {answered.map(([id, answer]) => (
            <div className="flex gap-2" key={id}>
              <span className="mt-1 shrink-0 translate-y-[2px] text-success"><CheckIcon size={14} /></span>
              <div><dt className="font-semibold text-text">{formatProofId(id)}</dt><dd className="m-0 text-fg/muted">{answer}</dd></div>
            </div>
          ))}
        </dl>
        {notApplicable.length ? (
          <div className="flex gap-2 text-fg/muted">
            <span className="mt-1 shrink-0 translate-y-[2px]"><MinusIcon size={14} /></span>
            <span><span className="font-semibold">Not applicable: </span>{notApplicable.map(([id]) => formatProofId(id)).join(", ")}</span>
          </div>
        ) : null}
      </div>
    </ThreadCard>
  );
}
