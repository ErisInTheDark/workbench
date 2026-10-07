/*
 * Exports:
 * - formatApprovalReviewState: describe one approval subject as reviewer input.
 * - WorkbenchApprovalReviewOptions: database, credential and provider reviewer ports.
 * - default WorkbenchApprovalReviewController: own the selected auto-approve reviewer, its sealed secrets, readiness and dispatch.
 */
import os from "node:os";
import type { WorkbenchApprovalSubject } from "workbench-shared/workbench/provider/provider-approval";
import {
  APPROVAL_REVIEWERS, ApprovalReviewerIdSchema, type ApprovalReviewerId,
} from "workbench-shared/workbench/approval-review/approval-reviewers";
import {
  ApprovalReviewSettingsUpdateSchema, type ApprovalReviewSettingsSnapshot, type ApprovalReviewSettingsUpdate,
  type ApprovalReviewVerdict,
} from "workbench-shared/workbench/approval-review/approval-review-settings";
import {
  deleteRows, selectRows, upsertRow, type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import { approvalReviewSecrets, approvalReviewSelection } from "../lib/workbench/database/schema/approval-review-schema";
import { deriveProjectStoreKey, openProjectStoreValue, sealProjectStoreValue } from "../store/project-store-crypto";
import { reviewWithSystemOne } from "./systemone-approval-reviewer";

export interface WorkbenchApprovalReviewOptions {
  database: {
    executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<{ changes: number }>;
    query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
  };
  readDeviceIdentity(): Promise<string>;
  readOpenCodeApiKey(): Promise<string | null>;
  /** The installed Codex provider's reviewer, or null when Codex is not installed. */
  codexReviewer(): { review(state: string, signal: AbortSignal): Promise<ApprovalReviewVerdict> } | null;
  fetch?: typeof fetch;
  user?: () => string;
}

// Secrets are sealed with the project-store cipher, bound to this device, OS user and this settings scope.
const SECRET_SCOPE = "approval-review";

function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 200);
}

export function formatApprovalReviewState(subject: WorkbenchApprovalSubject) {
  const lines = (() => {
    switch (subject.kind) {
      case "command": return [
        "Action: run a shell command outside the sandbox.",
        `Command: ${subject.command}`,
        `Directory: ${subject.cwd}`,
        ...(subject.networkTarget ? [`Network target: ${subject.networkTarget}`] : []),
        `Justification: ${subject.justification ?? "(none given)"}`,
      ];
      case "patch": return [
        "Action: write files outside the sandbox.",
        `Paths: ${subject.paths.join(", ")}`,
        `Justification: ${subject.reason ?? "(none given)"}`,
      ];
      case "fileChange": return [
        "Action: apply a file change outside the sandbox.",
        ...(subject.grantRoot ? [`Grant root: ${subject.grantRoot}`] : []),
        `Justification: ${subject.reason ?? "(none given)"}`,
      ];
      case "permissions": return [
        "Action: grant extra sandbox permissions.",
        `Directory: ${subject.cwd}`,
        `Permissions: ${subject.permissions ?? "(unspecified)"}`,
        `Justification: ${subject.reason ?? "(none given)"}`,
      ];
    }
  })();
  return [`Machine: ${os.platform()}`, ...lines].join("\n").slice(0, 8000);
}

export default class WorkbenchApprovalReviewController {
  #secret: Promise<Buffer> | null = null;

  constructor(private readonly options: WorkbenchApprovalReviewOptions) {}

  async read(): Promise<ApprovalReviewSettingsSnapshot> {
    const [selected, secrets] = await Promise.all([this.readSelected(), this.readSecrets()]);
    const reviewers = await Promise.all(ApprovalReviewerIdSchema.options.map(async id => {
      const definition = APPROVAL_REVIEWERS[id];
      if (definition.credential === "workbench-secret") {
        const secret = secrets.get(id) ?? null;
        return { id, ready: Boolean(secret), detail: secret ? "API key saved." : "Add an API key to use this reviewer.", secret };
      }
      if (definition.credential === "opencode-auth") {
        try {
          return (await this.options.readOpenCodeApiKey())
            ? { id, ready: true, detail: "Uses your OpenCode login." }
            : { id, ready: false, detail: "Sign in to OpenCode Zen with opencode auth login." };
        } catch (error) {
          return { id, ready: false, detail: `OpenCode credentials are unreadable: ${sanitize(error)}` };
        }
      }
      return this.options.codexReviewer()
        ? { id, ready: true, detail: "Uses your Codex login. Needs a ChatGPT plan." }
        : { id, ready: false, detail: "Codex is not installed." };
    }));
    return { selected, reviewers };
  }

