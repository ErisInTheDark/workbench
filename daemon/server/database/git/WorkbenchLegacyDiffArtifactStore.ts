/*
 * Exports:
 * - LegacyDiffArtifactReference: thread-scoped content address.
 * - default WorkbenchLegacyDiffArtifactStore: preserve validated legacy diff text with its canonical owner.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";

export interface LegacyDiffArtifactReference {
  threadId: string;
  artifactId: string;
}

export default class WorkbenchLegacyDiffArtifactStore {
  constructor(private readonly database: Database.Database) {}

  write(input: LegacyDiffArtifactReference & { diff: string }) {
    this.#validate(input.artifactId, input.diff);
    this.database.transaction(() => {
      const thread = new WorkbenchThreadIdentityRepository(this.database).resolve({ threadId: ThreadReferenceSchema.parse(input.threadId) });
      if (!thread) throw new Error("Legacy diff thread has not been admitted.");
      const previous = this.database.prepare("SELECT diff FROM workbench_legacy_diff_artifacts WHERE thread_id = ? AND digest = ?")
        .get(thread.threadId, input.artifactId) as { diff: string } | undefined;
      if (previous && previous.diff !== input.diff) throw new Error("Legacy diff content changed.");
      this.database.prepare("INSERT OR IGNORE INTO workbench_legacy_diff_artifacts(thread_id, digest, diff) VALUES (?, ?, ?)")
        .run(thread.threadId, input.artifactId, input.diff);
    })();
  }

  read(input: LegacyDiffArtifactReference): string | null {
    this.#validate(input.artifactId);
    return this.database.transaction(() => {
      const thread = new WorkbenchThreadIdentityRepository(this.database).resolve({ threadId: ThreadReferenceSchema.parse(input.threadId) });
      if (!thread) return null;
      const row = this.database.prepare("SELECT diff FROM workbench_legacy_diff_artifacts WHERE thread_id = ? AND digest = ?")
        .get(thread.threadId, input.artifactId) as { diff: string } | undefined;
      if (!row) return null;
      this.#validate(input.artifactId, row.diff);
      return row.diff;
    })();
  }

  #validate(digest: string, diff?: string) {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Invalid checkpoint diff artifact id.");
    if (diff !== undefined && createHash("sha256").update(diff).digest("hex") !== digest) {
      throw new Error("Legacy diff text does not match its digest.");
    }
  }
}
