/*
 * Exports:
 * - CommandApprovalDatabase: typed persistence port.
 * - default WorkbenchCommandApprovalController: own saved permissions without a mirror cache.
 */
import { randomUUID } from "node:crypto";
import type { ProjectId } from "workbench-shared/workbench/identity";
import { CommandApprovalRuleSchema, type CommandApprovalRule } from "workbench-shared/workbench/settings/command-approvals";
import { deleteRows, insertRow, selectRows, type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow } from "workbench-shared/database/workbench-database-statements";
import { commandApprovalRules, commandApprovalTokens } from "./lib/workbench/database/schema/command-approval-schema";
import { canonicalApprovalWorkdir, matchesApprovalPrefix } from "./lib/workbench/command-approval-prefix";

export interface CommandApprovalDatabase {
  executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<{ changes: number }>;
  query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
}

export default class WorkbenchCommandApprovalController {
  constructor(private readonly database: CommandApprovalDatabase) {}

  async list(projectId: ProjectId): Promise<CommandApprovalRule[]> {
    const rows = await this.database.query(selectRows(commandApprovalRules, { where: { project_id: projectId }, orderBy: [{ column: "id" }] }));
    return await Promise.all(rows.map(async row => {
      const tokens = await this.database.query(selectRows(commandApprovalTokens, {
        where: { rule_id: row.id }, orderBy: [{ column: "token_index" }],
      }));
      if (tokens.some((token, index) => token.token_index !== index)) throw new Error("Saved approval has an invalid token sequence.");
      return CommandApprovalRuleSchema.parse({
        id: row.id, projectId: row.project_id, workdir: row.workdir, prefix: tokens.map(token => token.token),
      });
    }));
  }

  async save(projectId: ProjectId, workdir: string, prefix: readonly string[]): Promise<CommandApprovalRule> {
    const canonical = canonicalApprovalWorkdir(workdir);
    if (!canonical) throw new Error("A saved approval requires an absolute execution directory.");
    const rule = CommandApprovalRuleSchema.parse({ id: randomUUID(), projectId, workdir: canonical, prefix: [...prefix] });
    await this.database.executeTransaction([
      insertRow(commandApprovalRules, { id: rule.id, project_id: rule.projectId, workdir: rule.workdir }),
      ...rule.prefix.map((token, index) => insertRow(commandApprovalTokens, { rule_id: rule.id, token_index: index, token })),
    ]);
    return rule;
  }

  async remove(projectId: ProjectId, id: string): Promise<void> {
    await this.database.executeTransaction([deleteRows(commandApprovalRules, { id, project_id: projectId })]);
  }

  async match(projectId: ProjectId, workdir: string, argv: readonly string[]): Promise<CommandApprovalRule | null> {
    const canonical = canonicalApprovalWorkdir(workdir);
    if (!canonical) return null;
    const rules = await this.list(projectId);
    return rules.filter(rule => rule.workdir === canonical && matchesApprovalPrefix(argv, rule.prefix))
      .sort((left, right) => right.prefix.length - left.prefix.length)[0] ?? null;
  }
}
