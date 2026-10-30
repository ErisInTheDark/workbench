/*
 * Exports:
 * - default ThreadNetworkPanel: the remote threads, folders and feedback this thread can still reach, each revocable, with a
 *   hold-to-confirm revoke for all of them.
 */
"use client";

import { useState } from "react";
import type { NetworkHistoryEntry } from "workbench-shared/workbench/network/network-access";
import IconButton from "../../ui/IconButton";
import PrimaryButton from "../../ui/PrimaryButton";
import { UnlinkIcon } from "../workbench-icons";
import NetworkTargetDisplay from "./NetworkTargetDisplay";

const BULK_HOLD_MS = 700;

export default function ThreadNetworkPanel({ history, onRevoke }: {
  history: readonly NetworkHistoryEntry[];
  onRevoke(entry: NetworkHistoryEntry): Promise<void>;
}) {
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const active = history.filter(entry => entry.revokedAt === null);
  if (!active.length) return null;
  const revoke = async (entries: readonly NetworkHistoryEntry[]) => {
    const ids = entries.map(entry => entry.id);
    setRevoking(current => new Set([...current, ...ids]));
    setError("");
    try {
      for (const entry of entries) await onRevoke(entry);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The access could not be revoked.");
    } finally {
      setRevoking(current => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  };
  return <div className="space-y-1 px-2 py-2" data-thread-network-access="true">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2">
      <p className="m-0 min-w-0 text-[0.72em] text-fg/muted">
        Networked with {active.length} remote {active.length === 1 ? "target" : "targets"}
      </p>
      {active.length > 1 ? (
        <PrimaryButton
          disabled={revoking.size > 0}
          holdToConfirmMs={BULK_HOLD_MS}
          onClick={() => void revoke(active)}
          shape="compact"
          title="Hold to revoke all of this thread's network access"
        >
          <UnlinkIcon className="mr-1.5" size={14} />Revoke all
        </PrimaryButton>
      ) : null}
    </div>
    <ul aria-label="Network access" className="m-0 list-none space-y-0.5 p-0">
      {active.map(entry => {
        const pending = revoking.has(entry.id);
        return <li className={`flex min-w-0 items-center gap-1 ${pending ? "opacity-60" : ""}`} key={entry.id}>
          <div className="min-w-0 flex-1"><NetworkTargetDisplay compact target={entry.target} /></div>
          <IconButton
            disabled={pending}
            display="hover-border"
            label="Revoke access"
            onClick={() => void revoke([entry])}
            pendingHalo={pending}
            size="small"
          >
            <UnlinkIcon size={16} />
          </IconButton>
        </li>;
      })}
    </ul>
    {error ? <p className="m-0 px-2 text-[0.74em] text-danger" role="alert">{error}</p> : null}
  </div>;
}
