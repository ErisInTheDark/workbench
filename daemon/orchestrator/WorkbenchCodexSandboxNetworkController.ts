/*
 * WorkbenchCodexSandboxNetworkSnapshot: resolved global and project Codex sandbox network state. Keywords: Codex, sandbox, network, settings.
 * default WorkbenchCodexSandboxNetworkController: own persisted global and project Codex sandbox network settings. Keywords: Codex, sandbox, network, controller.
 */
import {
  deleteRows,
  selectRows,
  upsertRow,
  type WorkbenchDatabaseMutation,
  type WorkbenchDatabaseQuery,
  type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";

import {
  codexSandboxNetworkGlobalSettings,
  codexSandboxNetworkProjectOverrides,
} from "../lib/workbench/database/schema/codex-sandbox-network-schema";

export interface WorkbenchCodexSandboxNetworkSnapshot {
  effectiveEnabled: boolean;
  globalEnabled: boolean;
  projectId: string;
  projectOverride: boolean | null;
}

export interface WorkbenchCodexSandboxNetworkDatabase {
  executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<{ changes: number }>;
  query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
}

export default class WorkbenchCodexSandboxNetworkController {
  private operationQueue = Promise.resolve();

  constructor(private readonly database: WorkbenchCodexSandboxNetworkDatabase) {}

  async read(projectId: string): Promise<WorkbenchCodexSandboxNetworkSnapshot> {
    return await this.enqueue(async () => await this.readSnapshot(projectId));
  }

  async resolve(projectId: string) {
    return (await this.read(projectId)).effectiveEnabled;
  }

  async setGlobal(enabled: boolean) {
    await this.enqueue(async () => {
      await this.database.executeTransaction([
        upsertRow(codexSandboxNetworkGlobalSettings, {
          enabled: enabled ? 1 : 0,
          id: "global",
        }, {
          conflictColumns: ["id"],
          updateColumns: ["enabled"],
        }),
      ]);
    });
  }

  async setProjectOverride(projectId: string, enabled: boolean | null) {
    await this.enqueue(async () => {
      await this.database.executeTransaction([
        enabled === null
          ? deleteRows(codexSandboxNetworkProjectOverrides, { project_id: projectId })
          : upsertRow(codexSandboxNetworkProjectOverrides, {
              enabled: enabled ? 1 : 0,
              project_id: projectId,
            }, {
              conflictColumns: ["project_id"],
              updateColumns: ["enabled"],
            }),
      ]);
    });
  }

  private async readSnapshot(projectId: string): Promise<WorkbenchCodexSandboxNetworkSnapshot> {
    const [globalRows, projectRows] = await Promise.all([
      this.database.query(selectRows(codexSandboxNetworkGlobalSettings, {
        where: { id: "global" },
      })),
      this.database.query(selectRows(codexSandboxNetworkProjectOverrides, {
        where: { project_id: projectId },
      })),
    ]);
    const globalEnabled = globalRows[0]?.enabled === 1;
    const projectOverride = projectRows[0] ? projectRows[0].enabled === 1 : null;
    return {
      effectiveEnabled: projectOverride ?? globalEnabled,
      globalEnabled,
      projectId,
      projectOverride,
    };
  }

  private async enqueue<Result>(operation: () => Promise<Result>) {
    const result = this.operationQueue.catch(() => undefined).then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return await result;
  }
}
