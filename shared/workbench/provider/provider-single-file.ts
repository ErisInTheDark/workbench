/*
 * Exports:
 * - SingleFileInput: latest recognition context and final-input marker.
 * - SingleFileEvent: committed document and terminal outcomes.
 * - SingleFileStart: private document, resolved instructions and model settings.
 * - WorkbenchProviderSingleFile: isolated native editing capability.
 */
import type { WorkbenchComposerSettings } from "../../types";

export interface SingleFileInput {
  transcript: string;
  final: boolean;
}
export type SingleFileEvent =
  | { type: "document"; sessionId: string; revision: number; text: string }
  | { type: "finished" | "cancelled"; sessionId: string }
  | { type: "error"; sessionId: string; message: string };
export interface SingleFileStart {
  sessionId: string;
  text: string;
  instructions: string;
  settings: Pick<WorkbenchComposerSettings, "harness" | "model">;
  onEvent: (event: SingleFileEvent) => void;
}
export interface WorkbenchProviderSingleFile {
  prepare(): Promise<void>;
  start(input: SingleFileStart): Promise<void>;
  input(sessionId: string, input: SingleFileInput): Promise<void>;
  finish(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}
