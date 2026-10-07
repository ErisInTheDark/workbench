/*
 * Exports:
 * - default ApprovalReviewSettings: choose the auto-approve reviewer and manage Workbench-held reviewer keys for one daemon.
 */
"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { APPROVAL_REVIEWERS, ApprovalReviewerIdSchema } from "workbench-shared/workbench/approval-review/approval-reviewers";
import type { ApprovalReviewSettingsSnapshot } from "workbench-shared/workbench/approval-review/approval-review-settings";
import ApprovalReviewSettingsController from "../../workbench/ApprovalReviewSettingsController";
import InputList from "./InputList";
import type { InputListRow } from "./input-list-rows";
import { ResetIcon, SaveIcon } from "./workbench-icons";
import WorkbenchIconButton from "./WorkbenchIconButton";
import { WorkbenchOptionCard } from "./WorkbenchOptionCards";
import { useWorkbenchDaemonClient } from "./WorkbenchWorkspaceContext";

const SECRET_REVIEWERS = ApprovalReviewerIdSchema.options.filter(id => APPROVAL_REVIEWERS[id].credential === "workbench-secret");

function secretRows(settings: ApprovalReviewSettingsSnapshot | null): InputListRow[] {
  return SECRET_REVIEWERS.map(id => ({
    id, key: "", value: settings?.reviewers.find(reviewer => reviewer.id === id)?.secret ?? "",
  }));
}

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
  const [rows, setRows] = useState<InputListRow[]>(() => secretRows(null));
  useEffect(() => { setRows(secretRows(state.settings)); }, [state.settings]);
  const saved = secretRows(state.settings);
  const changed = rows.filter(row => row.value.trim() !== (saved.find(item => item.id === row.id)?.value ?? ""));
  const settings = state.settings;

  return <div className="space-y-3 py-3">
    <p className="m-0 text-[0.8rem] leading-5 text-fg/muted">
      Used by daemon-project threads set to Auto-approve. The reviewer approves safe outside-sandbox commands; anything doubtful still asks you.
    </p>
    <div className="space-y-1" role="radiogroup" aria-label="Auto-approve reviewer">
      {ApprovalReviewerIdSchema.options.map(id => {
        const reviewer = settings?.reviewers.find(item => item.id === id);
        return <WorkbenchOptionCard key={id} label={APPROVAL_REVIEWERS[id].label}
          description={<>
            {APPROVAL_REVIEWERS[id].description}
            {reviewer ? <span className={`block ${reviewer.ready ? "text-success" : "text-fg/muted"}`}>{reviewer.detail}</span> : null}
          </>}
          isChecked={settings?.selected === id} disabled={!settings || state.busy}
          onClick={() => { if (settings?.selected !== id) void controller.select(id); }} />;
      })}
    </div>
    {SECRET_REVIEWERS.length ? <>
      <h4 className="m-0 text-xs font-semibold text-text">API keys</h4>
      <InputList idPrefix="approval-review-secret" rowLabel="API key" fixedRows secret
        placeholder={SECRET_REVIEWERS.length === 1 ? `${APPROVAL_REVIEWERS[SECRET_REVIEWERS[0]!].label} API key` : "API key"}
        rowLabels={Object.fromEntries(SECRET_REVIEWERS.map(id => [id, `${APPROVAL_REVIEWERS[id].label} API key`]))}
        disabled={!settings || state.busy} rows={rows} onRowsChange={setRows} />
      <div className="flex items-center gap-2">
        <WorkbenchIconButton type="button" label="Save API keys" disabled={!changed.length || state.busy}
          onClick={() => {
            void (async () => {
              for (const row of changed) {
                await controller.saveSecret(ApprovalReviewerIdSchema.parse(row.id), row.value.trim() || null);
              }
            })();
          }}>
          <SaveIcon size={16} />
        </WorkbenchIconButton>
        <WorkbenchIconButton type="button" label="Reset API key changes" disabled={!changed.length || state.busy}
          onClick={() => setRows(saved)}>
          <ResetIcon size={16} />
        </WorkbenchIconButton>
      </div>
    </> : null}
    {state.busy && !settings ? <p role="status" className="m-0 text-xs text-fg/muted">Loading auto-approve settings...</p> : null}
    {state.error ? <p role="alert" className="m-0 text-xs text-danger">{state.error}</p> : null}
  </div>;
}
