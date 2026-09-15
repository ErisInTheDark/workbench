/*
 * Exports:
 * - default WorkbenchSearchRepository: own SQLite search projections, identity rekeying, and relational transcript ranking.
 */
import type Database from "better-sqlite3";
import WorkbenchProjectRepository from "../project/WorkbenchProjectRepository.ts";

import {
  WORKBENCH_SEARCH_ACTIONS,
  parseWorkbenchSearchQuery,
  createWorkbenchSearchMatcher,
  type WorkbenchSearchRequest,
  type WorkbenchSearchResponse,
  type WorkbenchSearchResult,
  type WorkbenchSearchActionId,
} from "workbench-shared/workbench/search/workbench-search";
import { WORKBENCH_SETTING_DEFINITIONS } from "workbench-shared/workbench/settings/workbench-setting-definitions";

interface SearchDocumentRow {
  detail: string;
  kind: "action" | "file" | "project" | "projectSetting";
  project_id: string | null;
  search_text: string;
  target: string;
  title: string;
}

interface ThreadTitleRow {
  activity_at: number;
  harness_id: string;
  id: string;
  project_id: string;
  title: string;
}

interface ThreadBodyRow {
  commentary_text: string;
  thread_id: string;
  user_text: string;
}

type RankedResult = { activityAt: number; result: WorkbenchSearchResult; score: number };

export default class WorkbenchSearchRepository {
  constructor(private readonly database: Database.Database) {
    this.seedStaticDocuments();
  }

  rekeyProject(previousId: string, projectId: string) {
    this.database.prepare(`
      UPDATE workbench_search_documents SET
        document_key = CASE kind WHEN 'project' THEN 'project:' || ? WHEN 'file' THEN 'file:' || ? || ':' || target ELSE document_key END,
        target = CASE kind WHEN 'project' THEN ? ELSE target END,
        detail = CASE kind WHEN 'file' THEN ? ELSE detail END,
        search_text = CASE kind WHEN 'project' THEN title || ' ' || ? || ' ' || detail ELSE search_text END,
        project_id = ?
      WHERE project_id = ?
    `).run(projectId, projectId, projectId, projectId, projectId, projectId, previousId);
  }

  replaceProjects(projects: readonly { id: string; name: string; rootPath: string }[]) {
    const replace = this.database.transaction(() => {
      this.database.prepare("DELETE FROM workbench_search_documents WHERE kind = 'project'").run();
      const insert = this.database.prepare(`
        INSERT INTO workbench_search_documents
          (document_key, kind, project_id, title, detail, target, search_text, updated_at)
        VALUES (?, 'project', ?, ?, ?, ?, ?, ?)
      `);
      const now = Date.now();
      for (const project of projects) {
        const id = new WorkbenchProjectRepository(this.database).admitStoredReference(project.id);
        insert.run(`project:${id}`, id, project.name, project.rootPath, id, `${project.name} ${id} ${project.rootPath}`, now);
      }
    });
    replace();
  }

  replaceProjectFiles(projectId: string, paths: readonly string[]) {
    const replace = this.database.transaction(() => {
      projectId = new WorkbenchProjectRepository(this.database).admitStoredReference(projectId);
      this.database.prepare("DELETE FROM workbench_search_documents WHERE kind = 'file' AND project_id = ?").run(projectId);
      const insert = this.database.prepare(`
        INSERT INTO workbench_search_documents
          (document_key, kind, project_id, title, detail, target, search_text, updated_at)
        VALUES (?, 'file', ?, ?, ?, ?, ?, ?)
      `);
      const now = Date.now();
      for (const path of paths) {
        insert.run(`file:${projectId}:${path}`, projectId, path, projectId, path, path, now);
      }
    });
    replace();
  }

  search(request: WorkbenchSearchRequest): WorkbenchSearchResponse {
    if (request.projectId !== null) request = { ...request, projectId: new WorkbenchProjectRepository(this.database).resolveStoredReference(request.projectId) };
    const clauses = parseWorkbenchSearchQuery(request.query);
    const matchFields = createWorkbenchSearchMatcher(clauses);
    const ranked: RankedResult[] = [];
    for (const row of this.readDocuments(request.projectId)) {
      const match = matchFields([{
        kind: row.kind === "file" ? "filePath" : "title",
        text: row.search_text,
      }]);
      if (!match) continue;
      const result = this.toDocumentResult(row, request.projectId);
      if (result) ranked.push({ activityAt: 0, result, score: match.score });
    }

    const bodies = new Map(this.readUnsettledBodies().map((row) => [row.thread_id, row]));
    for (const row of this.readThreadTitles()) {
      const body = bodies.get(row.id);
      const match = matchFields([
        { kind: "title", text: row.title },
        ...(body?.user_text ? [{ kind: "userMessage" as const, text: body.user_text }] : []),
        ...(body?.commentary_text ? [{ kind: "commentary" as const, text: body.commentary_text }] : []),
      ]);
      if (!match) continue;
      ranked.push({
        activityAt: row.activity_at,
        result: {
          detail: match.bestFieldKind === "userMessage"
            ? `You: ${this.preview(body?.user_text ?? "")}`
            : match.bestFieldKind === "commentary"
              ? `Agent: ${this.preview(body?.commentary_text ?? "")}`
              : row.project_id,
          harnessId: row.harness_id,
          id: `thread:${row.id}`,
          kind: "thread",
          projectId: row.project_id,
          threadId: row.id,
          title: row.title,
        },
        score: match.score,
      });
    }

    ranked.sort((left, right) => (
      right.score - left.score
      || right.activityAt - left.activityAt
      || left.result.title.localeCompare(right.result.title)
      || left.result.id.localeCompare(right.result.id)
    ));
    return { results: ranked.slice(0, 50).map(({ result }) => result) };
  }

