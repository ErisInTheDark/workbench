/*
 * Exports:
 * - WorkbenchToolRevisionState: shared tool catalogue revision carried across graph replacement.
 * - default WorkbenchToolRevisionController: invalidate provider tool preparation when the shared catalogue changes.
 */
import { randomUUID } from "node:crypto";

export interface WorkbenchToolRevisionState {
  counter: number;
  epoch: string;
}

export default class WorkbenchToolRevisionController {
  private readonly epoch: string;
  private counter: number;

  constructor(state?: WorkbenchToolRevisionState) {
    this.epoch = state?.epoch ?? randomUUID();
    this.counter = state?.counter ?? 0;
  }

  get revision() {
    return `${this.epoch}:${this.counter}`;
  }

  bump() {
    this.counter++;
  }

  detachForReload(): WorkbenchToolRevisionState {
    return { epoch: this.epoch, counter: this.counter };
  }
}
