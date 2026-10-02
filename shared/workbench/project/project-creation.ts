/*
 * Exports:
 * - PROJECT_FOLDER_LIST_LIMIT: maximum folder entries returned by one listing.
 * - ProjectFolderListRequestSchema/ProjectFolderListSchema: list child folders of one absolute path, or filesystem roots for null.
 * - ProjectTemplateSchema/ProjectTemplate: starter content written into a new project.
 * - ProjectCreateRequestSchema/ProjectCreateResultSchema: create one project folder with template and Git repository.
 * - validateProjectFolderName: shared folder-name rules enforced by the form and the daemon.
 */
import { z } from "zod";

import { ProjectIdSchema } from "../identity.ts";

export const PROJECT_FOLDER_LIST_LIMIT = 2000;
const absolutePath = z.string().min(1).max(4096);

export const ProjectFolderListRequestSchema = z.object({ path: absolutePath.nullable() }).strict();
export const ProjectFolderListSchema = z.object({
  path: absolutePath.nullable(),
  parentPath: absolutePath.nullable(),
  entries: z.array(z.object({
    name: z.string().min(1).max(255),
    path: absolutePath,
    isGitRepository: z.boolean(),
  }).strict()).max(PROJECT_FOLDER_LIST_LIMIT),
  truncated: z.boolean(),
}).strict();
export type ProjectFolderListRequest = z.infer<typeof ProjectFolderListRequestSchema>;
export type ProjectFolderList = z.infer<typeof ProjectFolderListSchema>;

export const ProjectTemplateSchema = z.enum(["none", "node"]);
export type ProjectTemplate = z.infer<typeof ProjectTemplateSchema>;

export const ProjectCreateRequestSchema = z.object({
  parentPath: absolutePath,
  name: z.string().max(255),
  template: ProjectTemplateSchema,
}).strict();
export const ProjectCreateResultSchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), path: absolutePath, projectId: ProjectIdSchema.nullable() }).strict(),
  z.object({
    accepted: z.literal(false),
    reason: z.enum(["invalid-name", "exists", "parent-missing", "outside-roots", "inside-project"]),
  }).strict(),
]);
export type ProjectCreateRequest = z.infer<typeof ProjectCreateRequestSchema>;
export type ProjectCreateResult = z.infer<typeof ProjectCreateResultSchema>;

const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/iu;

/** Returns a user-facing problem, or null when the name is a portable single folder name. */
export function validateProjectFolderName(name: string): string | null {
  if (!name.trim()) return "Enter a project name.";
  if (name !== name.trim()) return "Remove leading and trailing spaces.";
  if (name === "." || name === "..") return "Choose a real folder name.";
  if (name.length > 255) return "Use 255 characters or fewer.";
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(name)) return "Folder names cannot contain < > : \" / \\ | ? * or control characters.";
  if (name.endsWith(".")) return "Folder names cannot end with a dot.";
  if (RESERVED_WINDOWS_NAMES.test(name)) return "That name is reserved on Windows.";
  return null;
}
