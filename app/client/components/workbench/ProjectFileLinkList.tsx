/*
 * Keywords: project, file, links, wrapping, workspace.
 * Exports:
 * - default ProjectFileLinkList: render wrapping file controls with optional workspace path conversion.
 */
import { toWorkspaceDisplayPath, type WorkspaceFileLinkRoot } from "../../workbench/markdown/markdown-links";
import ProjectFilePath from "./ProjectFilePath";

export default function ProjectFileLinkList({
  paths,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  paths: readonly string[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (!paths.length) return null;
  return (
    <div className="mt-0.5 flex min-w-0 flex-wrap gap-1 text-fg/muted">
      {paths.map((filePath) => (
        <span className="min-w-0 max-w-full" key={filePath}>
          <ProjectFilePath
            className="pointer-events-auto min-w-0 max-w-full shrink text-[0.9em]"
            disambiguationPaths={projectFilePaths}
            path={projectRootPath !== undefined || workspaceRoots !== undefined
              ? toWorkspaceDisplayPath(filePath, { projectRootPath: projectRootPath ?? "", workspaceRoots }) ?? filePath
              : filePath}
            projectId={projectId}
          />
        </span>
      ))}
    </div>
  );
}
