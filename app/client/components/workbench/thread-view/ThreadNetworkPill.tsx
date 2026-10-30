/*
 * Exports:
 * - default ThreadNetworkPanel: the remote threads, folders and feedback the user let this thread reach, each revocable while
 *   still active.
 */
"use client";

import { useState } from "react";
import type { NetworkHistoryEntry } from "workbench-shared/workbench/network/network-grants";
import { NetworkGrant } from "workbench-shared/workbench/network/network-grants";
import WorkbenchRelativeTime from "../WorkbenchRelativeTime";

export default function ThreadNetworkPanel({ history, onRevoke }: {
  history: readonly NetworkHistoryEntry[];
  onRevoke(entry: NetworkHistoryEntry): Promise<void>;
}) {
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const revoke = async (entry: NetworkHistoryEntry) => {
    setRevoking(entry.id);
    setError("");
    try { await onRevoke(entry); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The access could not be revoked."); }
    finally { setRevoking(null); }
  };
  return <div className="flex flex-col gap-2 px-3.5 py-3">
    <p className="m-0 text-sm text-fg/muted">Revoking stops new access; this thread keeps what it already read.</p>
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {history.map(entry => (
        <li className="flex min-w-0 items-center gap-2 text-sm" key={entry.id}>
          <span className="min-w-0 flex-1 truncate text-text" title={NetworkGrant.targetLabel(entry.target)}>
            {NetworkGrant.targetLabel(entry.target)}
          </span>
          <code className="shrink-0 text-[0.8rem] text-fg/muted">{entry.target.hostname}</code>
          {entry.revokedAt !== null
            ? <span className="shrink-0 text-fg/muted">revoked <WorkbenchRelativeTime format="short" timestampMs={entry.revokedAt} tooltip={false} /></span>
            : <button
              className="shrink-0 rounded-md px-2 py-0.5 text-danger hover:bg-danger/10 disabled:opacity-50"
              disabled={revoking !== null}
              onClick={() => { void revoke(entry); }}
              type="button"
            >{revoking === entry.id ? "Revoking..." : "Revoke"}</button>}
        </li>
      ))}
    </ul>
    {error ? <p role="alert" className="m-0 text-[0.84em] text-danger">{error}</p> : null}
  </div>;
}
