/*
 * Keywords: project, file, links, wrapping, workspace.
 * Exports:
 * - default ProjectFileLinkList: render wrapping file controls, shown as the contextual project shows paths.
 */
import ProjectFilePath from "./ProjectFilePath";
import { useProject } from "./use-projects";

export default function ProjectFileLinkList({ paths }: { paths: readonly string[] }) {
  const project = useProject.contextual();
  if (!paths.length) return null;
  return (
    <div className="mt-0.5 flex min-w-0 flex-wrap gap-1 text-fg/muted">
      {paths.map((filePath) => (
        <span className="min-w-0 max-w-full" key={filePath}>
          <ProjectFilePath
            className="pointer-events-auto min-w-0 max-w-full shrink text-[0.9em]"
            path={project ? project.displayPath(filePath) : filePath}
          />
        </span>
      ))}
    </div>
  );
}
