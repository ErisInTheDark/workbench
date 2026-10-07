/*
 * Exports:
 * - default createCodexSingleFileRuntime: isolated native transport and owned scratch documents.
 */
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import CodexSingleFileDocuments from "./CodexSingleFileDocuments";
import type { CodexAppServerOptions } from "./CodexAppServer";
import type CodexAppServer from "./CodexAppServer";
import createCodexIsolatedTransport from "./CodexIsolatedAppServerTransport";
import type { CodexSingleFileOptions } from "./CodexSingleFileController";

export default function createCodexSingleFileRuntime({
  documentsDirectory,
  transformerDirectory = WorkbenchTemporaryDirectory.resolve("voice-transformer"),
  createServer,
}: {
  documentsDirectory: string;
  transformerDirectory?: string;
  createServer?: (options: CodexAppServerOptions) => Pick<CodexAppServer, "send" | "stopAsync">;
}): CodexSingleFileOptions {
  const documents = new CodexSingleFileDocuments(documentsDirectory);
  return {
    createDocument: text => documents.create(text),
    createTransport: (onMessage, onFailure) => createCodexIsolatedTransport({
      projectRoot: transformerDirectory, label: "Voice transformer", onMessage, onFailure,
      ...(createServer ? { createServer } : {}),
    }),
  };
}
