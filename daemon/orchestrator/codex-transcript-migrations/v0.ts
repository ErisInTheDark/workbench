/*
 * Exports:
 * - default migrateV0: no-op initial Codex transcript migration. Keywords: transcript, migration, v0.
 */
import type AtomicJsonStore from "../AtomicJsonStore";

export default async function migrateV0(_rootDirectoryPath: string, _jsonStore: AtomicJsonStore) {
  return;
}
