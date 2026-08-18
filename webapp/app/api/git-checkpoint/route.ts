/*
 * Exports:
 * - runtime: force checkpoint operations onto the Node.js runtime for Git and filesystem access. Keywords: api, git checkpoint, node runtime.
 * - dynamic: disable static caching for checkpoint operations. Keywords: api, git checkpoint, dynamic.
 * - POST: execute typed plan, implementation, compare, diff, proposal, restore, and legacy artifact actions. Keywords: api, git checkpoint, proposal, restore.
 */
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import {
  commitGitCheckpointProposal,
  compareGitCheckpoint,
  createGitCheckpointProposal,
  createGitImplementationCheckpoint,
  createGitPlanCheckpoint,
  diffGitCheckpoint,
  readGitCheckpointDiffArtifact,
  readGitCheckpointProposal,
  restoreGitCheckpoint,
  restoreGitCheckpointPaths,
} from "../../../lib/git-checkpoints";
import { resolveProjectRoot } from "../../../lib/project";
import { GitCheckpointRequestSchema } from "../../../lib/workbench/git/checkpoint-contracts";
import { resolveAgentEndpointProjectFromCwd } from "../../../lib/workbench/project/agent-endpoint-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveLegacyCwd(body: { cwd?: string; projectId?: string }) {
  if (body.cwd?.trim()) {
    return (await resolveAgentEndpointProjectFromCwd(body.cwd, { endpointName: "Checkpoint" })).cwd;
  }
  return path.resolve((await resolveProjectRoot(body.projectId?.trim() ?? "")).root);
}

function jsonResponse(payload: object) {
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}

function textResponse(payload: string) {
  return new NextResponse(payload, {
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    if (rawBody?.action === "diff" && rawBody?.view === "full") {
      const threadId = typeof rawBody.threadId === "string" ? rawBody.threadId.trim() : "";
      const diffArtifactId = typeof rawBody.diffArtifactId === "string" ? rawBody.diffArtifactId.trim() : "";
      if (!threadId || !diffArtifactId) throw new Error("A thread id and checkpoint diff artifact id are required.");
      await resolveLegacyCwd(rawBody);
      return textResponse(await readGitCheckpointDiffArtifact({ diffArtifactId, threadId }));
    }

    const parsed = GitCheckpointRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid checkpoint request." }, { status: 400 });
    }
    const input = parsed.data;
    const cwd = (await resolveAgentEndpointProjectFromCwd(input.cwd, { endpointName: "Checkpoint" })).cwd;
    const common = { cwd, threadId: input.threadId };

    switch (input.action) {
      case "plan":
        return jsonResponse(await createGitPlanCheckpoint(common));
      case "implement":
        return jsonResponse(await createGitImplementationCheckpoint({
          ...common,
          ...(input.amendCheckpoint ? { amendCheckpoint: input.amendCheckpoint } : {}),
          paths: input.paths,
        }));
      case "compare":
        return jsonResponse(await compareGitCheckpoint({
          ...common,
          checkpointCommit: input.checkpointCommit,
          paths: input.paths,
        }));
      case "diff":
        return textResponse((await diffGitCheckpoint({
          ...common,
          checkpointCommit: input.checkpointCommit,
          paths: input.paths,
        })).diff);
      case "proposalCreate":
        return jsonResponse(await createGitCheckpointProposal({
          ...common,
          checkpointCommit: input.checkpointCommit,
          description: input.description,
          paths: input.paths,
          title: input.title,
        }));
      case "proposalState":
        return jsonResponse(await readGitCheckpointProposal({
          ...common,
          includeNewer: input.includeNewer,
          proposalId: input.proposalId,
        }));
      case "proposalCommit":
        return jsonResponse(await commitGitCheckpointProposal({
          ...common,
          description: input.description,
          includeNewer: input.includeNewer,
          proposalId: input.proposalId,
          title: input.title,
        }));
      case "readDiffArtifact":
        return textResponse(await readGitCheckpointDiffArtifact({
          diffArtifactId: input.diffArtifactId,
          threadId: input.threadId,
        }));
      case "restore":
        return input.paths?.length
          ? jsonResponse(await restoreGitCheckpointPaths({
            ...common,
            checkpointCommit: input.checkpointCommit,
            filePaths: input.paths,
          }))
          : jsonResponse(await restoreGitCheckpoint({
            ...common,
            checkpointCommit: input.checkpointCommit,
            confirmRestore: input.confirmRestore === true,
          }));
    }
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to run git checkpoint operation.",
    }, {
      headers: { "Cache-Control": "no-store" },
      status: 400,
    });
  }
}
