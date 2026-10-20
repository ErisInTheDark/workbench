/*
 * Exports:
 * - WorkbenchProjectThreadStateOptions: initial durable and lifecycle facts for one project.
 * - default WorkbenchProjectThreadState: own one project's stores, revision, reconciliation lifecycle, and what storage last
 *   durably holds, so a failed write restores it.
 */

import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { DraftIdSchema, type DraftId, type ProjectId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadDisplayOrder } from "workbench-shared/workbench/thread/thread-display-order";
import type {
  WorkbenchComposerProfileSelectionState,
  WorkbenchThreadDraft,
  WorkbenchThreadSidebarSnapshot,
} from "workbench-shared/workbench/thread/thread-state";
import WorkbenchThreadDisplayController from "./WorkbenchThreadDisplayController";
import WorkbenchThreadDraftStore from "./WorkbenchThreadDraftStore";
import WorkbenchThreadRecordStore from "./WorkbenchThreadRecordStore";
import type { WorkbenchThreadStateCommit } from "./database/thread-state/workbench-thread-state-persistence";
import type {
  WorkbenchThreadStateEntry,
  WorkbenchThreadStateRecord,
} from "./workbench-thread-state-record";

interface ProjectCommitOptions {
  layout?: boolean;
  profile?: boolean;
}

export interface WorkbenchProjectThreadStateOptions {
  displayOrder?: WorkbenchThreadDisplayOrder;
  drafts?: Iterable<readonly [string, WorkbenchThreadDraft]>;
  entries?: Iterable<readonly [string, WorkbenchThreadStateEntry]>;
  newThreadProfile?: WorkbenchComposerProfileSelectionState | null;
}

export default class WorkbenchProjectThreadState {
  abort: AbortController | null = null;
  readonly display: WorkbenchThreadDisplayController;
  readonly draftStore: WorkbenchThreadDraftStore;
  error: string | null = null;
  freshness: WorkbenchThreadSidebarSnapshot["freshness"] = "loading";
  generation = 0;
  reconcilePromise: Promise<void> | null = null;
  readonly recordStore: WorkbenchThreadRecordStore;
  revision = 0;
  #writeQueue = { tail: Promise.resolve<unknown>(undefined) };
  /** Each entry as storage last held it; shared with staged copies, which write through the same storage. */
  #durable: { entries: Map<string, WorkbenchThreadStateEntry> };

  /** `entries` are taken as already durable: they were loaded from storage. */
  constructor(options: WorkbenchProjectThreadStateOptions = {}) {
    this.display = new WorkbenchThreadDisplayController(options.displayOrder);
    this.draftStore = new WorkbenchThreadDraftStore(options.drafts, options.newThreadProfile);
    this.recordStore = new WorkbenchThreadRecordStore(options.entries);
    this.#durable = { entries: this.recordStore.snapshot() };
  }

  get displayOrder() {
    return this.display.displayOrder;
  }

  set displayOrder(value: WorkbenchThreadDisplayOrder) {
    this.display.displayOrder = value;
  }

  get drafts() {
    return this.draftStore.drafts;
  }

  get entries() {
    return this.recordStore.entries;
  }

  get entriesVersion() {
    return this.recordStore.version;
  }

  get newThreadProfile() {
    return this.draftStore.newThreadProfile;
  }

  set newThreadProfile(value: WorkbenchComposerProfileSelectionState | null) {
    this.draftStore.newThreadProfile = value;
  }

  stage() {
    const staged = new WorkbenchProjectThreadState({
      displayOrder: this.displayOrder,
      drafts: this.drafts,
      entries: this.entries,
      newThreadProfile: this.newThreadProfile,
    });
    staged.#writeQueue = this.#writeQueue;
    staged.#durable = this.#durable;
    return staged;
  }

  changedEntryKeys(previous: ReadonlyMap<string, WorkbenchThreadStateEntry>) {
    return [...new Set([...previous.keys(), ...this.entries.keys()])]
      .filter((key) => previous.get(key) !== this.entries.get(key));
  }

