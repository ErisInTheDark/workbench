/*
 * Exports:
 * - WorkbenchNetworkSyncState: what this computer knows about syncing the network's member list from its owner.
 * - default WorkbenchNetworkSync: whether this computer is in sync with the network's owner, what a failure means here,
 *   a retry, and the raw failure in an error card.
 */
"use client";
import ErrorCard from "../ui/ErrorCard";
import PrimaryButton from "../ui/PrimaryButton";
import SettingsCard, { SettingsCardRow } from "../ui/SettingsCard";
import { CheckIcon, RefreshCwIcon, TriangleAlertIcon } from "./workbench-icons";

export type WorkbenchNetworkSyncState =
  | { kind: "owner" }
  | { kind: "synced"; owner: string; revision: number }
  | { kind: "failed"; owner: string | null; ownerOnline: boolean | null; detail: string | null };

export default function WorkbenchNetworkSync({ state, busy, onRetry }: {
  state: WorkbenchNetworkSyncState; busy: boolean; onRetry(): void;
}) {
  const failed = state.kind === "failed";
  const owner = state.kind === "owner" ? null : state.owner ?? "this network's owner";
  const title = state.kind === "owner" ? "This computer owns this network"
    : failed ? `Couldn't sync with ${owner}` : `In sync with ${owner}`;
  const detail = state.kind === "owner" ? "Other computers sync their member list from here."
    : state.kind === "synced" ? `Member list revision ${state.revision}.`
      : `${state.owner ? `${state.owner} owns this network${state.ownerOnline === false ? " and is offline right now" : ""}. ` : ""}This computer keeps using the member list it has and retries every minute.`;
  return <SettingsCard label="Network sync">
    <SettingsCardRow>
      <div role="status" className="w-full space-y-2">
        <div className="flex w-full items-start gap-3">
          {failed ? <TriangleAlertIcon className="mt-0.5 size-5 shrink-0 text-[color:var(--attention)]" />
            : <CheckIcon className="mt-0.5 size-5 shrink-0 text-success" />}
          <div className="min-w-0 flex-1">
            <p className={`m-0 font-semibold ${failed ? "text-[color:var(--attention)]" : "text-success"}`}>{title}</p>
            <p className="m-0 text-sm text-fg/muted">{detail}</p>
          </div>
          {failed ? <PrimaryButton shape="compact" disabled={busy} onClick={onRetry}><RefreshCwIcon className="mr-1.5 size-4" />Try again</PrimaryButton> : null}
        </div>
        {failed && state.detail ? <ErrorCard className="ml-8">{state.detail}</ErrorCard> : null}
      </div>
    </SettingsCardRow>
  </SettingsCard>;
}
