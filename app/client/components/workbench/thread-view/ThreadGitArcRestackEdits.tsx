/*
 * Exports:
 * - GitArcRestackEdit/GitArcRestackSummary: what one restack did, by proposal title.
 * - summarizeGitArcRestack: read drops, strips and folds (and what merely rebased) out of a restack's outcomes.
 * - default ThreadGitArcRestackEdits: those edits as rows; the full body tucks exact paths and rebased titles into inner
 *   disclosures, while a closed card's preview shows only the first rows.
 */
"use client";

import type { ReactNode } from "react";

import type { GitArcRestackResult } from "workbench-shared/workbench/git/git-arc-restack";
import Disclosure, { DisclosureStaticRow } from "../../ui/Disclosure";
import { GitMergeIcon, GitRebaseIcon, MinusIcon, Trash2Icon } from "../workbench-icons";
import { GitArcClaimIcon } from "./GitArcIcon";
import ThreadClaimedFileList from "./ThreadClaimedFileList";

export type GitArcRestackEdit =
  | { kind: "drop"; title: string }
  | { kind: "strip"; paths: readonly string[]; title: string }
  | { into: string; kind: "fold"; title: string };

export interface GitArcRestackSummary {
  edits: GitArcRestackEdit[];
  rebased: string[];
  releasedClaims: readonly string[];
}

export function summarizeGitArcRestack({ proposals, releasedClaims }: GitArcRestackResult): GitArcRestackSummary {
  // A fold's target is published under a new id; its replaced outcome names it.
  const replacementTitles = new Map(proposals.flatMap(outcome => outcome.status === "replaced" ? [[outcome.replacementId, outcome.title] as const] : []));
  const drops: GitArcRestackEdit[] = [];
  const strips: GitArcRestackEdit[] = [];
  const folds: GitArcRestackEdit[] = [];
  const rebased: string[] = [];
  for (const outcome of proposals) {
    if (outcome.status === "rebased") rebased.push(outcome.title);
    else if (outcome.status === "rescinded") drops.push({ kind: "drop", title: outcome.title });
    else {
      if (outcome.stripped.length) strips.push({ kind: "strip", paths: outcome.stripped, title: outcome.title });
      if (outcome.status === "superseded") folds.push({ into: replacementTitles.get(outcome.replacementId) ?? outcome.replacementId, kind: "fold", title: outcome.title });
    }
  }
  return { edits: [...drops, ...strips, ...folds], rebased, releasedClaims };
}

const ROW_TEXT = "text-[0.92em] leading-[1.6] text-fg/muted";
const ICON_SIZE = 14;

const Title = ({ children }: { children: string }) => <b className="font-medium text-text">{children}</b>;
const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

function editText(edit: GitArcRestackEdit): ReactNode {
  if (edit.kind === "drop") return <>Dropped <Title>{edit.title}</Title></>;
  if (edit.kind === "strip") return <>Stripped {files(edit.paths.length)} from <Title>{edit.title}</Title></>;
  return <>Folded <Title>{edit.title}</Title> into <Title>{edit.into}</Title></>;
}

const EDIT_ICONS = {
  drop: <Trash2Icon size={ICON_SIZE} />,
  fold: <GitMergeIcon size={ICON_SIZE} />,
  strip: <MinusIcon size={ICON_SIZE} />,
} satisfies Record<GitArcRestackEdit["kind"], ReactNode>;

/** A row whose details stay folded until asked for; icons line up with static rows because the chevron trails. */
function DetailRow({ children, icon, summary }: { children: ReactNode; icon: ReactNode; summary: ReactNode }) {
  return (
    <Disclosure chevronSide="end" className="py-0.5" contentClassName="pl-6" leading={icon} summary={summary} summaryClassName={ROW_TEXT}>
      {children}
    </Disclosure>
  );
}

export default function ThreadGitArcRestackEdits({ limit, summary }: {
  /** A preview shows this many edit rows and counts the rest; the full body shows everything. */
  limit?: number;
  summary: GitArcRestackSummary;
}) {
  const shown = limit === undefined ? summary.edits : summary.edits.slice(0, limit);
  const remaining = summary.edits.length - shown.length;
  return (
    <div className="space-y-0.5 py-1.5" data-thread-git-arc-restack="true">
      {shown.map((edit, index) => edit.kind === "strip" && limit === undefined ? (
        <DetailRow icon={EDIT_ICONS.strip} key={index} summary={editText(edit)}>
          <ThreadClaimedFileList inset={false} marker="dirty" paths={edit.paths} />
        </DetailRow>
      ) : (
        <DisclosureStaticRow className="!py-0.5" key={index} marker={EDIT_ICONS[edit.kind]} summary={editText(edit)} summaryClassName={ROW_TEXT} />
      ))}
      {remaining > 0 ? <div className="text-[0.78em] leading-[1.6] text-fg/muted">...and {remaining} more</div> : null}
      {limit === undefined && summary.rebased.length ? (
        <DetailRow icon={<GitRebaseIcon size={ICON_SIZE} />} summary={`Rebased ${summary.rebased.length} ${summary.rebased.length === 1 ? "proposal" : "proposals"}`}>
          <ul className="m-0 list-none space-y-0.5 p-0 py-1 text-[0.86em] text-fg/muted">
            {summary.rebased.map((title, index) => <li className="truncate" key={index}>{title}</li>)}
          </ul>
        </DetailRow>
      ) : null}
      {limit === undefined && summary.releasedClaims.length ? (
        <DetailRow icon={<GitArcClaimIcon size={ICON_SIZE} />} summary={`Returned ${files(summary.releasedClaims.length)} to claims`}>
          <ThreadClaimedFileList inset={false} marker="claimed" paths={summary.releasedClaims} />
        </DetailRow>
      ) : null}
    </div>
  );
}
