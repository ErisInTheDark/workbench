/*
 * No production exports. Tests protect SQLite-only model attribution precedence and repair. Keywords: stats, model, attribution, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchStatsAttributionRepository from "./WorkbenchStatsAttributionRepository.ts";

function databaseWithUsage() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  database.prepare("INSERT INTO workbench_harnesses (id) VALUES ('codex')").run();
  database.prepare(`
    INSERT INTO workbench_threads (
      id, project_id, project_root, title, archived, pinned, snoozed,
      transcript_content_version, next_turn_index, created_at, updated_at, activity_at
    ) VALUES ('thread', 'project', 'C:/project', 'thread', 0, 0, 0, 0, 2, 1, 1, 1)
  `).run();
  for (const [id, index] of [["known", 0], ["missing", 1]] as const) {
    database.prepare(`
      INSERT INTO thread_turns (
        id, thread_id, turn_index, harness_id, native_location, native_thread_id,
        native_turn_id, state, created_at, started_at, ended_at, duration_ms
      ) VALUES (?, 'thread', ?, 'codex', 'C:/project', 'thread', ?, 'completed', 1, 1, 2, 1)
    `).run(id, index, id);
    database.prepare(`
      INSERT INTO thread_turn_usage (
        turn_id, model, service_tier, cumulative_input_tokens, cumulative_cached_input_tokens,
        cumulative_cache_write_input_tokens, cumulative_output_tokens,
        cumulative_reasoning_output_tokens, cumulative_total_tokens, usage_data_version,
        context_observed_at, usage_observed_at
      ) VALUES (?, ?, NULL, 10, 2, 0, 4, 0, 14, 2, ?, 1)
    `).run(id, id === "known" ? "gpt-5.4" : null, id === "known" ? 1 : null);
  }
  return database;
}

test("model attribution prefers a nearby exact turn and never overwrites it", () => {
  const database = databaseWithUsage();
  try {
    const repository = new WorkbenchStatsAttributionRepository(database);
    assert.equal(repository.repair(10), 1);
    assert.deepEqual(database.prepare(`
      SELECT turn_id, model, source FROM thread_usage_model_attributions ORDER BY turn_id
    `).all(), [{ turn_id: "missing", model: "gpt-5.4", source: "thread" }]);
  } finally {
    database.close();
  }
});

test("model attribution falls through thread, project, and provider SQLite evidence", () => {
  const database = databaseWithUsage();
  try {
    database.prepare("UPDATE thread_turn_usage SET model = NULL, context_observed_at = NULL").run();
    database.prepare(`
      INSERT INTO workbench_thread_state_threads (
        id, project_id, thread_kind, visibility, title, archived, pinned, snoozed,
        provider_observed, created_at, updated_at, activity_at, order_at
      ) VALUES ('thread', 'project', 'topLevel', 'visible', 'thread', 0, 0, 0, 1, 1, 1, 1, NULL)
    `).run();
    database.prepare(`
      INSERT INTO workbench_thread_state_profiles (
        thread_id, selection_kind, profile_id, harness_id, model
      ) VALUES ('thread', 'custom', NULL, 'codex', 'thread-model')
    `).run();
    database.prepare(`
      INSERT INTO workbench_thread_state_project_profiles (
        project_id, selection_kind, profile_id, harness_id, model
      ) VALUES ('project', 'custom', NULL, 'codex', 'project-model')
    `).run();
    const repository = new WorkbenchStatsAttributionRepository(database);
    repository.repair(10);
    const attribution = () => database.prepare(`
      SELECT model, source FROM thread_usage_model_attributions WHERE turn_id = 'missing'
    `).get() as { model: string; source: string };
    assert.deepEqual(attribution(), { model: "thread-model", source: "thread" });

    database.prepare("DELETE FROM workbench_thread_state_profiles").run();
    repository.repair(11);
    assert.deepEqual(attribution(), { model: "project-model", source: "project" });

    database.prepare("DELETE FROM workbench_thread_state_project_profiles").run();
    repository.repair(12);
    assert.deepEqual(attribution(), { model: "gpt-5.6-sol", source: "provider" });

    database.prepare("UPDATE thread_turn_usage SET model = 'exact-model' WHERE turn_id = 'missing'").run();
    repository.repair(13);
    assert.equal(attribution(), undefined);
  } finally {
    database.close();
  }
});
