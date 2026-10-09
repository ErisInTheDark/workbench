/*
 * Exports:
 * - default WorkbenchDraftTitleIcons: glyphs before a draft title for what it carries: images, failed update issues, feedback.
 */
"use client";

import type { DraftReferenceKind } from "workbench-shared/workbench/thread/thread-state";
import { BugIcon, ImageIcon, MegaphoneIcon } from "./workbench-icons";

export default function WorkbenchDraftTitleIcons({ hasImages, referenceKinds = [] }: {
  hasImages: boolean;
  referenceKinds?: readonly DraftReferenceKind[];
}) {
  return (
    <>
      {hasImages ? <ImageIcon className="shrink-0" size={16} /> : null}
      {referenceKinds.includes("updateIssue") ? <BugIcon className="shrink-0" size={16} /> : null}
      {referenceKinds.includes("feedback") ? <MegaphoneIcon className="shrink-0" size={16} /> : null}
    </>
  );
}
