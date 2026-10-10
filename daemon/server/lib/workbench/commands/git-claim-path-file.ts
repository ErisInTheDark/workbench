/*
 * Exports:
 * - GitClaimPathFile/GitClaimPathFileSchema: strict bulk claim selection stored outside command argv.
 * - readProjectJsonFile: load one bounded project-contained JSON file through a schema.
 * - readGitClaimPathFile: load one project-contained JSON claim selection.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GitArcClaimsSchema } from "workbench-shared/workbench/git/checkpoint-contracts";

const MAX_PROJECT_JSON_FILE_BYTES = 4 * 1024 * 1024;

export const GitClaimPathFileSchema = GitArcClaimsSchema.omit({ inherit: true });
export type GitClaimPathFile = z.infer<typeof GitClaimPathFileSchema>;

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

/** `label` names the file in errors, such as "claim paths". */
export async function readProjectJsonFile<TSchema extends z.ZodType>(cwd: string, file: string, schema: TSchema, label: string): Promise<z.output<TSchema>> {
  if (path.isAbsolute(file)) throw new Error(`The ${label} file must be project-relative.`);
  const requestedRoot = path.resolve(cwd);
  const requestedFile = path.resolve(requestedRoot, file);
  if (!isInside(requestedRoot, requestedFile)) throw new Error(`The ${label} file must stay inside the project.`);
  const [root, candidate] = await Promise.all([
    fs.realpath(requestedRoot),
    fs.realpath(requestedFile),
  ]);
  if (!isInside(root, candidate)) throw new Error(`The ${label} file must stay inside the project.`);
  const stat = await fs.stat(candidate);
  if (!stat.isFile()) throw new Error(`The ${label} input must be a JSON file.`);
  if (stat.size > MAX_PROJECT_JSON_FILE_BYTES) throw new Error(`The ${label} file exceeds the 4 MiB limit.`);
  return schema.parse(JSON.parse(await fs.readFile(candidate, "utf8")));
}

export async function readGitClaimPathFile(cwd: string, file: string): Promise<GitClaimPathFile> {
  return await readProjectJsonFile(cwd, file, GitClaimPathFileSchema, "claim paths");
}
