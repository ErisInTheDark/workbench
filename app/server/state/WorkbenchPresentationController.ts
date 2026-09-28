/*
 * Exports:
 * - default WorkbenchPresentationController: own app presentation admission, revision publication and disposal.
 */
import {
  PresentationMutationSchema, type PresentationMutation,
} from "workbench-shared/state/workbench-presentation-state";
import type { PresentationImportSource } from "workbench-shared/state/workbench-presentation-import";
import type { DaemonId } from "workbench-shared/workbench/identity";
import WorkbenchPresentationRepository from "./WorkbenchPresentationRepository.ts";

export default class WorkbenchPresentationController {
  private readonly listeners = new Set<(revision: number) => void>();
  private closed = false;

  constructor(private readonly repository: WorkbenchPresentationRepository) {}

  read() {
    this.assertOpen();
    return this.repository.read();
  }

  revision() {
    this.assertOpen();
    return this.repository.readRevision();
  }

  readAcceptedLaunch(draftId: string) {
    this.assertOpen();
    return this.repository.readAcceptedLaunch(draftId);
  }

  readImportReceipts(daemonId: DaemonId, sources: readonly PresentationImportSource[]) {
    this.assertOpen();
    return { present: this.repository.readImportReceipts(daemonId, sources) };
  }

  mutate(value: PresentationMutation) {
    this.assertOpen();
    const result = this.repository.mutate(PresentationMutationSchema.parse(value));
    this.publish();
    return result;
  }

  putAttachmentChunk(draftId: string, id: string, index: number, bytes: Buffer) {
    this.assertOpen();
    this.repository.putAttachmentChunk(draftId, id, index, bytes);
  }

  completeAttachment(draftId: string, id: string, count: number, mediaType: string, hash: string) {
    this.assertOpen();
    const result = this.repository.completeAttachment(draftId, id, count, mediaType, hash);
    this.publish();
    return result;
  }

  readAttachment(draftId: string, id: string) {
    this.assertOpen();
    return this.repository.readAttachment(draftId, id);
  }

  subscribe(listener: (revision: number) => void) {
    this.assertOpen();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close() {
    this.closed = true;
    this.listeners.clear();
  }

  mutateImportBatch(values: readonly PresentationMutation[]) {
    this.assertOpen();
    const result = this.repository.mutateImportBatch(values);
    this.publish();
    return result;
  }

  private assertOpen() {
    if (this.closed) throw new Error("Presentation state is closed.");
  }

  private publish() {
    const revision = this.repository.readRevision();
    for (const listener of this.listeners) listener(revision);
  }
}
