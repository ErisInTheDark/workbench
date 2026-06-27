import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import {
  createGitCheckpoint,
  diffLatestGitCheckpoint,
  readGitCheckpointDiffArtifact,
  restoreGitCheckpoint,
  type GitCheckpointPurpose,
} from "../../../lib/git-checkpoints";
import { discoverProjects, isPathWithinRoot, resolveProjectRoot, type ResolvedProject } from "../../../lib/project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type GitCheckpointAction = "baseline" | "diff" | "diffCheckpoint" | "restore";
type GitCheckpointDiffView = "compact" | "full";

function normalizeAction(value: unknown): GitCheckpointAction | null {
  return value === "baseline" || value === "diff" || value === "diffCheckpoint" || value === "restore"
    ? value
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown) {
  return value === true;
}

function normalizeDiffView(value: unknown): GitCheckpointDiffView {
  return value === "full" ? "full" : "compact";
}

async function resolveCheckpointCwd({
  cwd,
  projectId,
}: {
  cwd: string;
  projectId: string;
}) {
  const resolvedProject = await resolveCheckpointProject({
    cwd,
    projectId,
  });
  const resolvedCwd = path.resolve(cwd || resolvedProject.root);
  const owningRoot = resolvedProject.roots.find((root) => isPathWithinRoot(resolvedCwd, root.root));
  if (!owningRoot) {
    throw new Error(projectId
      ? "Checkpoint cwd must be inside the selected Workbench project."
      : "Checkpoint cwd must be inside a discovered Workbench project.");
  }

  return resolvedCwd;
}

async function resolveCheckpointProject({
  cwd,
  projectId,
}: {
  cwd: string;
  projectId: string;
}): Promise<ResolvedProject> {
  if (projectId || !cwd) {
    return await resolveProjectRoot(projectId);
  }

  const resolvedCwd = path.resolve(cwd);
  const discoveredProjectId = await findDiscoveredProjectIdForCwd(resolvedCwd);
  if (!discoveredProjectId) {
    throw new Error("Checkpoint cwd must be inside a discovered Workbench project.");
  }

  return await resolveProjectRoot(discoveredProjectId);
}

async function findDiscoveredProjectIdForCwd(resolvedCwd: string) {
  const firstPassMatch = findProjectRootMatch(await discoverProjects(), resolvedCwd);
  if (firstPassMatch) {
    return firstPassMatch.projectId;
  }

  return findProjectRootMatch(await discoverProjects({ refresh: true }), resolvedCwd)?.projectId ?? null;
}

function findProjectRootMatch(projects: Awaited<ReturnType<typeof discoverProjects>>, resolvedCwd: string) {
  return projects
    .flatMap((project) => project.roots.map((root) => ({
      projectId: project.id,
      rootPath: path.resolve(root.rootPath),
    })))
    .filter((candidate) => isPathWithinRoot(resolvedCwd, candidate.rootPath))
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0] ?? null;
}

function jsonResponse(payload: unknown) {
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function textResponse(payload: string) {
  return new NextResponse(payload, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = normalizeAction(body?.action);
    const threadId = readString(body?.threadId);
    const cwd = readString(body?.cwd);
    const projectId = readString(body?.projectId);

    if (!action) {
      return NextResponse.json({ error: "A valid checkpoint action is required." }, { status: 400 });
    }

    if (!threadId) {
      return NextResponse.json({ error: "A thread id is required." }, { status: 400 });
    }

    const resolvedCwd = await resolveCheckpointCwd({ cwd, projectId });

    if (action === "baseline" || action === "diffCheckpoint") {
      const purpose: GitCheckpointPurpose = action === "baseline" ? "baseline" : "diff";
      return jsonResponse(await createGitCheckpoint({
        cwd: resolvedCwd,
        purpose,
        threadId,
      }));
    }

    if (action === "diff") {
      const diffView = normalizeDiffView(body?.view);
      if (diffView === "full") {
        const diffArtifactId = readString(body?.diffArtifactId);
        if (!diffArtifactId) {
          return NextResponse.json({ error: "A checkpoint diff artifact id is required for full diff view." }, { status: 400 });
        }

        return textResponse(await readGitCheckpointDiffArtifact({
          diffArtifactId,
          threadId,
        }));
      }

      const result = await diffLatestGitCheckpoint({
        cwd: resolvedCwd,
        threadId,
      });
      return textResponse(result.summary);
    }

    const checkpointCommit = readString(body?.checkpointCommit);
    if (!checkpointCommit) {
      return NextResponse.json({ error: "A checkpoint commit is required for restore." }, { status: 400 });
    }

    return jsonResponse(await restoreGitCheckpoint({
      checkpointCommit,
      confirmRestore: readBoolean(body?.confirmRestore),
      cwd: resolvedCwd,
      threadId,
    }));
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to run git checkpoint operation.",
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
      status: 400,
    });
  }
}
