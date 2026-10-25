/*
 * Exports:
 * - typecheckWithArcOverlay: type-check one TypeScript project through the TypeScript API, layering an arc tree's
 *   held paths over the disk; output matches the compiler's plain diagnostic format.
 */
import path from "node:path";
import { createFileSystemLayer } from "typescript/fs";
import { API, DiagnosticCategory, formatDiagnostics } from "typescript/sync";
import type WorkbenchArcTree from "../../package/WorkbenchArcTree.mjs";

export function typecheckWithArcOverlay(root: string, configPath: string, overlay: WorkbenchArcTree) {
  const files = [...overlay.files];
  const layer = createFileSystemLayer(
    files.flatMap(([target, content]) => content === null ? [] : [[target, content.toString("utf8")] as const]),
    { removedPaths: files.flatMap(([target, content]) => content === null ? [target] : []) },
  );
  const config = path.resolve(root, configPath);
  const api = new API({ cwd: root });
  try {
    const project = api.createSnapshot({ fileSystem: layer, openProjects: [config] }).getConfiguredProject(config);
    if (!project) throw new Error(`TypeScript did not load ${configPath}`);
    const { program } = project;
    const diagnostics = [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getProgramDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ];
    // Paths print relative to the repository root, as the plain compiler run from there prints them.
    const host = {
      getCanonicalFileName: (fileName: string) => program.getCanonicalFileName(fileName),
      getCurrentDirectory: () => root.replaceAll("\\", "/"),
      getNewLine: () => program.getNewLine(),
    };
    return {
      code: diagnostics.some(({ category }) => category === DiagnosticCategory.Error) ? 1 : 0,
      output: diagnostics.length ? formatDiagnostics(diagnostics, host) : "",
    };
  } finally {
    api.close();
  }
}
