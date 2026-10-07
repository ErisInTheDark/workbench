/*
 * Exports:
 * - default ApprovalReviewSettings: choose the auto-approve reviewer for one daemon; unavailable reviewers are disabled with a short reason.
 */
"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { APPROVAL_REVIEWERS, ApprovalReviewerIdSchema, type ApprovalReviewerId } from "workbench-shared/workbench/approval-review/approval-reviewers";
import ApprovalReviewSettingsController, { type ApprovalReviewSettingsState } from "../../workbench/ApprovalReviewSettingsController";
import { EyeIcon, EyeOffIcon } from "./workbench-icons";
import WorkbenchIconButton from "./WorkbenchIconButton";
import { WorkbenchOptionCard } from "./WorkbenchOptionCards";
import WorkbenchTextField from "./WorkbenchTextField";
import { useWorkbenchDaemonClient } from "./WorkbenchWorkspaceContext";

export default function ApprovalReviewSettings() {
  const daemon = useWorkbenchDaemonClient();
  const controller = useMemo(() => new ApprovalReviewSettingsController({
    read: () => daemon.approvalReview.read(),
    update: update => daemon.approvalReview.update(update),
  }), [daemon]);
  useEffect(() => {
    void controller.refresh();
    return () => controller.dispose();
  }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const settings = state.settings;

  return <div className="grid gap-2 py-1" role="radiogroup" aria-label="Auto-approve reviewer">
    {ApprovalReviewerIdSchema.options.map(id => {
      const reviewer = settings?.reviewers.find(item => item.id === id);
      const secret = APPROVAL_REVIEWERS[id].credential === "workbench-secret";
      return <WorkbenchOptionCard key={id} density="tight" label={APPROVAL_REVIEWERS[id].label}
        isChecked={settings?.selected === id} disabled={!reviewer?.ready || state.busy}
        onClick={() => { if (settings?.selected !== id) void controller.select(id); }}
        inlineContent={secret
          ? <ReviewerKey id={id} state={state} controller={controller} />
          : reviewer && !reviewer.ready ? <span className="ml-auto text-[0.76em] text-fg/muted">{reviewer.detail}</span> : null} />;
    })}
    {state.error ? <p role="alert" className="m-0 text-xs text-danger">{state.error}</p> : null}
  </div>;
}

/** The reviewer's Workbench-held key, saved when focus leaves the field or on Enter; clearing it removes the key. */
function ReviewerKey({ id, state, controller }: {
  id: ApprovalReviewerId;
  state: ApprovalReviewSettingsState;
  controller: ApprovalReviewSettingsController;
}) {
  const saved = state.settings?.reviewers.find(reviewer => reviewer.id === id)?.secret ?? "";
  const [value, setValue] = useState(saved);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => { setValue(saved); }, [saved]);
  const label = `${APPROVAL_REVIEWERS[id].label} key`;
  function commit() {
    const next = value.trim();
    if (next === saved) return;
    void controller.saveSecret(id, next || null, { select: Boolean(next) && !state.settings?.selected });
  }
  return <div className="ml-2 flex min-w-0 flex-1 basis-48 items-center"
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) commit(); }}>
    <WorkbenchTextField variant="flush" className="flex-1 font-mono placeholder:font-sans" aria-label={label} placeholder="Jev key"
      type={revealed ? "text" : "password"} autoComplete="off" spellCheck={false} disabled={!state.settings}
      value={value} onChange={event => setValue(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter") commit(); }} />
    {value ? <WorkbenchIconButton type="button" size="small" display="hover-border" label={revealed ? `Hide ${label}` : `Show ${label}`}
      aria-pressed={revealed} onClick={() => setRevealed(current => !current)}>
      {revealed ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
    </WorkbenchIconButton> : null}
  </div>;
}
