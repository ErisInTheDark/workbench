/*
 * Exports:
 * - default WorkbenchSearchRepository: own SQLite search projections, identity rekeying, and ranked workspace search over names and indexed thread narrative.
 */
import type Database from "better-sqlite3";
import WorkbenchProjectRepository from "../project/WorkbenchProjectRepository.ts";
import WorkbenchSearchNarrativeIndex, { SEARCHABLE_THREADS, type NarrativeThreadMatch } from "./WorkbenchSearchNarrativeIndex.ts";
import {
  createSearchName,
  matchSearchName,
  parseSearchQuery,
  rankSearchCandidate,
  searchBodyQuality,
  searchCorrections,
  searchExcerpt,
  type SearchClause,
  type SearchName,
} from "./workbench-search-ranking.ts";

import {
  WORKBENCH_SEARCH_ACTIONS,
  WORKBENCH_SEARCH_RESULT_LIMIT,
  arrangeWorkbenchSearchResults,
  type WorkbenchSearchCorrection,
  type WorkbenchSearchKind,
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

interface Candidate {
  /** Documents sit mid-range; threads range from 1 to the max with freshness and current-project affinity. */
  lift: number;
  names: readonly SearchName[];
  result: WorkbenchSearchResult;
}

const THREAD_FRESHNESS_HALF_LIFE_MS = 14 * 86_400_000;
const THREAD_FRESHNESS_LIFT = 0.3;
const CURRENT_PROJECT_LIFT = 0.1;
const DOCUMENT_LIFT = 1.15;
const DIRECTORY_WEIGHT = 0.7;
const DESCRIPTION_WEIGHT = 0.5;

function documentNames(row: SearchDocumentRow): SearchName[] {
  switch (row.kind) {
    case "file": {
      const slash = Math.max(row.title.lastIndexOf("/"), row.title.lastIndexOf("\\"));
      return [
        createSearchName(row.title.slice(slash + 1), { initials: true }),
        createSearchName(row.title.slice(0, Math.max(0, slash)), { weight: DIRECTORY_WEIGHT }),
      ];
    }
    case "project":
      return [createSearchName(row.title), createSearchName(row.detail, { weight: DIRECTORY_WEIGHT })];
    case "projectSetting":
    case "action":
      return [createSearchName(row.title), createSearchName(row.detail, { weight: DESCRIPTION_WEIGHT })];
  }
}

function quote(text: string) {
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function anyOf(terms: readonly string[]) {
  return terms.map(quote).join(" OR ");
}

/**
 * FTS5 expression for one clause. Words also match as prefixes so results keep up with typing (whole words
 * match both arms, so bm25 ranks them above completions), and camel-cased words also match their parts as a
 * phrase ("SearchDialog" finds "search dialog").
 */
function narrativeExpression(clause: SearchClause) {
  // One or two typed letters prefix most of the vocabulary: names answer them, message bodies would only drown them.
  if (!/[\p{L}\p{N}]/u.test(clause.value) || (clause.kind === "word" && clause.value.length < 2)) return null;
  const quoted = quote(clause.value);
  if (clause.kind === "phrase") return quoted;
  if (clause.value.length < 3) return quoted;
  const parts = clause.tokens.length > 1 ? ` OR ${quote(clause.tokens.join(" "))}*` : "";
  return `${quoted} OR ${quoted}*${parts}`;
}

export default class WorkbenchSearchRepository {
  private narrativeIndex: WorkbenchSearchNarrativeIndex | null = null;

  constructor(
    private readonly database: Database.Database,
    private readonly options: { now?(): number } = {},
  ) {
    this.seedStaticDocuments();
  }

  /** Index one more chunk of existing narrative; false once the index is complete. */
  indexNarrative() {
    return this.narrative.backfillStep();
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
    const projectId = request.projectId === null ? null
      : new WorkbenchProjectRepository(this.database).resolveStoredReference(request.projectId);
    const clauses = parseSearchQuery(request.query);
    const positives = clauses.filter(clause => !clause.excluded);
    const negatives = clauses.filter(clause => clause.excluded);
    const wanted = (kind: WorkbenchSearchKind) => !request.kinds || request.kinds.includes(kind);
    const candidates = [
      ...this.readDocuments(projectId).flatMap(row => {
        const result = this.toDocumentResult(row, projectId);
        if (!result || !wanted(result.kind)
          || (!positives.length && (result.kind === "file" || result.kind === "projectSetting"))) return [];
        return [{ lift: DOCUMENT_LIFT, names: documentNames(row), result }];
      }),
      ...!wanted("thread") ? [] : this.readThreadTitles()
        .filter(row => !request.projectOnly || !projectId || row.project_id === projectId)
        .map(row => this.toThreadCandidate(row, projectId)),
    ];
    const arrange = <Result extends WorkbenchSearchResult>(results: readonly Result[]) =>
      arrangeWorkbenchSearchResults(results, result => result, request.kinds).slice(0, WORKBENCH_SEARCH_RESULT_LIMIT);

    const excludedThreads = new Set(negatives.flatMap(clause => {
      const expression = narrativeExpression(clause);
      return expression ? [...this.narrative.match(expression).keys()] : [];
    }));
    const included = candidates.filter(candidate => !negatives.some(clause => matchSearchName(clause, candidate.names) > 0)
      && !(candidate.result.kind === "thread" && excludedThreads.has(candidate.result.threadId)));

    if (!positives.length) {
      return { results: arrange(included.map(candidate => ({
        ...candidate.result,
        score: candidate.result.kind === "thread" ? 0.99 * candidate.lift / (1 + THREAD_FRESHNESS_LIFT + CURRENT_PROJECT_LIFT) : 0,
      }))) };
    }

    const nameEvidence = included.map(candidate => positives.map(clause => matchSearchName(clause, candidate.names)));
    const narrative = this.matchNarrative(positives, included, nameEvidence);

    const ranked: Array<WorkbenchSearchResult & { messageKey: number | null }> = [];
    for (const [candidateIndex, candidate] of included.entries()) {
      const threadId = candidate.result.kind === "thread" ? candidate.result.threadId : null;
      const together = threadId ? narrative.together.get(threadId) : undefined;
      // Without one message holding every clause, the excerpt shows the message best for the most clauses.
      const votes = new Map<number, number>();
      const evidence = positives.map((_, index) => {
        const match = threadId ? narrative.clauses[index]!.get(threadId) : undefined;
        const body = match ? searchBodyQuality(match.rank) : 0;
        if (match) votes.set(match.messageKey, (votes.get(match.messageKey) ?? 0) + 1 + body);
        return { body, name: nameEvidence[candidateIndex]![index]! };
      });
      const messageKey = together?.messageKey
        ?? [...votes].reduce<[number, number] | null>((best, vote) => !best || vote[1] > best[1] ? vote : best, null)?.[0]
        ?? null;
      const score = rankSearchCandidate(positives, evidence, {
        lift: candidate.lift, together: together ? searchBodyQuality(together.rank) : 0,
      });
      if (score === null) continue;
      // Shorter paths win otherwise-equal file matches.
      const tieBreak = candidate.result.kind === "file" ? candidate.result.path.length * 1e-7 : 0;
      ranked.push({ ...candidate.result, messageKey, score: score - tieBreak });
    }

    const results = arrange(ranked).map(({ messageKey, ...result }) => {
      if (result.kind !== "thread" || messageKey === null) return result;
      const message = this.narrative.readMessage(messageKey);
      return message?.text ? {
        ...result,
        excerpt: { role: message.role === "user" ? "user" as const : "agent" as const, text: searchExcerpt(message.text, narrative.needles) },
      } : result;
    });
    return narrative.corrections.length ? { corrections: narrative.corrections, results } : { results };
  }

  /**
   * Per-clause best message per thread, plus the best message holding every clause at once.
   * A clause the index cannot find directly retries as a fragment of squashed identifiers, then, when nothing
   * anywhere matched it, as nearby spellings; corrected spellings also rescore names.
   */
  private matchNarrative(positives: readonly SearchClause[], included: readonly Candidate[], nameEvidence: number[][]) {
    const needles = positives.flatMap(clause => [clause.value, ...clause.tokens]);
    const corrections: WorkbenchSearchCorrection[] = [];
    const expressions = positives.map(narrativeExpression);
    const clauses = positives.map((clause, index) => {
      let matches = expressions[index] ? this.narrative.match(expressions[index]) : new Map<string, NarrativeThreadMatch>();
      if (matches.size || clause.kind !== "word") return matches;
      const fragment = clause.tokens.join("");
      const containing = fragment.length >= 4 ? this.narrative.vocabularyContaining(fragment) : [];
      if (containing.length) {
        expressions[index] = anyOf(containing);
        needles.push(fragment);
        return this.narrative.match(expressions[index]);
      }
      if (nameEvidence.some(evidence => evidence[index]! > 0) || clause.tokens.length !== 1) return matches;
      const nearby = searchCorrections(clause.value, [
        ...this.narrative.vocabularyNear(clause.value),
        ...included.flatMap(candidate => candidate.names.flatMap(name => name.tokens.map(term => ({ frequency: 1, term })))),
      ]);
      if (!nearby.length) return matches;
      const corrected = new Set(nearby);
      included.forEach((candidate, candidateIndex) => {
        nameEvidence[candidateIndex]![index] = matchSearchName(clause, candidate.names, corrected);
      });
      needles.push(...nearby);
      expressions[index] = anyOf(nearby);
      corrections.push({ from: clause.value, to: nearby[0]! });
      matches = this.narrative.match(expressions[index]);
      return matches;
    });
    const present = expressions.filter((expression): expression is string => expression !== null);
    const together = present.length > 1 && present.length === positives.length
      ? this.narrative.match(present.map(expression => `(${expression})`).join(" AND "))
      : new Map<string, NarrativeThreadMatch>();
    return { clauses, corrections, needles, together };
  }

  private get narrative() {
    return this.narrativeIndex ??= new WorkbenchSearchNarrativeIndex(this.database);
  }

  private toThreadCandidate(row: ThreadTitleRow, projectId: string | null): Candidate {
    const age = Math.max(0, (this.options.now?.() ?? Date.now()) - row.activity_at);
    return {
      lift: 1 + THREAD_FRESHNESS_LIFT * 2 ** (-age / THREAD_FRESHNESS_HALF_LIFE_MS)
        + (row.project_id === projectId ? CURRENT_PROJECT_LIFT : 0),
      names: [createSearchName(row.title)],
      result: {
        detail: "", harnessId: row.harness_id, id: `thread:${row.id}`, kind: "thread",
        projectId: row.project_id, threadId: row.id, title: row.title,
      },
    };
  }

  private readDocuments(projectId: string | null) {
    return this.database.prepare(`
      SELECT detail, kind, project_id, target, title
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
      ${SEARCHABLE_THREADS}
      ORDER BY threads.activity_at DESC
    `).all() as ThreadTitleRow[];
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

  private toDocumentResult(row: SearchDocumentRow, projectId: string | null): WorkbenchSearchResult | null {
    switch (row.kind) {
      case "action":
        return { actionId: row.target as WorkbenchSearchActionId, detail: row.detail, id: `action:${row.target}`, kind: "action", title: row.title };
      case "project":
        return { detail: row.detail, id: `project:${row.target}`, kind: "project", projectId: row.target, title: row.title };
      case "projectSetting":
        return projectId ? { detail: row.detail, id: `setting:${row.target}`, kind: "projectSetting", projectId, settingKey: row.target, title: row.title } : null;
      case "file": {
        if (!row.project_id) return null;
        const slash = row.target.lastIndexOf("/");
        return {
          detail: row.target.slice(0, Math.max(0, slash)), id: `file:${row.project_id}:${row.target}`, kind: "file",
          path: row.target, projectId: row.project_id, title: row.target.slice(slash + 1),
        };
      }
    }
  }
}
