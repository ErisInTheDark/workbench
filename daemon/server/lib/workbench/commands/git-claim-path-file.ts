/*
 * Exports:
 * - GitClaimPathFile/GitClaimPathFileSchema: strict bulk claim selection stored outside command argv.
 * - readGitClaimPathFile: load one bounded project-contained JSON claim selection.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GitArcClaimsSchema } from "workbench-shared/workbench/git/checkpoint-contracts";

const MAX_CLAIM_PATH_FILE_BYTES = 4 * 1024 * 1024;

export const GitClaimPathFileSchema = GitArcClaimsSchema.omit({ inherit: true });
export type GitClaimPathFile = z.infer<typeof GitClaimPathFileSchema>;

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export async function readGitClaimPathFile(cwd: string, file: string): Promise<GitClaimPathFile> {
  if (path.isAbsolute(file)) throw new Error("The claim paths file must be project-relative.");
  const requestedRoot = path.resolve(cwd);
  const requestedFile = path.resolve(requestedRoot, file);
  if (!isInside(requestedRoot, requestedFile)) throw new Error("The claim paths file must stay inside the project.");
  const [root, candidate] = await Promise.all([
    fs.realpath(requestedRoot),
    fs.realpath(requestedFile),
  ]);
  if (!isInside(root, candidate)) throw new Error("The claim paths file must stay inside the project.");
  const stat = await fs.stat(candidate);
  if (!stat.isFile()) throw new Error("The claim paths input must be a JSON file.");
  if (stat.size > MAX_CLAIM_PATH_FILE_BYTES) throw new Error("The claim paths file exceeds the 4 MiB limit.");
  return GitClaimPathFileSchema.parse(JSON.parse(await fs.readFile(candidate, "utf8")));
}
