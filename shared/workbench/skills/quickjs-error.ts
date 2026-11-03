/*
 * Exports:
 * - describeQuickJSError: a sandboxed error handle as one readable line, `Name: message` when it carries both.
 * - isQuickJSRunaway: whether a sandboxed failure means the code ran away (deadline, memory, stack) rather than threw.
 */
import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";

export function describeQuickJSError(context: QuickJSContext, handle: QuickJSHandle) {
  const value: unknown = context.dump(handle);
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    const name = "name" in value && typeof value.name === "string" ? `${value.name}: ` : "";
    return `${name}${value.message}`;
  }
  return String(value);
}

export function isQuickJSRunaway(message: string, deadline: number) {
  return Date.now() >= deadline || /out of memory|stack overflow|interrupted/iu.test(message);
}
