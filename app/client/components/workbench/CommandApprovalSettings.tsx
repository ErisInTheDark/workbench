/*
 * Exports:
 * - default CommandApprovalSettings: bind a project settings controller to its mounted lifetime.
 * Local view renders saved permissions and removal intent.
 */
"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import CommandApprovalSettingsController from "../../workbench/CommandApprovalSettingsController";
import { useWorkbenchDaemonClient } from "./WorkbenchDaemonClientContext";
import { XIcon } from "./workbench-icons";
import WorkbenchIconButton from "./WorkbenchIconButton";

export default function CommandApprovalSettings({ projectId }: { projectId: string }) {
  const daemon = useWorkbenchDaemonClient();
  const [controller, setController] = useState<CommandApprovalSettingsController | null>(null);
  useEffect(() => {
    const next = new CommandApprovalSettingsController({
      read: () => daemon.commandApprovals.read({ projectId }),
      remove: id => daemon.commandApprovals.remove({ projectId, id }),
    });
    setController(next);
    void next.refresh();
    return () => next.dispose();
  }, [daemon, projectId]);
  return controller ? <CommandApprovalSettingsView controller={controller} /> : null;
}

function CommandApprovalSettingsView({ controller }: { controller: CommandApprovalSettingsController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return <section className="space-y-3 py-3" aria-label="Saved command approvals">
    <h3 className="m-0 text-[0.94rem] font-medium text-text">Saved command approvals</h3>
    {state.error ? <p role="alert" className="m-0 text-[0.82rem] text-danger">{state.error}</p> : null}
    {state.loading ? <p role="status" className="m-0 text-[0.82rem] text-fg/muted">Loading approvals...</p> : null}
    {!state.loading && !state.error && !state.rules.length ? <p className="m-0 text-[0.82rem] text-fg/muted">No saved command approvals.</p> : null}
    <div className="space-y-2">
      {state.rules.map(rule => <div key={rule.id} className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <code className="block whitespace-pre-wrap break-all text-[0.82rem] text-text">
            {rule.prefix.map(token => /\s/u.test(token) ? JSON.stringify(token) : token).join(" ")}
          </code>
          <p className="m-0 break-all font-mono text-[0.78rem] text-fg/muted">{rule.workdir}</p>
        </div>
        <WorkbenchIconButton
          display="hover-border"
          size="small"
          tone="danger"
          disabled={state.loading}
          label={`Remove approval for ${rule.prefix.join(" ")} in ${rule.workdir}`}
          onClick={() => { void controller.remove(rule.id); }}
        >
          <XIcon size={16} />
        </WorkbenchIconButton>
      </div>)}
    </div>
  </section>;
}
