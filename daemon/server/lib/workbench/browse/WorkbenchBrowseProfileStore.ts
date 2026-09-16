/*
 * Exports:
 * - WorkbenchBrowsePersistentSessionRecord: persisted opt-in Browse profile metadata.
 * - default WorkbenchBrowseProfileStore: own SQLite profile catalogue and external Chromium directory lifecycle.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeRelativePath, projectRoot, safeResolveProjectPath } from "../../project";
import type WorkbenchDatabaseController from "../../../database/WorkbenchDatabaseController";
import { deleteRows, selectRows, upsertRow } from "workbench-shared/database/workbench-database-statements";
import { browseProfiles } from "../database/schema/browse-persistence-schema";

export interface WorkbenchBrowsePersistentSessionRecord {
  createdAt: string;
  lastUsedAt: string;
  name: string;
  profilePath: string;
}

interface WorkbenchBrowseProfileStoreState {
  sessions: WorkbenchBrowsePersistentSessionRecord[];
}

const PROFILE_ROOT_PATH = path.join(projectRoot, ".workbench", "runtime", "browse-profiles");
const SESSION_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/u;
const PROFILE_DELETE_MAX_RETRIES = 20;
const PROFILE_DELETE_RETRY_DELAY_MS = 250;

export default class WorkbenchBrowseProfileStore {
  constructor(
    private readonly database: Pick<WorkbenchDatabaseController, "query" | "executeTransaction">,
    private readonly profileRoot = PROFILE_ROOT_PATH,
  ) {}

  async forgetPersistentSession(sessionName: string) {
    assertValidSessionName(sessionName);
    const state = await this.readState();
    const existing = state.sessions.find((session) => session.name === sessionName) ?? null;
    if (!existing) {
      return null;
    }

    await fs.rm(existing.profilePath, {
      force: true,
      maxRetries: PROFILE_DELETE_MAX_RETRIES,
      recursive: true,
      retryDelay: PROFILE_DELETE_RETRY_DELAY_MS,
    });
    await this.database.executeTransaction([deleteRows(browseProfiles, { name: sessionName })]);
    return existing;
  }

  async resolveProfilePath({
    persistent,
    sessionName,
  }: {
    persistent: boolean;
    sessionName: string | null;
  }) {
    if (!sessionName) {
      if (persistent) {
        throw new Error("Persistent Browse sessions require a valid named session.");
      }
      return null;
    }

    assertValidSessionName(sessionName);
    const state = await this.readState();
    const existing = state.sessions.find((session) => session.name === sessionName) ?? null;
    if (!existing && !persistent) {
      return null;
    }

    const now = new Date().toISOString();
    const profilePath = existing?.profilePath ?? this.createProfilePath(sessionName);
    const nextRecord = {
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      name: sessionName,
      profilePath,
    };

    await this.database.executeTransaction([upsertRow(browseProfiles, {
      name: nextRecord.name, created_at: nextRecord.createdAt, last_used_at: nextRecord.lastUsedAt, profile_path: nextRecord.profilePath,
    }, { conflictColumns: ["name"], updateColumns: ["last_used_at"] })]);
    return profilePath;
  }

  private createProfilePath(sessionName: string) {
    return safeResolveProjectPath(this.profileRoot, sessionName);
  }

  private async readState(): Promise<WorkbenchBrowseProfileStoreState> {
    const rows = await this.database.query(selectRows(browseProfiles));
    return { sessions: rows.map(row => ({
      createdAt: row.created_at, lastUsedAt: row.last_used_at, name: row.name,
      profilePath: normalizeProfilePath(row.profile_path, row.name, this.profileRoot),
    })) };
  }
}

function assertValidSessionName(sessionName: string) {
  if (!SESSION_NAME_PATTERN.test(sessionName)) {
    throw new Error("Browse session name is invalid.");
  }
}

function normalizeProfilePath(profilePath: string, sessionName: string, profileRoot: string) {
  const normalizedPath = normalizeRelativePath(path.resolve(profilePath));
  if (normalizedPath.startsWith(`${normalizeRelativePath(path.resolve(profileRoot))}/`)) {
    return path.resolve(profilePath);
  }
  return safeResolveProjectPath(profileRoot, sessionName);
}
