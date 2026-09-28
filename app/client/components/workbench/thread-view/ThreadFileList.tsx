/*
 * Exports:
 * - default ThreadFileList: collapse adjacent thread file links into an interactive tooltip list.
 */
import type { ParsedInlineNode } from "../../../workbench/markdown/markdown-parse";
import { projectFilePathPillClassName } from "../../../workbench/project/project-file-path";
import ProjectFilePath from "../ProjectFilePath";
import WorkbenchTooltip from "../WorkbenchTooltip";

type FileLink = Extract<ParsedInlineNode, { type: "projectFileLink" }>;

export default function ThreadFileList({
  files,
  projectId,
}: {
  files: readonly FileLink[];
  projectId?: string | null;
}) {
  return (
    <WorkbenchTooltip
      content={(
        <div className="flex min-w-0 flex-col items-start gap-1">
          {files.map((file, index) => (
            <ProjectFilePath
              absolutePath={file.absolutePath}
              columnNumber={file.columnNumber}
              exists={file.exists}
              key={`${file.href}-${index}`}
              label={file.label}
              lineNumber={file.lineNumber}
              openPath={file.openPath}
              path={file.relativePath}
              projectId={file.projectId ?? projectId}
              targetType={file.targetType}
            />
          ))}
        </div>
      )}
      interactive
    >
      <span
        className={`${projectFilePathPillClassName} cursor-default select-none align-baseline`}
        data-thread-file-list="true"
      >
        {files.length} files
      </span>
    </WorkbenchTooltip>
  );
}
