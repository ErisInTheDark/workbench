/*
 * Exports:
 * - default useFileDocument: lease one file's facts without selecting sidebar state.
 */
import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import WorkbenchClientContext from "../../components/workbench/workbench-client-context";
import type { FileDocumentSnapshot } from "./WorkbenchFileStore";

const MISSING: FileDocumentSnapshot = { phase: "unavailable", failure: "The file folder is unavailable.", data: null };

export default function useFileDocument(location: ProjectLocationReference | null, path: string) {
  const files = useContext(WorkbenchClientContext)?.mounted?.files ?? null;
  const document = useMemo(() => files && location && path ? files.document(location, path) : null,
    [files, location?.daemonId, location?.projectId, path]);
  const subscribe = useCallback((listener: () => void) => document?.subscribe(listener) ?? (() => {}), [document]);
  const read = useCallback(() => document?.getSnapshot() ?? MISSING, [document]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return { document, snapshot };
}
