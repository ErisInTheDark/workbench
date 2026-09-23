/*
 * Exports:
 * - default WorkbenchPresentationController: own app presentation admission, revision publication and disposal.
 */
import {
  PresentationMutationSchema, type PresentationMutation,
} from "workbench-shared/state/workbench-presentation-state";
import WorkbenchPresentationRepository from "./WorkbenchPresentationRepository.ts";

export default class WorkbenchPresentationController {
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(private readonly repository: WorkbenchPresentationRepository) {}

  read() {
    this.assertOpen();
    return this.repository.read();
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

  subscribe(listener: () => void) {
    this.assertOpen();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close() {
    this.closed = true;
    this.listeners.clear();
  }

  private assertOpen() {
    if (this.closed) throw new Error("Presentation state is closed.");
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
}
