/*
 * Exports:
 * - default WorkbenchBrowseCommandQueue: FIFO controller for serializing Browse endpoint work. Keywords: browse, queue, lifecycle, concurrency.
 * - workbenchBrowseCommandQueue: shared Browse endpoint queue instance. Keywords: browse, queue, singleton.
 */

export default class WorkbenchBrowseCommandQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<TValue>(task: () => Promise<TValue>): Promise<TValue> {
    const nextTask = this.tail.catch(() => undefined).then(task);
    this.tail = nextTask.then(() => undefined, () => undefined);
    return await nextTask;
  }
}

export const workbenchBrowseCommandQueue = new WorkbenchBrowseCommandQueue();
