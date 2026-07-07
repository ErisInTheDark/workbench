/*
 * Exports:
 * - WorkbenchBrowseSessionRecord: persisted Workbench-owned Browse session metadata. Keywords: browse, session, registry, thread.
 * - WorkbenchBrowseSessionRegistry: filesystem-backed registry of Workbench-owned Browse sessions for cleanup. Keywords: browse, session, registry, cleanup.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { projectRoot } from "../../project";
import type { WorkbenchBrowseSessionMode } from "../../types";

export interface WorkbenchBrowseSessionRecord {
  cwd: string | null;
  inactiveSince: string | null;
  lastActionAt: string;
  mode: WorkbenchBrowseSessionMode | null;
  name: string;
  projectId: string | null;
  projectRootPath: string | null;
  threadId: string | null;
}

interface WorkbenchBrowseSessionRegistryState {
  sessions: WorkbenchBrowseSessionRecord[];
}

const REGISTRY_PATH = path.join(projectRoot, ".workbench", "runtime", "browse-sessions.json");

export default class WorkbenchBrowseSessionRegistry {
  async forget(sessionName: string) {
    const state = await this.readState();
    const nextState = {
      sessions: state.sessions.filter((session) => session.name !== sessionName),
    };
    await this.writeState(nextState);
  }

  async list() {
    const state = await this.readState();
    return [...state.sessions].sort((left, right) => left.name.localeCompare(right.name));
  }

  async listByProjectId(projectId: string) {
    const state = await this.readState();
    return state.sessions
      .filter((session) => session.projectId === projectId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async listByThreadId(threadId: string) {
    const state = await this.readState();
    return state.sessions
      .filter((session) => session.threadId === threadId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async listOwnedThreadIds() {
    const state = await this.readState();
    return [...new Set(state.sessions.map((session) => session.threadId).filter((threadId): threadId is string => Boolean(threadId)))].sort();
  }

  async listStaleInactiveSessions({
    olderThanMs,
    now = Date.now(),
  }: {
    olderThanMs: number;
    now?: number;
  }) {
    const state = await this.readState();
    return state.sessions.filter((session) => {
      if (!session.threadId || !session.inactiveSince) {
        return false;
      }

      const inactiveSince = Date.parse(session.inactiveSince);
      return Number.isFinite(inactiveSince) && now - inactiveSince >= olderThanMs;
    });
  }

  async markThreadActive(threadId: string) {
    await this.updateThreadActivity(threadId, { active: true });
  }

  async markThreadInactive(threadId: string) {
    await this.updateThreadActivity(threadId, { active: false });
  }

  async remember({
    cwd,
    mode,
    name,
    projectId,
    projectRootPath,
    threadId,
  }: {
    cwd: string | null;
    mode: WorkbenchBrowseSessionMode | null;
    name: string;
    projectId: string | null;
    projectRootPath: string | null;
    threadId: string;
  }) {
    const state = await this.readState();
    const now = new Date().toISOString();
    const existing = state.sessions.find((session) => session.name === name);
    const nextRecord = {
      cwd: cwd ?? existing?.cwd ?? null,
      inactiveSince: null,
      lastActionAt: now,
      mode: mode ?? existing?.mode ?? null,
      name,
      projectId: projectId ?? existing?.projectId ?? null,
      projectRootPath: projectRootPath ?? existing?.projectRootPath ?? null,
      threadId,
    };
    const sessions = existing
      ? state.sessions.map((session) => session.name === name ? nextRecord : session)
      : [...state.sessions, nextRecord];
    await this.writeState({ sessions });
  }

  async touchSession(sessionName: string) {
    const state = await this.readState();
    const now = new Date().toISOString();
    let changed = false;
    const sessions = state.sessions.map((session) => {
      if (session.name !== sessionName) {
        return session;
      }

      changed = true;
      return {
        ...session,
        lastActionAt: now,
      };
    });

    if (changed) {
      await this.writeState({ sessions });
    }
  }

  private async updateThreadActivity(threadId: string, { active }: { active: boolean }) {
    const state = await this.readState();
    const now = new Date().toISOString();
    let changed = false;
    const sessions = state.sessions.map((session) => {
      if (session.threadId !== threadId) {
        return session;
      }

      const inactiveSince = active
        ? null
        : session.inactiveSince ?? now;
      if (inactiveSince === session.inactiveSince) {
        return session;
      }

      changed = true;
      return {
        ...session,
        inactiveSince,
      };
    });

    if (changed) {
      await this.writeState({ sessions });
    }
  }

  private async readState(): Promise<WorkbenchBrowseSessionRegistryState> {
    try {
      const rawState = await fs.readFile(REGISTRY_PATH, "utf8");
      const parsedState = JSON.parse(rawState) as WorkbenchBrowseSessionRegistryState;
      if (!Array.isArray(parsedState.sessions)) {
        return { sessions: [] };
      }

      return {
        sessions: parsedState.sessions
          .filter(isSessionRecord)
          .map((session) => ({
            cwd: session.cwd ?? null,
            inactiveSince: session.inactiveSince ?? null,
            lastActionAt: session.lastActionAt,
            mode: session.mode,
            name: session.name,
            projectId: session.projectId ?? null,
            projectRootPath: session.projectRootPath ?? null,
            threadId: session.threadId ?? null,
          })),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sessions: [] };
      }
      throw error;
    }
  }

  private async writeState(state: WorkbenchBrowseSessionRegistryState) {
    await fs.mkdir(path.dirname(REGISTRY_PATH), { recursive: true });
    await fs.writeFile(`${REGISTRY_PATH}.tmp`, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(`${REGISTRY_PATH}.tmp`, REGISTRY_PATH);
  }
}

function isSessionRecord(value: Partial<WorkbenchBrowseSessionRecord> | null | undefined) {
  return typeof value?.name === "string"
    && typeof value.lastActionAt === "string"
    && (value.mode === null || value.mode === "headed" || value.mode === "headless")
    && (value.cwd === undefined || value.cwd === null || typeof value.cwd === "string")
    && (value.projectId === undefined || value.projectId === null || typeof value.projectId === "string")
    && (value.projectRootPath === undefined || value.projectRootPath === null || typeof value.projectRootPath === "string")
    && (value.threadId === undefined || value.threadId === null || typeof value.threadId === "string")
    && (value.inactiveSince === undefined || value.inactiveSince === null || typeof value.inactiveSince === "string");
}
