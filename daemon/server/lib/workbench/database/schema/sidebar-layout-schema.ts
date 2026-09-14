/*
 * Exports:
 * - defineSidebarLayoutSchema: declare layout ownership and same-section relationships.
 */
import {
  booleanInteger, check, defineTable, enumText, foreignKey, integer, primaryKey,
  sql, text, unique, type TableDefinition,
} from "workbench-shared/database/schema/schema-definition";
import {
  createTable, defineSubsystemHistory, defineTableHistory, tableVersion,
} from "workbench-shared/database/schema/schema-history";

export function defineSidebarLayoutSchema(schemaVersion: number) {
  function install<Table extends TableDefinition>(table: Table) {
    return defineTableHistory({
      current: table,
      versions: [tableVersion({ schemaVersion, table, migration: createTable(table) })],
    });
  }

  const layouts = install(defineTable("workbench_sidebar_layouts", {
    id: text().primaryKey(),
    owner_kind: enumText("project", "pinned", "home").notNull(),
    revision: integer().notNull().nonNegative(),
  }, (table) => ({ constraints: [unique([table.id, table.owner_kind])] })));

  const projectLayouts = install(defineTable("workbench_sidebar_project_layouts", {
    layout_id: text().primaryKey(),
    owner_kind: enumText("project").notNull(),
    project_id: text().notNull(),
  }, (table) => ({
    constraints: [
      unique([table.project_id]),
      foreignKey([table.layout_id, table.owner_kind], {
        table: "workbench_sidebar_layouts", columns: ["id", "owner_kind"], onDelete: "CASCADE",
      }),
    ],
  })));

  const globalLayouts = install(defineTable("workbench_sidebar_global_layouts", {
    layout_id: text().primaryKey(),
    owner_kind: enumText("pinned", "home").notNull(),
  }, (table) => ({
    constraints: [
      unique([table.owner_kind]),
      foreignKey([table.layout_id, table.owner_kind], {
        table: "workbench_sidebar_layouts", columns: ["id", "owner_kind"], onDelete: "CASCADE",
      }),
    ],
  })));

  const folders = install(defineTable("workbench_sidebar_folders", {
    id: text().primaryKey(),
    folder_id: text().notNull(),
    layout_id: text().notNull(),
    owner_kind: enumText("project", "pinned").notNull(),
    section: enumText("pinned", "snoozed", "settled").notNull(),
    title: text().notNull(),
    folder_index: integer().notNull().nonNegative(),
  }, (table) => ({
    constraints: [
      unique([table.layout_id, table.folder_id]),
      unique([table.layout_id, table.folder_index]),
      foreignKey([table.layout_id, table.owner_kind], {
        table: "workbench_sidebar_layouts", columns: ["id", "owner_kind"], onDelete: "CASCADE",
      }),
    ],
  })));

  const items = install(defineTable("workbench_sidebar_layout_items", {
    id: text().primaryKey(),
    layout_id: text().notNull().references("workbench_sidebar_layouts", "id", { onDelete: "CASCADE" }),
    section: enumText("pinned", "snoozed", "settled").notNull(),
    item_kind: enumText("thread", "draft", "folder").notNull(),
    positioned: booleanInteger().notNull(),
  }, (table) => ({
    constraints: [
      unique([table.id, table.item_kind]),
      unique([table.id, table.layout_id, table.section]),
      unique([table.id, table.item_kind, table.layout_id, table.section]),
    ],
  })));

  const threads = install(defineTable("workbench_sidebar_layout_threads", {
    item_id: text().primaryKey(),
    item_kind: enumText("thread").notNull(),
    thread_id: text().notNull().references("workbench_threads", "id"),
  }, (table) => ({
    constraints: [foreignKey([table.item_id, table.item_kind], {
      table: "workbench_sidebar_layout_items", columns: ["id", "item_kind"], onDelete: "CASCADE",
    })],
  })));

  const drafts = install(defineTable("workbench_sidebar_layout_drafts", {
    item_id: text().primaryKey(),
    item_kind: enumText("draft").notNull(),
    draft_id: text().notNull().references("workbench_thread_drafts", "id", { onDelete: "CASCADE" }),
  }, (table) => ({
    constraints: [foreignKey([table.item_id, table.item_kind], {
      table: "workbench_sidebar_layout_items", columns: ["id", "item_kind"], onDelete: "CASCADE",
    })],
  })));

  const layoutFolders = install(defineTable("workbench_sidebar_layout_folders", {
    item_id: text().primaryKey(),
    item_kind: enumText("folder").notNull(),
    folder_id: text().notNull().references("workbench_sidebar_folders", "id", { onDelete: "CASCADE" }),
  }, (table) => ({
    constraints: [foreignKey([table.item_id, table.item_kind], {
      table: "workbench_sidebar_layout_items", columns: ["id", "item_kind"], onDelete: "CASCADE",
    })],
  })));

  const relations = install(defineTable("workbench_sidebar_layout_relations", {
    item_id: text().notNull(),
    related_item_id: text().notNull(),
    layout_id: text().notNull(),
    section: enumText("pinned", "snoozed", "settled").notNull(),
    relation_kind: enumText("above", "below").notNull(),
    relation_index: integer().notNull().nonNegative(),
  }, (table) => ({
    constraints: [
      primaryKey([table.item_id, table.relation_kind, table.relation_index]),
      check(sql`${table.item_id} <> ${table.related_item_id}`),
      foreignKey([table.item_id, table.layout_id, table.section], {
        table: "workbench_sidebar_layout_items", columns: ["id", "layout_id", "section"], onDelete: "CASCADE",
      }),
      foreignKey([table.related_item_id, table.layout_id, table.section], {
        table: "workbench_sidebar_layout_items", columns: ["id", "layout_id", "section"], onDelete: "CASCADE",
      }),
    ],
  })));

  const members = install(defineTable("workbench_sidebar_folder_members", {
    folder_item_id: text().notNull(),
    folder_item_kind: enumText("folder").notNull(),
    member_item_id: text().notNull(),
    member_item_kind: enumText("thread", "draft").notNull(),
    layout_id: text().notNull(),
    section: enumText("pinned", "snoozed", "settled").notNull(),
    member_index: integer().notNull().nonNegative(),
  }, (table) => ({
    constraints: [
      primaryKey([table.folder_item_id, table.member_index]),
      unique([table.layout_id, table.member_item_id]),
      foreignKey([table.folder_item_id, table.folder_item_kind, table.layout_id, table.section], {
        table: "workbench_sidebar_layout_items", columns: ["id", "item_kind", "layout_id", "section"], onDelete: "CASCADE",
      }),
      foreignKey([table.member_item_id, table.member_item_kind, table.layout_id, table.section], {
        table: "workbench_sidebar_layout_items", columns: ["id", "item_kind", "layout_id", "section"], onDelete: "CASCADE",
      }),
    ],
  })));

  const pinnedImports = install(defineTable("workbench_sidebar_pinned_imports", {
    project_id: text().primaryKey(),
    layout_id: text().notNull(),
    owner_kind: enumText("pinned").notNull(),
  }, (table) => ({
    constraints: [foreignKey([table.layout_id, table.owner_kind], {
      table: "workbench_sidebar_layouts", columns: ["id", "owner_kind"], onDelete: "CASCADE",
    })],
  })));

  return {
    tables: {
      layouts: layouts.current, projectLayouts: projectLayouts.current, globalLayouts: globalLayouts.current,
      folders: folders.current, items: items.current, threads: threads.current, drafts: drafts.current,
      layoutFolders: layoutFolders.current, relations: relations.current, members: members.current,
      pinnedImports: pinnedImports.current,
    },
    history: defineSubsystemHistory([
      layouts, projectLayouts, globalLayouts, folders, items, threads, drafts, layoutFolders,
      relations, members, pinnedImports,
    ]),
  };
}
