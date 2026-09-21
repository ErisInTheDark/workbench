/*
 * Exports:
 * - DaemonSleepPorts: physical demand, graph idleness, IPC and atomic shutdown boundary.
 * - default WorkbenchDaemonSleepController: check unattended work and negotiate safe sleep.
 */
import { randomUUID } from "node:crypto";
import type { DaemonHostMessage, DaemonSleepMessage } from "workbench-shared/http/workbench-daemon-lifecycle";

export interface DaemonSleepPorts {
  demanded(): boolean;
  connected(): boolean;
  idle(): boolean;
  send(message: DaemonSleepMessage): Promise<void>;
  commit(id: string): Promise<void>;
  warn(message: string): void;
  schedule?(check: () => void): () => void;
}

export default class WorkbenchDaemonSleepController {
  private cancel: (() => void) | null = null;
  private pending: string | null = null;
  private closed = false;
  private failed = false;
  private suspended = false;

  constructor(private readonly ports?: DaemonSleepPorts) {}

  refresh() {
    this.cancel?.();
    this.cancel = null;
    if (!this.ports || this.closed || this.failed || this.suspended || this.pending
      || this.ports.demanded() || this.ports.connected()) return;
    const schedule = this.ports.schedule ?? (check => {
      const timer = setTimeout(check, 1_000);
      return () => clearTimeout(timer);
    });
    this.cancel = schedule(() => {
      this.cancel = null;
      try {
        if (this.closed || this.ports!.demanded() || this.ports!.connected()) return;
        if (!this.ports!.idle()) { this.refresh(); return; }
        const id = randomUUID();
        this.pending = id;
        void this.ports!.send({ type: "workbench-daemon-sleep-request", id }).catch(error => this.fail(error));
      } catch (error) { this.fail(error); }
    });
  }

  receive(message: Extract<DaemonHostMessage, { type: "workbench-daemon-sleep-commit" }>) {
    if (!this.ports) return;
    try {
      const accepted = message.allowed && !this.closed && !this.failed && !this.suspended && this.pending === message.id
        && !this.ports.demanded() && !this.ports.connected() && this.ports.idle();
      if (this.pending === message.id) this.pending = null;
      if (accepted) {
        this.closed = true;
        this.cancel?.();
        this.cancel = null;
        // commit fences physical admission synchronously before its first await.
        void this.ports.commit(message.id).catch(error => this.fail(error));
      } else {
        void this.ports.send({ type: "workbench-daemon-sleep-result", id: message.id, accepted: false })
          .catch(error => this.fail(error));
        this.refresh();
      }
    } catch (error) { this.fail(error); }
  }

  async dispose() {
    this.closed = true;
    await this.suspend();
  }

  async suspend() {
    this.suspended = true;
    this.cancel?.();
    this.cancel = null;
    const id = this.pending;
    this.pending = null;
    if (id && this.ports) await this.ports.send({ type: "workbench-daemon-sleep-result", id, accepted: false });
  }

  resume() { this.suspended = false; this.refresh(); }

  private fail(error: unknown) {
    this.failed = true;
    this.cancel?.();
    this.cancel = null;
    const id = this.pending;
    this.pending = null;
    if (id && this.ports) {
      void this.ports.send({ type: "workbench-daemon-sleep-result", id, accepted: false })
        .catch(() => this.ports?.warn("Could not release the host's pending sleep request: IPC is unavailable."));
    }
    this.ports?.warn(`Automatic sleep disabled: ${error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`);
  }
}
