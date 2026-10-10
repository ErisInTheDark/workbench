/*
 * Exports:
 * - default ComposerReferencePills: render composer references (todos, feedback, update issues) as toned pills whose tooltip shows the reference itself.
 */
"use client";

import { composerReferenceKey, type ComposerReference } from "workbench-shared/workbench/thread/composer-reference";
import { WorkbenchFeedbackReportDisplay } from "../stats/workspaces/WorkbenchStatsFeedbackReport";
import WorkbenchPill from "../WorkbenchPill";
import MarkdownRender from "../../ui/MarkdownRender";
import { AsteriskIcon, BugIcon, ClipboardListIcon, MegaphoneIcon } from "../workbench-icons";

/** Hue utilities are listed whole so Tailwind can see them. */
const TONES: Record<ComposerReference["kind"], string> = {
  todo: "bg-hue-250/14 text-hue-250",
  feedback: "bg-hue-340/14 text-hue-340",
  updateIssue: "bg-hue-55/16 text-hue-55",
};

function describe(reference: ComposerReference) {
  switch (reference.kind) {
    case "todo":
      return {
        icon: <><ClipboardListIcon size={12} />{reference.required ? <AsteriskIcon aria-label="required" size={12} /> : null}</>,
        text: <>#{reference.id} {reference.text.split("\n")[0]!.replace(/[*_`~]+/gu, "")}</>,
        name: `todo ${reference.id}`,
      };
    case "feedback":
      return { icon: <MegaphoneIcon size={12} />, text: reference.title, name: `feedback "${reference.title}"` };
    case "updateIssue":
      return { icon: <BugIcon size={12} />, text: "Update issue", name: "update issue" };
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
      {references.map((reference) => {
        const { icon, name, text } = describe(reference);
        return (
          <li className="flex max-w-full" key={composerReferenceKey(reference)}>
            <WorkbenchPill
              className={TONES[reference.kind]}
              icon={icon}
              onRemove={onRemove ? () => onRemove(reference) : undefined}
              removeLabel={`Remove ${name}`}
              tooltip={(
                <div className="max-h-[min(24rem,60vh)] w-max max-w-[min(32rem,80vw)] overflow-auto text-[0.84rem] text-text">
                  {reference.kind === "feedback" ? (
                    <WorkbenchFeedbackReportDisplay category={reference.category} clamp={false} report={reference.report} title={reference.title} />
                  ) : <MarkdownRender markdown={reference.text} />}
                </div>
              )}
            >
              {text}
            </WorkbenchPill>
          </li>
        );
      })}
    </ul>
  );
}
