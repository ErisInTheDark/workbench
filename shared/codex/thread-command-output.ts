/*
 * Exports:
 * - MAX_THREAD_COMMAND_OUTPUT_CHARS: retained WB output limit.
 * - compactCommandOutput/appendCommandOutputDelta: WB output compaction and append.
 * - compactCommandExecutionItemOutput/compactCommandOutputPayload: WB item/payload compaction.
 */
export {
  MAX_THREAD_COMMAND_OUTPUT_CHARS, compactCommandOutput, appendCommandOutputDelta,
  compactCommandExecutionItemOutput, compactCommandOutputPayload,
} from "../workbench/thread/thread-command-output.ts";
