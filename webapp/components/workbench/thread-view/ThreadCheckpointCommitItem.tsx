/*
 * Exports:
 * - default ThreadCheckpointCommitItem: render and operate a durable checkpoint commit proposal with a frozen file set. Keywords: thread, checkpoint, proposal, commit, newer changes.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import {
  GitCheckpointProposalSchema,
  type GitCheckpointProposal,
} from "../../../lib/workbench/git/checkpoint-contracts";
import reportClientSchemaError from "../../../lib/workbench/report-client-schema-error";
import PrimaryButton from "../PrimaryButton";
import { CheckIcon } from "../workbench-icons";
import PlaintextEditable from "./PlaintextEditable";
import { ThreadFileChangeList } from "./ThreadFileChangeItem";

type ProposalLoadState =
  | { error: string; status: "error" }
  | { proposal: GitCheckpointProposal; status: "loaded" }
  | { status: "loading" };

async function readProposalResponse(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    try {
      const errorPayload = JSON.parse(text) as { error?: string };
      throw new Error(errorPayload.error || "Unable to load checkpoint proposal.");
    } catch (error) {
      if (error instanceof Error && error.message !== "Unexpected end of JSON input") throw error;
      throw new Error(text.trim() || "Unable to load checkpoint proposal.");
    }
  }
  const parsed = GitCheckpointProposalSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    reportClientSchemaError("Rejected checkpoint proposal response", parsed.error);
    throw new Error("Workbench returned an invalid checkpoint proposal response.");
  }
  return parsed.data;
}

export default function ThreadCheckpointCommitItem({
  cwd,
  projectFilePaths,
  projectId,
  projectRootPath,
  proposalId,
  sourceItemId,
  threadId,
  workspaceRoots,
}: {
  cwd: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  proposalId: string;
  sourceItemId: string;
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const initializedEditorRef = useRef(false);
  const [includeNewer, setIncludeNewer] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [committing, setCommitting] = useState(false);
  const [state, setState] = useState<ProposalLoadState>({ status: "loading" });

  const loadProposal = useCallback(async (signal?: AbortSignal) => {
    setState((current) => current.status === "loaded" ? current : { status: "loading" });
    try {
      const proposal = await readProposalResponse(await fetch("/api/git-checkpoint", {
        body: JSON.stringify({ action: "proposalState", cwd, includeNewer, proposalId, threadId }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal,
      }));
      if (signal?.aborted) return;
      if (!initializedEditorRef.current || proposal.status !== "proposed") {
        initializedEditorRef.current = true;
        setTitle(proposal.title);
        setDescription(proposal.description);
      }
      if (!proposal.includeNewerAvailable && includeNewer) setIncludeNewer(false);
      setState({ proposal, status: "loaded" });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        error: error instanceof Error ? error.message : "Unable to load checkpoint proposal.",
        status: "error",
      });
    }
  }, [cwd, includeNewer, proposalId, threadId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadProposal(controller.signal);
    const refreshOnFocus = () => { void loadProposal(); };
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [loadProposal]);

  const commit = async () => {
    if (!title.trim() || committing) return;
    setCommitting(true);
    try {
      const proposal = await readProposalResponse(await fetch("/api/git-checkpoint", {
        body: JSON.stringify({
          action: "proposalCommit",
          cwd,
          description,
          includeNewer,
          proposalId,
          threadId,
          title,
        }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }));
      setTitle(proposal.title);
      setDescription(proposal.description);
      setState({ proposal, status: "loaded" });
    } catch (error) {
      setState({
        error: error instanceof Error ? error.message : "Unable to commit checkpoint proposal.",
        status: "error",
      });
    } finally {
      setCommitting(false);
    }
  };

  if (state.status === "loading") return <p className="m-0 py-3 text-[0.88em] text-muted">Loading commit proposal...</p>;
  if (state.status === "error") {
    return (
      <div className="space-y-2 py-3 text-[0.88em]">
        <p className="m-0 text-[color:var(--danger)]">{state.error}</p>
        <button type="button" className="rounded-full px-3 py-1.5 text-muted hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] hover:text-text" onClick={() => void loadProposal()}>
          Try again
        </button>
      </div>
    );
  }

  const { proposal } = state;
  const terminal = proposal.status !== "proposed";
  return (
    <div className="space-y-4 py-2">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[0.78em] font-medium uppercase tracking-[0.08em] text-muted">
          {proposal.status === "committed" ? <CheckIcon className="size-4 text-[color:var(--success)]" /> : null}
          <span>{proposal.status === "committed" ? "Committed" : proposal.status === "unavailable" ? "Commit not created" : "Proposed commit"}</span>
          {proposal.committedSha ? <span className="font-mono normal-case tracking-normal">{proposal.committedSha.slice(0, 8)}</span> : null}
        </div>
        <PlaintextEditable
          ariaLabel="Commit title"
          className="min-h-7 w-full rounded-lg px-1 py-1 text-[1.02em] font-medium outline-none data-[empty=true]:before:text-muted data-[empty=true]:before:content-[attr(data-placeholder)] focus:bg-[color-mix(in_srgb,var(--text)_4%,transparent)]"
          onChange={setTitle}
          placeholder="Commit title"
          readOnly={terminal}
          value={title}
        />
        <PlaintextEditable
          ariaLabel="Commit description"
          className="min-h-10 w-full whitespace-pre-wrap rounded-lg px-1 py-1 text-[0.9em] leading-6 text-muted outline-none data-[empty=true]:before:content-[attr(data-placeholder)] focus:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus:text-text"
          onChange={setDescription}
          placeholder="Optional description"
          readOnly={terminal}
          value={description}
        />
        {proposal.status === "unavailable" ? (
          <p className="m-0 text-[0.84em] text-[color:var(--danger)]">{proposal.unavailableReason || "This proposal is no longer mechanically available."}</p>
        ) : null}
      </div>

      {proposal.status === "proposed" ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {proposal.includeNewerAvailable ? (
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-full px-2 py-1.5 text-[0.84em] text-muted hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)] hover:text-text">
              <input
                checked={includeNewer}
                className="size-4 accent-[color:var(--text)]"
                onChange={(event) => setIncludeNewer(event.target.checked)}
                type="checkbox"
              />
              Include newer changes
            </label>
          ) : null}
          <PrimaryButton disabled={committing || !title.trim()} onClick={() => void commit()} pendingHalo={committing}>
            {committing ? "Committing..." : "Commit"}
          </PrimaryButton>
        </div>
      ) : null}

      <ThreadFileChangeList
        changes={proposal.changes.map((change, index) => ({
          change: {
            diff: change.diff,
            kind: change.kind.type === "update"
              ? { move_path: change.kind.move_path ?? null, type: "update" as const }
              : change.kind,
            path: change.path,
          },
          sourceChangeIndex: index,
          sourceItemId,
        }))}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    </div>
  );
}
