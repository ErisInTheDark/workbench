/*
 * Exports:
 * - WorkbenchBrowsePersistentSessionRecord: persisted opt-in Browse profile metadata. Keywords: browse, profile, persistent, session.
 * - default WorkbenchBrowseProfileStore: filesystem-backed owner for persistent local Browse browser profiles. Keywords: browse, profile, userDataDir, cookies.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeRelativePath, projectRoot, safeResolveProjectPath } from "../../project";

export interface WorkbenchBrowsePersistentSessionRecord {
  createdAt: string;
  lastUsedAt: string;
  name: string;
  profilePath: string;
}

interface WorkbenchBrowseProfileStoreState {
  sessions: WorkbenchBrowsePersistentSessionRecord[];
}

const PERSISTENT_SESSIONS_PATH = path.join(projectRoot, ".workbench", "runtime", "browse-persistent-sessions.json");
const PROFILE_ROOT_PATH = path.join(projectRoot, ".workbench", "runtime", "browse-profiles");
const SESSION_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/u;
const PROFILE_DELETE_MAX_RETRIES = 20;
const PROFILE_DELETE_RETRY_DELAY_MS = 250;

export default class WorkbenchBrowseProfileStore {
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
    await this.writeState({
      sessions: state.sessions.filter((session) => session.name !== sessionName),
    });
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

    const sessions = existing
      ? state.sessions.map((session) => session.name === sessionName ? nextRecord : session)
      : [...state.sessions, nextRecord];
    await this.writeState({ sessions });
    return profilePath;
  }

  private createProfilePath(sessionName: string) {
    return safeResolveProjectPath(PROFILE_ROOT_PATH, sessionName);
  }

  private async readState(): Promise<WorkbenchBrowseProfileStoreState> {
    try {
      const rawState = await fs.readFile(PERSISTENT_SESSIONS_PATH, "utf8");
      const parsedState = JSON.parse(rawState) as Partial<WorkbenchBrowseProfileStoreState>;
      if (!Array.isArray(parsedState.sessions)) {
        return { sessions: [] };
      }

      return {
        sessions: parsedState.sessions
          .filter(isPersistentSessionRecord)
          .map((session) => ({
            createdAt: session.createdAt,
            lastUsedAt: session.lastUsedAt,
            name: session.name,
            profilePath: normalizeProfilePath(session.profilePath, session.name),
          })),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sessions: [] };
      }
      throw error;
    }
  }

  private async writeState(state: WorkbenchBrowseProfileStoreState) {
    await fs.mkdir(path.dirname(PERSISTENT_SESSIONS_PATH), { recursive: true });
    await fs.writeFile(`${PERSISTENT_SESSIONS_PATH}.tmp`, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(`${PERSISTENT_SESSIONS_PATH}.tmp`, PERSISTENT_SESSIONS_PATH);
  }
}

function assertValidSessionName(sessionName: string) {
  if (!SESSION_NAME_PATTERN.test(sessionName)) {
    throw new Error("Browse session name is invalid.");
  }
}

function normalizeProfilePath(profilePath: string, sessionName: string) {
  const normalizedPath = normalizeRelativePath(path.resolve(profilePath));
  if (normalizedPath === normalizeRelativePath(path.resolve(PROFILE_ROOT_PATH)) || normalizedPath.startsWith(`${normalizeRelativePath(path.resolve(PROFILE_ROOT_PATH))}/`)) {
    return path.resolve(profilePath);
  }
  return safeResolveProjectPath(PROFILE_ROOT_PATH, sessionName);
}

function isPersistentSessionRecord(value: Partial<WorkbenchBrowsePersistentSessionRecord> | null | undefined) {
  return typeof value?.name === "string"
    && SESSION_NAME_PATTERN.test(value.name)
    && typeof value.createdAt === "string"
    && typeof value.lastUsedAt === "string"
    && typeof value.profilePath === "string";
}
