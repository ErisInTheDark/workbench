/*
 * Exports:
 * - isTodoCall: a block that is one wb todo call, drawn as one todo card.
 * - foldTodoLeadIns: a completed listing folds into the todo add or removal right after it; the agent read the list to
 *   make that change, so the change is what the user needs to see.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import {
  getThreadCommandDisplay, getThreadCommandExecutionOutcome, getThreadMcpToolCallOutcome, getWorkbenchMcpCommandRoute,
  parseWorkbenchTodoCommand, type ThreadCommandExecutionOutcome, type WorkbenchTodoOperation,
} from "../../../workbench/thread/thread-command-matchers";
import { buildCardHistory } from "./thread-activity-runs";
import type { CommandItem, CommandSequenceItem, ThreadRenderableBlock } from "./thread-render-blocks";

interface TodoCall { action: WorkbenchTodoOperation["action"]; item: CommandSequenceItem; outcome: ThreadCommandExecutionOutcome }

function readTodoItem(item: ThreadItem): TodoCall | null {
  if (item.type === "mcpToolCall") {
    const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
    return route?.kind === "specialized" && route.operation.kind === "todo"
      ? { action: route.operation.operation.action, item, outcome: getThreadMcpToolCallOutcome(item) } : null;
  }
  if (item.type !== "commandExecution") return null;
  const { shell }: CommandItem = item;
  const display = getThreadCommandDisplay({ command: item.command, commandActions: item.commandActions, cwd: item.cwd, shell });
  const operation = parseWorkbenchTodoCommand(display.unwrappedCommand);
  return operation ? { action: operation.action, item, outcome: getThreadCommandExecutionOutcome(item.status, item.exitCode) } : null;
}

/** One todo call standing alone as a block. */
function readTodoCall(block: ThreadRenderableBlock): TodoCall | null {
  if (block.kind === "item") return readTodoItem(block.item);
  return block.kind === "commandSequence" && block.items.length === 1 ? readTodoItem(block.items[0]!) : null;
}

export function isTodoCall(block: ThreadRenderableBlock) {
  return readTodoCall(block) !== null;
}

/** A failed listing stays in view, and a listing nothing changes after is what the agent wanted to show. */
export function foldTodoLeadIns(blocks: readonly ThreadRenderableBlock[]): ThreadRenderableBlock[] {
  const folded: ThreadRenderableBlock[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const next = blocks[index + 1];
    const listing = readTodoCall(block);
    const change = next ? readTodoCall(next) : null;
    if (next && listing?.action === "list" && listing.outcome === "completed" && change && change.action !== "list") {
      folded.push(buildCardHistory([listing.item], next, 0));
      index += 1;
      continue;
    }
    folded.push(block);
  }
  return folded;
}
