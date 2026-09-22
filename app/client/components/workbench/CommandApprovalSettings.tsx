/*
 * Exports:
 * - default CommandApprovalSettings: bind a project settings controller to its mounted lifetime.
 * Local view renders authoritative permissions and removal/refresh intent.
 */
"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import CommandApprovalSettingsController from "../../workbench/CommandApprovalSettingsController";
import { useWorkbenchDaemonClient } from "./WorkbenchDaemonClientContext";

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
  const buttonClass = "shrink-0 rounded px-2 py-1 text-[0.82rem] text-fg/muted hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-45";
  return <section className="space-y-3 py-3" aria-label="Saved command approvals">
    <div className="flex items-center justify-between gap-3">
      <h3 className="m-0 text-[0.94rem] font-medium text-text">Saved command approvals</h3>
      <button type="button" className={buttonClass} disabled={state.loading} onClick={() => { void controller.refresh(); }}>Refresh</button>
    </div>
    <p className="m-0 text-[0.82rem] leading-5 text-fg/muted">
      Codex commands approved outside the sandbox for this project and exact execution directory.
      Trailing arguments and future script contents are included. Each use still requires explicit single-command confirmation.
    </p>
    {state.error ? <p role="alert" className="m-0 text-[0.82rem] text-danger">{state.error}</p> : null}
    {state.loading ? <p role="status" className="m-0 text-[0.82rem] text-fg/muted">Loading approvals...</p> : null}
    {!state.loading && !state.error && !state.rules.length ? <p className="m-0 text-[0.82rem] text-fg/muted">No saved command approvals.</p> : null}
    <div className="space-y-2">
      {state.rules.map(rule => <div key={rule.id} className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <code className="block whitespace-pre-wrap break-all text-[0.82rem] text-text">{JSON.stringify(rule.prefix)}</code>
          <p className="m-0 break-all font-mono text-[0.78rem] text-fg/muted">{rule.workdir}</p>
        </div>
        <button type="button" className={buttonClass} disabled={state.loading}
          aria-label={`Remove approval for ${JSON.stringify(rule.prefix)} in ${rule.workdir}`}
          onClick={() => { void controller.remove(rule.id); }}>Remove</button>
      </div>)}
    </div>
  </section>;
}
