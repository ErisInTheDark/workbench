/*
 * Exports:
 * - default WorkbenchThreadDisplayController: own one project's durable display order.
 */

import type { WorkbenchThreadDisplayOrder } from "workbench-shared/workbench/thread/thread-display-order";

export default class WorkbenchThreadDisplayController {
  displayOrder: WorkbenchThreadDisplayOrder;

  constructor(displayOrder: WorkbenchThreadDisplayOrder = {}) {
    this.displayOrder = displayOrder;
  }

  clone() {
    return new WorkbenchThreadDisplayController(this.displayOrder);
  }
}
