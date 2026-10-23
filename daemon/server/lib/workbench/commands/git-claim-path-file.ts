/*
 * Exports:
 * - GitClaimPathFile/GitClaimPathFileSchema: strict bulk claim selection stored outside command argv.
 * - readCwdJsonFile: load one bounded JSON file, relative to and contained in the caller cwd, through a schema.
 * - readGitClaimPathFile: load one cwd-contained JSON claim selection.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GitArcClaimsSchema } from "workbench-shared/workbench/git/checkpoint-contracts";

const MAX_CWD_JSON_FILE_BYTES = 4 * 1024 * 1024;

export const GitClaimPathFileSchema = GitArcClaimsSchema.omit({ inherit: true });
export type GitClaimPathFile = z.infer<typeof GitClaimPathFileSchema>;

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

/** `label` names the file in errors, such as "claim paths". */
export async function readCwdJsonFile<TSchema extends z.ZodType>(cwd: string, file: string, schema: TSchema, label: string): Promise<z.output<TSchema>> {
  if (path.isAbsolute(file)) throw new Error(`The ${label} file must be relative to the cwd.`);
  const requestedRoot = path.resolve(cwd);
  const requestedFile = path.resolve(requestedRoot, file);
  if (!isInside(requestedRoot, requestedFile)) throw new Error(`The ${label} file must stay inside the cwd.`);
  const [root, candidate] = await Promise.all([
    fs.realpath(requestedRoot),
    fs.realpath(requestedFile),
  ]);
  if (!isInside(root, candidate)) throw new Error(`The ${label} file must stay inside the cwd.`);
  const stat = await fs.stat(candidate);
  if (!stat.isFile()) throw new Error(`The ${label} input must be a JSON file.`);
  if (stat.size > MAX_CWD_JSON_FILE_BYTES) throw new Error(`The ${label} file exceeds the 4 MiB limit.`);
  return schema.parse(JSON.parse(await fs.readFile(candidate, "utf8")));
}

export async function readGitClaimPathFile(cwd: string, file: string): Promise<GitClaimPathFile> {
  return await readCwdJsonFile(cwd, file, GitClaimPathFileSchema, "claim paths");
}
