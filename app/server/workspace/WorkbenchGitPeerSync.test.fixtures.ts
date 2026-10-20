/*
 * Exports:
 * - PEER_SYNC_DIVERGED_FIXTURE: a desktop checkout (the fixture repo) and a server checkout (`server` in its bundle)
 *   diverged from one base by one commit each, with the desktop's own commit published.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { GitTestFixtureSpec } from "../../../daemon/server/lib/workbench/git/GitTestFixtureCache";

export const PEER_SYNC_DIVERGED_FIXTURE = {
  name: "peer-sync-diverged",
  commits: [{ files: { "base.txt": "base\n" }, message: "base.txt" }],
  prepare: async ({ bundleRoot, repositoryRoot, runGit }) => {
    const serverRoot = path.join(bundleRoot, "server");
    const commit = async (cwd: string, file: string, content: string) => {
      await fs.writeFile(path.join(cwd, file), content, "utf8");
      await runGit(["add", file], { cwd });
      await runGit(["commit", "--quiet", "-m", file], { cwd });
      return (await runGit(["rev-parse", "HEAD"], { cwd })).trim();
    };
    const base = (await runGit(["rev-parse", "HEAD"])).trim();
    await runGit(["init", "--quiet", "-b", "main", serverRoot], { cwd: bundleRoot });
    for (const cwd of [repositoryRoot, serverRoot]) {
      for (const [key, value] of [["user.name", "Sync test"], ["user.email", "sync@workbench.invalid"],
        ["commit.gpgsign", "false"], ["core.autocrlf", "false"]] as const) await runGit(["config", key, value], { cwd });
    }
    await runGit(["fetch", "--quiet", repositoryRoot, "main"], { cwd: serverRoot });
    await runGit(["reset", "--quiet", "--hard", base], { cwd: serverRoot });
    const local = await commit(repositoryRoot, "local.txt", "local\n");
    const incoming = await commit(serverRoot, "incoming.txt", "incoming\n");
    await runGit(["update-ref", "refs/remotes/published/main", local]);
    return { local, incoming };
  },
} satisfies GitTestFixtureSpec<{ local: string; incoming: string }>;