  async update(input: ApprovalReviewSettingsUpdate): Promise<ApprovalReviewSettingsSnapshot> {
    const update = ApprovalReviewSettingsUpdateSchema.parse(input);
    const mutations: WorkbenchDatabaseMutation[] = [];
    if (update.selected !== undefined) {
      mutations.push(upsertRow(approvalReviewSelection, { id: "global", reviewer_id: update.selected }, {
        conflictColumns: ["id"], updateColumns: ["reviewer_id"],
      }));
    }
    const now = Date.now();
    for (const [rawId, value] of Object.entries(update.secrets ?? {})) {
      const id = ApprovalReviewerIdSchema.parse(rawId);
      if (APPROVAL_REVIEWERS[id].credential !== "workbench-secret") throw new Error(`${APPROVAL_REVIEWERS[id].label} does not use a Workbench-held key.`);
      if (value === null) {
        mutations.push(deleteRows(approvalReviewSecrets, { reviewer_id: id }));
      } else if (value !== undefined) {
        const sealed = sealProjectStoreValue(await this.secret(), SECRET_SCOPE, id, value);
        mutations.push(upsertRow(approvalReviewSecrets, {
          reviewer_id: id, nonce: sealed.nonce, ciphertext: sealed.ciphertext, updated_at: now,
        }, { conflictColumns: ["reviewer_id"], updateColumns: ["nonce", "ciphertext", "updated_at"] }));
      }
    }
    if (mutations.length) await this.options.database.executeTransaction(mutations);
    return await this.read();
  }

  /** Judge one subject with the selected reviewer. Throws when none is selected or usable. */
  async review(subject: WorkbenchApprovalSubject, signal: AbortSignal): Promise<ApprovalReviewVerdict> {
    const id = await this.readSelected();
    if (!id) throw new Error("No auto-approve reviewer is selected.");
    const definition = APPROVAL_REVIEWERS[id];
    const state = formatApprovalReviewState(subject);
    if (definition.transport === "codex") {
      const reviewer = this.options.codexReviewer();
      if (!reviewer) throw new Error("Codex is not installed, so Codex auto-review is unavailable.");
      return await reviewer.review(state, signal);
    }
    const apiKey = definition.credential === "workbench-secret"
      ? (await this.readSecrets()).get(id) ?? null
      : await this.options.readOpenCodeApiKey();
    if (!apiKey) throw new Error(`${definition.label} has no usable credential.`);
    return await reviewWithSystemOne({ label: definition.label, url: definition.url, model: definition.model, apiKey, state }, signal, this.options.fetch);
  }

  private async readSelected(): Promise<ApprovalReviewerId | null> {
    const [row] = await this.options.database.query(selectRows(approvalReviewSelection, { where: { id: "global" } }));
    return row?.reviewer_id ?? null;
  }

  /** Decrypted secrets by reviewer; rows sealed on another device or user read as unset. */
  private async readSecrets() {
    const rows = await this.options.database.query(selectRows(approvalReviewSecrets, {}));
    const secret = rows.length ? await this.secret() : null;
    return new Map(rows.flatMap(row => {
      const value = openProjectStoreValue(secret!, SECRET_SCOPE, row.reviewer_id, row);
      return value === null ? [] : [[row.reviewer_id, value] as const];
    }));
  }

  private secret() {
    this.#secret ??= this.options.readDeviceIdentity().then(deviceId => deriveProjectStoreKey({
      deviceId, user: (this.options.user ?? (() => os.userInfo().username))(), projectLocation: SECRET_SCOPE,
    })).catch(error => {
      this.#secret = null;
      throw error;
    });
    return this.#secret;
  }
}