  selectedCommit(
    projectId: ProjectId,
    keys: Iterable<string>,
    options: Pick<ProjectCommitOptions, "layout" | "profile"> = {},
  ): Omit<WorkbenchThreadStateCommit, "projectId"> {
    const records: WorkbenchThreadStateRecord[] = [];
    const drafts: NonNullable<WorkbenchThreadStateCommit["drafts"]>[number][] = [];
    const deletedDraftIds: DraftId[] = [];
    for (const key of new Set(keys)) {
      const entry = this.entries.get(key);
      if (entry && entry.entryKind !== "draft") {
        records.push(entry);
      } else if (entry?.entryKind === "draft") {
        const draft = this.drafts.get(entry.draft.draftId);
        if (!draft) throw new Error("Draft state is missing its owned content.");
        drafts.push({ draft, pinned: entry.metadata.pinned, snoozed: entry.metadata.snoozed });
      } else if (key.startsWith("draft:")) {
        deletedDraftIds.push(DraftIdSchema.parse(key.slice("draft:".length)));
      } else {
        throw new Error("Selected thread state is missing.");
      }
    }
    return {
      ...(records.length ? { records } : {}),
      ...(drafts.length ? { drafts } : {}),
      ...(deletedDraftIds.length ? { deletedDraftIds } : {}),
      ...(options.profile ? { projectProfiles: [{ projectId, profile: this.newThreadProfile }] } : {}),
      ...(options.layout
        ? { layouts: [{ owner: { kind: "project" as const, projectId }, revision: 0, displayOrder: this.displayOrder }] }
        : {}),
    };
  }

  /** Writes the selected entries as they are when their queued turn comes, and only then records them as durable. */
  async #writeDurably(
    keys: ReadonlySet<string>,
    write: () => Promise<void>,
  ) {
    const written = new Map([...keys].map(key => [key, this.entries.get(key)] as const));
    await write();
    for (const [key, entry] of written) {
      if (entry) this.#durable.entries.set(key, entry);
      else this.#durable.entries.delete(key);
    }
  }

  async commit(
    projectId: ProjectId,
    keys: Iterable<string>,
    options: ProjectCommitOptions,
    ports: {
      beforeWrite: () => void;
      prepare: () => void;
      write: (changes: Omit<WorkbenchThreadStateCommit, "projectId">) => Promise<void>;
    },
  ) {
    const beforeDerived = this.recordStore.snapshot();
    const previousOrder = this.displayOrder;
    ports.prepare();
    const selectedKeys = new Set([...keys, ...this.changedEntryKeys(beforeDerived)]);
    const installedEntries = this.recordStore.snapshot();
    const installedOrder = this.displayOrder;
    const operation = this.#writeQueue.tail.catch(() => undefined).then(async () => {
      ports.beforeWrite();
      try {
        await this.#writeDurably(selectedKeys, () => ports.write(this.selectedCommit(projectId, selectedKeys, {
          ...options,
          layout: options.layout || !areDeeplyEqual(previousOrder, installedOrder),
        })));
      } catch (error) {
        // Callers change entries before committing, so only the durable record knows what storage still holds.
        for (const key of selectedKeys) {
          if (this.entries.get(key) !== installedEntries.get(key)) continue;
          const durable = this.#durable.entries.get(key);
          if (durable) this.entries.set(key, durable);
          else this.entries.delete(key);
        }
        if (this.displayOrder === installedOrder) this.displayOrder = previousOrder;
        throw error;
      }
    });
    this.#writeQueue.tail = operation;
    await operation;
  }

  async writeSelected(
    projectId: ProjectId,
    keys: Iterable<string>,
    options: Pick<ProjectCommitOptions, "layout" | "profile">,
    ports: {
      beforeWrite: () => void;
      write: (changes: Omit<WorkbenchThreadStateCommit, "projectId">) => Promise<void>;
    },
  ) {
    const selectedKeys = new Set(keys);
    const operation = this.#writeQueue.tail.catch(() => undefined).then(async () => {
      ports.beforeWrite();
      await this.#writeDurably(selectedKeys, () => ports.write(this.selectedCommit(projectId, selectedKeys, options)));
    });
    this.#writeQueue.tail = operation;
    await operation;
  }
}
