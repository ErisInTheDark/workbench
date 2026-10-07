/*
 * Exports:
 * - formatApprovalReviewState: describe one approval subject as reviewer input.
 * - WorkbenchApprovalReviewOptions: database, credential, model catalogue and provider reviewer ports.
 * - default WorkbenchApprovalReviewController: own the selected auto-approve reviewer, its sealed secrets, availability and dispatch.
 */
import os from "node:os";
import type { WorkbenchApprovalSubject } from "workbench-shared/workbench/provider/provider-approval";
import {
  APPROVAL_REVIEWERS, ApprovalReviewerIdSchema, type ApprovalReviewerId,
} from "workbench-shared/workbench/approval-review/approval-reviewers";
import {
  ApprovalReviewSettingsUpdateSchema, type ApprovalReviewerAvailability, type ApprovalReviewSettingsSnapshot,
  type ApprovalReviewSettingsUpdate, type ApprovalReviewVerdict,
} from "workbench-shared/workbench/approval-review/approval-review-settings";
import {
  deleteRows, selectRows, upsertRow, type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import { approvalReviewSecrets, approvalReviewSelection } from "../lib/workbench/database/schema/approval-review-schema";
import { deriveProjectStoreKey, openProjectStoreValue, sealProjectStoreValue } from "../store/project-store-crypto";
import ReviewerModelCatalogue from "./ReviewerModelCatalogue";
import { reviewWithSystemOne } from "./systemone-approval-reviewer";

export interface WorkbenchApprovalReviewOptions {
  database: {
    executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<{ changes: number }>;
    query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
  };
  readDeviceIdentity(): Promise<string>;
  readOpenCodeApiKey(): Promise<string | null>;
  /** The installed Codex provider's reviewer, or null when Codex is not installed. */
  codexReviewer(): {
    availability(): Promise<ApprovalReviewerAvailability>;
    review(state: string, signal: AbortSignal): Promise<ApprovalReviewVerdict>;
  } | null;
  catalogue?: ReviewerModelCatalogue;
  fetch?: typeof fetch;
  user?: () => string;
  /** Receives availability check failures, which the snapshot reports only as short reasons. */
  warn?: (message: string) => void;
}

// Secrets are sealed with the project-store cipher, bound to this device, OS user and this settings scope.
const SECRET_SCOPE = "approval-review";
// OpenCode's own client sends this key when signed out; Zen then serves only its free models.
const ZEN_ANONYMOUS_KEY = "public";

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
  private readonly catalogue: ReviewerModelCatalogue;

  constructor(private readonly options: WorkbenchApprovalReviewOptions) {
    this.catalogue = options.catalogue ?? new ReviewerModelCatalogue({ fetch: options.fetch });
  }

  async read(): Promise<ApprovalReviewSettingsSnapshot> {
    const [selected, secrets] = await Promise.all([this.readSelected(), this.readSecrets()]);
    const reviewers = await Promise.all(ApprovalReviewerIdSchema.options.map(async id => {
      const availability = await this.availability(id, secrets);
      return APPROVAL_REVIEWERS[id].credential === "workbench-secret"
        ? { id, ...availability, secret: secrets.get(id) ?? null }
        : { id, ...availability };
    }));
    return { selected, reviewers };
  }

  /** Whether one reviewer can judge requests now; every failure becomes a short unavailable reason. */
  private async availability(id: ApprovalReviewerId, secrets: ReadonlyMap<ApprovalReviewerId, string>): Promise<ApprovalReviewerAvailability> {
    const definition = APPROVAL_REVIEWERS[id];
    if (definition.transport === "codex") {
      const reviewer = this.options.codexReviewer();
      if (!reviewer) return { ready: false, detail: "Codex isn't installed" };
      try {
        return await reviewer.availability();
      } catch (error) {
        this.warn(`Codex account check failed: ${sanitize(error)}`);
        return { ready: false, detail: "Couldn't read your Codex account" };
      }
    }
    let apiKey: string | null;
    try {
      apiKey = await this.apiKey(id, secrets);
    } catch (error) {
      this.warn(`OpenCode credentials are unreadable: ${sanitize(error)}`);
      return { ready: false, detail: "OpenCode login is unreadable" };
    }
    if (!apiKey) {
      return definition.credential === "workbench-secret"
        ? { ready: false, detail: "Needs a key" }
        : { ready: false, detail: "Run opencode auth login" };
    }
    try {
      return await this.catalogue.resolve(definition.model, apiKey)
        ? { ready: true, detail: null }
        : { ready: false, detail: "Not offered right now" };
    } catch (error) {
      this.warn(`${definition.label} model list failed: ${sanitize(error)}`);
      return { ready: false, detail: "Couldn't reach OpenCode Zen" };
    }
  }

  /** The credential a System One reviewer sends; Zen's free tier falls back to its anonymous key. */
  private async apiKey(id: ApprovalReviewerId, secrets: ReadonlyMap<ApprovalReviewerId, string>) {
    switch (APPROVAL_REVIEWERS[id].credential) {
      case "workbench-secret": return secrets.get(id) ?? null;
      case "opencode-auth": return await this.options.readOpenCodeApiKey();
      case "opencode-public": return await this.options.readOpenCodeApiKey() ?? ZEN_ANONYMOUS_KEY;
      case "codex-login": return null;
    }
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
    const apiKey = await this.apiKey(id, await this.readSecrets());
    if (!apiKey) throw new Error(`${definition.label} has no usable credential.`);
    const model = await this.catalogue.resolve(definition.model, apiKey);
    if (!model) throw new Error(`${definition.label} is not offered right now.`);
    return await reviewWithSystemOne({ label: definition.label, url: definition.url, model, apiKey, state }, signal, this.options.fetch);
  }

  private warn(message: string) {
    (this.options.warn ?? (text => console.warn(`[approval-review] ${text}`)))(message);
  }

  private async readSelected(): Promise<ApprovalReviewerId | null> {
    const [row] = await this.options.database.query(selectRows(approvalReviewSelection, { where: { id: "global" } }));
    // Ids removed from the registry read as no selection.
    return ApprovalReviewerIdSchema.safeParse(row?.reviewer_id).data ?? null;
  }

  /** Decrypted secrets by reviewer; rows sealed on another device or user read as unset. */
  private async readSecrets() {
    const rows = await this.options.database.query(selectRows(approvalReviewSecrets, {}));
    const secret = rows.length ? await this.secret() : null;
    return new Map(rows.flatMap(row => {
      const id = ApprovalReviewerIdSchema.safeParse(row.reviewer_id).data;
      const value = id ? openProjectStoreValue(secret!, SECRET_SCOPE, id, row) : null;
      return id && value !== null ? [[id, value] as const] : [];
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
