/* Exports:
 * - ComposerProfileTarget: UI selection target, independent of thread admission contracts.
 */
import type { WorkbenchComposerProfileSlot } from "workbench-shared/types";
export type ComposerProfileTarget = WorkbenchComposerProfileSlot | { kind: "voice" };