  private readDocuments(projectId: string | null) {
    return this.database.prepare(`
      SELECT detail, kind, project_id, search_text, target, title
      FROM workbench_search_documents
      WHERE kind IN ('action', 'project')
         OR (? IS NOT NULL AND kind = 'projectSetting')
         OR (? IS NOT NULL AND kind = 'file' AND project_id = ?)
    `).all(projectId, projectId, projectId) as SearchDocumentRow[];
  }

  private readThreadTitles() {
    return this.database.prepare(`
      SELECT
        threads.id,
        threads.project_id,
        threads.title,
        threads.activity_at,
        COALESCE((
          SELECT turns.harness_id
          FROM thread_turns AS turns
          WHERE turns.thread_id = threads.id
          ORDER BY turns.turn_index
          LIMIT 1
        ), 'codex') AS harness_id
      FROM workbench_threads AS threads
    `).all() as ThreadTitleRow[];
  }

  private readUnsettledBodies() {
    return this.database.prepare(`
      SELECT
        threads.id AS thread_id,
        COALESCE(GROUP_CONCAT(DISTINCT user_parts.text), '') AS user_text,
        COALESCE(GROUP_CONCAT(DISTINCT assistant.text), '') AS commentary_text
      FROM workbench_threads AS threads
      LEFT JOIN workbench_thread_lifecycle AS lifecycle ON lifecycle.thread_id = threads.id
      JOIN thread_turns AS turns ON turns.thread_id = threads.id
      JOIN thread_items AS items ON items.turn_id = turns.id
      LEFT JOIN thread_user_message_parts AS user_parts
        ON user_parts.item_id = items.id AND user_parts.part_type = 'text'
      LEFT JOIN thread_item_assistant_messages AS assistant
        ON assistant.item_id = items.id AND assistant.phase = 'commentary'
      WHERE COALESCE(lifecycle.settled, 0) = 0
      GROUP BY threads.id
    `).all() as ThreadBodyRow[];
  }

  private seedStaticDocuments() {
    const insert = this.database.prepare(`
      INSERT INTO workbench_search_documents
        (document_key, kind, project_id, title, detail, target, search_text, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, 0)
      ON CONFLICT(document_key) DO UPDATE SET
        title = excluded.title, detail = excluded.detail, target = excluded.target,
        search_text = excluded.search_text
    `);
    const seed = this.database.transaction(() => {
      for (const action of WORKBENCH_SEARCH_ACTIONS) {
        insert.run(`action:${action.id}`, "action", action.title, action.shortcut, action.id, `${action.title} ${action.shortcut}`);
      }
      for (const definition of Object.values(WORKBENCH_SETTING_DEFINITIONS)) {
        insert.run(
          `setting:${definition.key}`,
          "projectSetting",
          definition.label,
          definition.description,
          definition.key,
          `${definition.label} ${definition.description}`,
        );
      }
    });
    seed();
  }

  private preview(text: string) {
    const compact = text.replace(/\s+/gu, " ").trim();
    return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
  }

  private toDocumentResult(row: SearchDocumentRow, projectId: string | null): WorkbenchSearchResult | null {
    switch (row.kind) {
      case "action":
        return { actionId: row.target as WorkbenchSearchActionId, detail: row.detail, id: `action:${row.target}`, kind: "action", title: row.title };
      case "project":
        return { detail: row.detail, id: `project:${row.target}`, kind: "project", projectId: row.target, title: row.title };
      case "projectSetting":
        return projectId ? { detail: row.detail, id: `setting:${row.target}`, kind: "projectSetting", projectId, settingKey: row.target, title: row.title } : null;
      case "file":
        return row.project_id ? { detail: row.detail, id: `file:${row.project_id}:${row.target}`, kind: "file", path: row.target, projectId: row.project_id, title: row.title } : null;
    }
  }
}
