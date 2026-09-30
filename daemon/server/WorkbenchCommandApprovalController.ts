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
import { canonicalApprovalWorkdir, matchesApprovalPrefix, parseApprovalCommand } from "./lib/workbench/command-approval-prefix";

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

  async patch(projectId: ProjectId, workdir: string, add: readonly string[], removeIds: readonly string[]) {
    const canonical = canonicalApprovalWorkdir(workdir);
    if (!canonical) throw new Error("Command approvals require an absolute execution directory.");
    if (new Set(removeIds).size !== removeIds.length) throw new Error("A command approval was selected more than once.");
    const additions = add.map(command => {
      const prefix = parseApprovalCommand(command);
      if (!prefix) throw new Error("A command prefix must be one literal command without shell code.");
      return prefix;
    });
    const samePrefix = (left: readonly string[], right: readonly string[]) =>
      left.length === right.length && left.every((token, index) => token === right[index]);
    if (additions.some((prefix, index) => additions.slice(index + 1).some(other => samePrefix(prefix, other)))) {
      throw new Error("A command prefix was entered more than once.");
    }
    const rules = await this.list(projectId);
    const removed = rules.filter(rule => removeIds.includes(rule.id));
    if (removed.length !== removeIds.length || removed.some(rule => rule.workdir !== canonical)) {
      throw new Error("A command approval does not belong to this execution directory.");
    }
    const remaining = rules.filter(rule => rule.workdir === canonical && !removeIds.includes(rule.id));
    if (additions.some(prefix => remaining.some(rule => samePrefix(prefix, rule.prefix)))) {
      throw new Error("A command prefix is already saved in this execution directory.");
    }
    const created = additions.map(prefix => CommandApprovalRuleSchema.parse({
      id: randomUUID(), projectId, workdir: canonical, prefix,
    }));
    const mutations = [
      ...removed.map(rule => deleteRows(commandApprovalRules, { id: rule.id, project_id: projectId })),
      ...created.flatMap(rule => [
        insertRow(commandApprovalRules, { id: rule.id, project_id: rule.projectId, workdir: rule.workdir }),
        ...rule.prefix.map((token, index) => insertRow(commandApprovalTokens, {
          rule_id: rule.id, token_index: index, token,
        })),
      ]),
    ];
    if (mutations.length) await this.database.executeTransaction(mutations);
    return await this.list(projectId);
  }

  async match(projectId: ProjectId, workdir: string, argv: readonly string[]): Promise<CommandApprovalRule | null> {
    const canonical = canonicalApprovalWorkdir(workdir);
    if (!canonical) return null;
    const rules = await this.list(projectId);
    return rules.filter(rule => rule.workdir === canonical && matchesApprovalPrefix(argv, rule.prefix))
      .sort((left, right) => right.prefix.length - left.prefix.length)[0] ?? null;
  }
}
