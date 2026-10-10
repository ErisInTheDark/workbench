/*
 * Exports:
 * - default ComposerReferencePills: render composer references (todos, feedback, update issues) as toned pills whose tooltip shows the reference itself.
 */
"use client";

import { composerReferenceKey, type ComposerReference } from "workbench-shared/workbench/thread/composer-reference";
import { WorkbenchFeedbackReportDisplay } from "../stats/workspaces/WorkbenchStatsFeedbackReport";
import WorkbenchPill from "../WorkbenchPill";
import MarkdownRender from "../../ui/MarkdownRender";
import { BugIcon, MegaphoneIcon } from "../workbench-icons";
import ThreadTodoPill from "./ThreadTodoPill";

/** Hue utilities are listed whole so Tailwind can see them. */
const TONES: Record<Exclude<ComposerReference["kind"], "todo">, string> = {
  feedback: "bg-hue-340/14 text-hue-340",
  updateIssue: "bg-hue-55/16 text-hue-55",
};

function ReferencePill({ onRemove, reference }: { onRemove?: () => void; reference: ComposerReference }) {
  switch (reference.kind) {
    case "todo":
      return (
        <ThreadTodoPill
          id={reference.id}
          onRemove={onRemove}
          removeLabel={`Remove todo ${reference.id}`}
          required={reference.required}
          text={reference.text}
        />
      );
    case "feedback":
      return (
        <WorkbenchPill
          className={TONES.feedback}
          icon={<MegaphoneIcon size={12} />}
          onRemove={onRemove}
          removeLabel={`Remove feedback "${reference.title}"`}
          tooltip={(
            <div className="max-h-[min(24rem,60vh)] w-max max-w-[min(32rem,80vw)] overflow-auto text-[0.84rem] text-text">
              <WorkbenchFeedbackReportDisplay category={reference.category} clamp={false} report={reference.report} title={reference.title} />
            </div>
          )}
        >
          {reference.title}
        </WorkbenchPill>
      );
    case "updateIssue":
      return (
        <WorkbenchPill
          className={TONES.updateIssue}
          icon={<BugIcon size={12} />}
          onRemove={onRemove}
          removeLabel="Remove update issue"
          tooltip={(
            <div className="max-h-[min(24rem,60vh)] w-max max-w-[min(32rem,80vw)] overflow-auto text-[0.84rem] text-text">
              <MarkdownRender markdown={reference.text} />
            </div>
          )}
        >
          Update issue
        </WorkbenchPill>
      );
  }
}

export default function ComposerReferencePills({ className = "", onRemove, references }: {
  className?: string;
  /** Present in the composer; the transcript shows references read-only. */
  onRemove?: (reference: ComposerReference) => void;
  references: readonly ComposerReference[];
}) {
  if (!references.length) return null;
  return (
    <ul aria-label="Attached references" className={`m-0 flex list-none flex-wrap items-center gap-1 p-0 ${className}`}>
      {references.map((reference) => (
        <li className="flex max-w-full" key={composerReferenceKey(reference)}>
          <ReferencePill onRemove={onRemove ? () => onRemove(reference) : undefined} reference={reference} />
        </li>
      ))}
    </ul>
  );
}
