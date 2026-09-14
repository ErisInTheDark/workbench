/*
 * Exports:
 * - default WorkbenchThreadStateLayoutRepository: persist one layout without changing its owning interaction rules.
 * - WorkbenchThreadLayoutOwner: project, global pinned or home layout identity.
 * - WorkbenchThreadLayoutReferences: canonical identity boundary for display keys.
 */
import { randomUUID } from "node:crypto";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import type Database from "better-sqlite3";
import type { WorkbenchHarness } from "workbench-shared/types";
import {
  getProjectQualifiedThreadDisplayKey, parseProjectQualifiedThreadDisplayKey,
  normalizeThreadDisplayLayout, ThreadDisplayLayoutSchema, THREAD_DISPLAY_LAYOUT_SECTIONS,
  removeThreadDisplayLayoutMember,
  getThreadDisplayDraftKey, getThreadDisplayFolderKey, getThreadDisplayThreadKey,
  type ThreadDisplayFolder, type ThreadDisplayLayout, type ThreadDisplayLayoutSection,
} from "workbench-shared/workbench/thread/thread-display-layout";
import { ThreadReferenceSchema, type DraftId, type FolderId, type ProjectId, type ThreadDisplayKey, type ThreadReference, type WorkbenchThreadId } from "workbench-shared/workbench/identity";

export type WorkbenchThreadLayoutOwner = { kind: "project"; projectId: ProjectId } | { kind: "pinned" | "home" };
export interface WorkbenchThreadLayoutReferences {
  resolveThread(projectId: ProjectId, harness: WorkbenchHarness, threadId: ThreadReference): WorkbenchThreadId;
  readThread(threadId: WorkbenchThreadId): { projectId: ProjectId; harness: WorkbenchHarness; threadId: WorkbenchThreadId };
}

type LayoutItem = {
  id: string;
  section: ThreadDisplayLayoutSection;
  item_kind: "thread" | "draft" | "folder";
  positioned: 0 | 1;
  thread_id: WorkbenchThreadId | null;
  draft_id: DraftId | null;
  draft_project_id: ProjectId | null;
  folder_id: FolderId | null;
};
type FolderRow = {
  id: string; folder_id: FolderId; section: ThreadDisplayLayoutSection; title: string; folder_index: number;
};

export default class WorkbenchThreadStateLayoutRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly references: WorkbenchThreadLayoutReferences,
  ) {}

  read(owner: WorkbenchThreadLayoutOwner): { revision: number; displayOrder: ThreadDisplayLayout } | null {
    const layout = this.find(owner);
    if (!layout) return null;
    const rows = this.readItems(layout.id);
    const keys = new Map(rows.map((row) => [row.id, this.itemKey(owner, row)]));
    const displayOrder: ThreadDisplayLayout = {};
    const relations = this.database.prepare(`
      SELECT item_id, related_item_id, relation_kind, relation_index FROM workbench_sidebar_layout_relations
      WHERE layout_id = ? ORDER BY item_id, relation_kind, relation_index
    `).all(layout.id) as Array<{
      item_id: string; related_item_id: string; relation_kind: "above" | "below"; relation_index: number;
    }>;
    for (const row of rows) {
      const edges = relations.filter((relation) => relation.item_id === row.id);
      if (!row.positioned) {
        if (edges.length) throw new Error("Unpositioned layout item has ordering facts.");
        continue;
      }
      const section = displayOrder[row.section] ??= {};
      section[keys.get(row.id)!] = {
        above: this.readEdges(edges, "above", keys),
        below: this.readEdges(edges, "below", keys),
      };
    }
    const folders = this.readFolders(layout.id);
    const members = this.database.prepare(`
      SELECT folder_item_id, member_item_id, member_index FROM workbench_sidebar_folder_members
      WHERE layout_id = ? ORDER BY folder_item_id, member_index
    `).all(layout.id) as Array<{ folder_item_id: string; member_item_id: string; member_index: number }>;
    if (folders.length) {
      if (owner.kind === "home") throw new Error("Home layout cannot own folders.");
      displayOrder.folders = folders.map((folder, folderIndex) => {
        if (folder.folder_index !== folderIndex) throw new Error("Layout has incomplete folder ordering.");
        const folderItems = rows.filter((row) => row.item_kind === "folder" && row.folder_id === folder.folder_id);
        if (folderItems.length !== 1 || folderItems[0]!.section !== folder.section) {
          throw new Error("Layout folder has no matching item.");
        }
        return {
          folderId: folder.folder_id, section: folder.section, title: folder.title,
          threadKeys: members.filter((member) => member.folder_item_id === folderItems[0]!.id)
            .map((member, index) => {
              if (member.member_index !== index) throw new Error("Layout has incomplete folder membership.");
              const key = keys.get(member.member_item_id);
              if (!key) throw new Error("Layout member is missing.");
              return key;
            }),
        };
      });
    }
    return { revision: layout.revision, displayOrder: ThreadDisplayLayoutSchema.parse(displayOrder) };
  }

  removeDraft(projectId: ProjectId, draftId: DraftId) {
    const owners = this.database.prepare(`
      SELECT DISTINCT layout.owner_kind, project.project_id
      FROM workbench_sidebar_layout_drafts item
      JOIN workbench_thread_drafts draft ON draft.id = item.draft_id
      JOIN workbench_sidebar_layout_items base ON base.id = item.item_id
      JOIN workbench_sidebar_layouts layout ON layout.id = base.layout_id
      LEFT JOIN workbench_sidebar_project_layouts project ON project.layout_id = layout.id
      WHERE draft.project_id = ? AND draft.draft_id = ?
    `).all(projectId, draftId) as Array<{ owner_kind: "project" | "home" | "pinned"; project_id: ProjectId | null }>;
    for (const row of owners) {
      const owner: WorkbenchThreadLayoutOwner = row.owner_kind === "project"
        ? { kind: "project", projectId: row.project_id! } : { kind: row.owner_kind };
      const stored = this.read(owner)!;
      const localKey = getThreadDisplayDraftKey(draftId);
      const key = owner.kind === "project" ? localKey
        : getProjectQualifiedThreadDisplayKey(projectId, localKey);
      this.replace(owner, stored.revision, removeThreadDisplayLayoutMember(stored.displayOrder, key));
    }
  }

  replace(owner: WorkbenchThreadLayoutOwner, revision: number, value: ThreadDisplayLayout) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Layout revision must be a non-negative integer.");
    const order = normalizeThreadDisplayLayout(ThreadDisplayLayoutSchema.parse(value));
    if (owner.kind === "home" && order.folders?.length) throw new Error("Home layout cannot own folders.");
    return this.database.transaction(() => {
      const previous = this.find(owner);
      const id = previous?.id ?? randomUUID();
      const previousItems = previous ? this.readItems(id) : [];
      const previousFolders = previous ? this.readFolders(id) : [];
      const previousIds = new Map<string, string>(previousItems.map((item) => [this.itemKey(owner, item), item.id]));
      this.database.prepare(`
        INSERT INTO workbench_sidebar_layouts(id, owner_kind, revision) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision
      `).run(id, owner.kind, revision);
      if (!previous) {
        if (owner.kind === "project") {
          this.database.prepare(`
            INSERT INTO workbench_sidebar_project_layouts(layout_id, owner_kind, project_id) VALUES (?, 'project', ?)
          `).run(id, owner.projectId);
        } else {
          this.database.prepare(`
            INSERT INTO workbench_sidebar_global_layouts(layout_id, owner_kind) VALUES (?, ?)
          `).run(id, owner.kind);
        }
      }
      this.database.prepare("DELETE FROM workbench_sidebar_layout_items WHERE layout_id = ?").run(id);
      this.database.prepare("DELETE FROM workbench_sidebar_folders WHERE layout_id = ?").run(id);
      const folders = new Map<string, ThreadDisplayFolder & { id: string }>((order.folders ?? []).map((folder, folderIndex) => {
        const folderId = previousFolders.find((previousFolder) => previousFolder.folder_id === folder.folderId)?.id ?? randomUUID();
        this.database.prepare(`
          INSERT INTO workbench_sidebar_folders(id, folder_id, layout_id, owner_kind, section, title, folder_index)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(folderId, folder.folderId, id, owner.kind, folder.section, folder.title, folderIndex);
        return [`folder:${folder.folderId}`, { ...folder, id: folderId }] as const;
      }));
      const items = new Map<string, { id: string; section: ThreadDisplayLayoutSection; kind: "thread" | "draft" | "folder" }>();
      const ensureItem = (key: string, section: ThreadDisplayLayoutSection) => {
        const found = items.get(key);
        if (found) {
          if (found.section !== section) throw new Error("Layout item occurs in multiple sections.");
          return found;
        }
        const folder = folders.get(key);
        const local = owner.kind === "project"
          ? { projectId: owner.projectId, threadKey: key }
          : parseProjectQualifiedThreadDisplayKey(key);
        const kind = folder ? "folder" : local?.threadKey.startsWith("draft:") ? "draft" : "thread";
        const item: { id: string; section: ThreadDisplayLayoutSection; kind: LayoutItem["item_kind"] } = {
          id: previousIds.get(key) ?? randomUUID(), section, kind,
        };
        this.database.prepare(`
          INSERT INTO workbench_sidebar_layout_items(id, layout_id, section, item_kind, positioned) VALUES (?, ?, ?, ?, ?)
        `).run(item.id, id, section, kind, Number(Object.hasOwn(order[section] ?? {}, key)));
        if (folder) {
          if (folder.section !== section) throw new Error("Layout folder occurs in another section.");
          this.database.prepare(`
            INSERT INTO workbench_sidebar_layout_folders(item_id, item_kind, folder_id) VALUES (?, 'folder', ?)
          `).run(item.id, folder.id);
        } else {
          if (!local) throw new Error("Layout reference has no project.");
          if (kind === "draft") {
            const draft = this.database.prepare(`
              SELECT id FROM workbench_thread_drafts WHERE draft_id = ? AND project_id = ?
            `).get(local.threadKey.slice("draft:".length), local.projectId) as { id: string } | undefined;
            if (!draft) throw new Error("Layout references a missing draft.");
            this.database.prepare(`
              INSERT INTO workbench_sidebar_layout_drafts(item_id, item_kind, draft_id) VALUES (?, 'draft', ?)
            `).run(item.id, draft.id);
          } else {
            const separator = local.threadKey.indexOf(":");
            const harness = local.threadKey.slice(0, separator);
            const threadId = local.threadKey.slice(separator + 1);
            if (!ProviderKeySchema.safeParse(harness).success || !threadId) {
              throw new Error("Layout thread reference is invalid.");
            }
            const canonicalId = this.references.resolveThread(local.projectId, harness, ThreadReferenceSchema.parse(threadId));
            this.database.prepare(`
              INSERT INTO workbench_sidebar_layout_threads(item_id, item_kind, thread_id) VALUES (?, 'thread', ?)
            `).run(item.id, canonicalId);
          }
        }
        items.set(key, item);
        return item;
      };
      for (const folder of order.folders ?? []) {
        const folderItem = ensureItem(`folder:${folder.folderId}`, folder.section);
        folder.threadKeys.forEach((key, index) => {
          const member = ensureItem(key, folder.section);
          if (member.kind === "folder") throw new Error("Layout folders cannot contain folders.");
          this.database.prepare(`
            INSERT INTO workbench_sidebar_folder_members(
              folder_item_id, folder_item_kind, member_item_id, member_item_kind, layout_id, section, member_index
            ) VALUES (?, 'folder', ?, ?, ?, ?, ?)
          `).run(folderItem.id, member.id, member.kind, id, folder.section, index);
        });
      }
      for (const section of THREAD_DISPLAY_LAYOUT_SECTIONS) {
        for (const [key, position] of Object.entries(order[section] ?? {})) {
          const item = ensureItem(key, section);
          for (const kind of ["above", "below"] as const) {
            position[kind].forEach((related, index) => {
              const target = ensureItem(related, section);
              this.database.prepare(`
                INSERT INTO workbench_sidebar_layout_relations(
                  item_id, related_item_id, layout_id, section, relation_kind, relation_index
                ) VALUES (?, ?, ?, ?, ?, ?)
              `).run(item.id, target.id, id, section, kind, index);
            });
          }
        }
      }
      return id;
    })();
  }

  private find(owner: WorkbenchThreadLayoutOwner) {
    return (owner.kind === "project"
      ? this.database.prepare(`
          SELECT layout.id, layout.revision FROM workbench_sidebar_layouts layout
          JOIN workbench_sidebar_project_layouts owner ON owner.layout_id = layout.id WHERE owner.project_id = ?
        `).get(owner.projectId)
      : this.database.prepare(`
          SELECT layout.id, layout.revision FROM workbench_sidebar_layouts layout
          JOIN workbench_sidebar_global_layouts owner ON owner.layout_id = layout.id WHERE owner.owner_kind = ?
        `).get(owner.kind)) as { id: string; revision: number } | undefined;
  }

  private readItems(layoutId: string) {
    return this.database.prepare(`
      SELECT item.id, item.section, item.item_kind, item.positioned, thread.thread_id,
        draft.draft_id, draft.project_id AS draft_project_id, folder.folder_id
      FROM workbench_sidebar_layout_items item
      LEFT JOIN workbench_sidebar_layout_threads thread ON thread.item_id = item.id
      LEFT JOIN workbench_sidebar_layout_drafts draft_item ON draft_item.item_id = item.id
      LEFT JOIN workbench_thread_drafts draft ON draft.id = draft_item.draft_id
      LEFT JOIN workbench_sidebar_layout_folders folder_item ON folder_item.item_id = item.id
      LEFT JOIN workbench_sidebar_folders folder ON folder.id = folder_item.folder_id
      WHERE item.layout_id = ?
    `).all(layoutId) as LayoutItem[];
  }

  private readFolders(layoutId: string) {
    return this.database.prepare(`
      SELECT id, folder_id, section, title, folder_index FROM workbench_sidebar_folders WHERE layout_id = ? ORDER BY folder_index
    `).all(layoutId) as FolderRow[];
  }

  private itemKey(owner: WorkbenchThreadLayoutOwner, row: LayoutItem) {
    if (row.item_kind === "folder") {
      if (!row.folder_id || owner.kind === "home") throw new Error("Layout folder metadata is incomplete.");
      return getThreadDisplayFolderKey(row.folder_id);
    }
    let projectId: ProjectId;
    let threadKey: ThreadDisplayKey;
    if (row.item_kind === "draft") {
      if (!row.draft_id || !row.draft_project_id) throw new Error("Layout draft metadata is incomplete.");
      projectId = row.draft_project_id;
      threadKey = getThreadDisplayDraftKey(row.draft_id);
    } else {
      if (!row.thread_id) throw new Error("Layout thread metadata is incomplete.");
      const reference = this.references.readThread(row.thread_id);
      projectId = reference.projectId;
      threadKey = getThreadDisplayThreadKey(reference.harness, reference.threadId);
    }
    if (owner.kind === "project") {
      if (projectId !== owner.projectId) throw new Error("Layout reference belongs to another project.");
      return threadKey;
    }
    return getProjectQualifiedThreadDisplayKey(projectId, threadKey);
  }

  private readEdges(
    rows: readonly { related_item_id: string; relation_kind: "above" | "below"; relation_index: number }[],
    kind: "above" | "below", keys: ReadonlyMap<string, string>,
  ) {
    return rows.filter((row) => row.relation_kind === kind).map((row, index) => {
      if (row.relation_index !== index) throw new Error("Layout has incomplete position ordering.");
      const key = keys.get(row.related_item_id);
      if (!key) throw new Error("Layout relation references a missing item.");
      return key;
    });
  }
}
