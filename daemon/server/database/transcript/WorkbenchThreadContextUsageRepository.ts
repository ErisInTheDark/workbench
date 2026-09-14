/*
 * Keywords: thread, context, sqlite, snapshot.
 * Exports:
 * - default WorkbenchThreadContextUsageRepository: own durable last-reported measurements and insert-only recovery.
 */
import type Database from "better-sqlite3";
import type { ThreadContextUsageSnapshot } from "workbench-shared/workbench/thread/thread-context-usage";
import { ThreadTokenUsageSchema } from "workbench-shared/workbench/thread/thread-context-usage";
import { threadContextUsage } from "workbench-shared/workbench/database/schema/usage-schema";
import { compileWorkbenchDatabaseStatement, selectRows, upsertRow } from "workbench-shared/database/workbench-database-statements";
import type { SelectRow } from "workbench-shared/database/schema/schema-definition";

const tables = { [threadContextUsage.name]: threadContextUsage };

export default class WorkbenchThreadContextUsageRepository {
  constructor(private readonly database: Database.Database) {}

  read(threadId: string): ThreadContextUsageSnapshot | null {
    const query = compileWorkbenchDatabaseStatement(tables, selectRows(threadContextUsage, { where: { thread_id: threadId } }));
    const row = this.database.prepare(query.sql).get(...query.parameters) as SelectRow<typeof threadContextUsage> | undefined;
    if (!row) return null;
    if (row.state === "unavailable") return { tokenUsage: null };
    return { tokenUsage: ThreadTokenUsageSchema.parse({
      modelContextWindow: row.model_context_window,
      last: {
        inputTokens: row.last_input_tokens, cachedInputTokens: row.last_cached_input_tokens,
        cacheWriteInputTokens: row.last_cache_write_input_tokens, outputTokens: row.last_output_tokens,
        reasoningOutputTokens: row.last_reasoning_output_tokens, totalTokens: row.last_total_tokens,
      },
      total: {
        inputTokens: row.total_input_tokens, cachedInputTokens: row.total_cached_input_tokens,
        cacheWriteInputTokens: row.total_cache_write_input_tokens, outputTokens: row.total_output_tokens,
        reasoningOutputTokens: row.total_reasoning_output_tokens, totalTokens: row.total_tokens,
      },
    }) };
  }

  write(threadId: string, snapshot: ThreadContextUsageSnapshot, initialise: boolean) {
    this.database.transaction(() => {
      if (initialise && this.read(threadId)) return;
      const usage = ThreadTokenUsageSchema.nullable().parse(snapshot.tokenUsage);
      const fields = {
        state: usage ? "reported" as const : "unavailable" as const,
        model_context_window: usage?.modelContextWindow ?? null,
        last_input_tokens: usage?.last.inputTokens ?? null,
        last_cached_input_tokens: usage?.last.cachedInputTokens ?? null,
        last_cache_write_input_tokens: usage?.last.cacheWriteInputTokens ?? null,
        last_output_tokens: usage?.last.outputTokens ?? null,
        last_reasoning_output_tokens: usage?.last.reasoningOutputTokens ?? null,
        last_total_tokens: usage?.last.totalTokens ?? null,
        total_input_tokens: usage?.total.inputTokens ?? null,
        total_cached_input_tokens: usage?.total.cachedInputTokens ?? null,
        total_cache_write_input_tokens: usage?.total.cacheWriteInputTokens ?? null,
        total_output_tokens: usage?.total.outputTokens ?? null,
        total_reasoning_output_tokens: usage?.total.reasoningOutputTokens ?? null,
        total_tokens: usage?.total.totalTokens ?? null,
      };
      const statement = compileWorkbenchDatabaseStatement(tables, upsertRow(threadContextUsage, {
        thread_id: threadId, ...fields,
      }, { conflictColumns: ["thread_id"], updateColumns: Object.keys(fields) as (keyof typeof fields)[] }));
      this.database.prepare(statement.sql).run(...statement.parameters);
    })();
  }
}
