/*
 * Exports:
 * - QUICKJS_STACK_BYTES: the sandbox stack limit every skill runtime sets.
 * - guardQuickJSHost: run one synchronous sandbox entry, reporting a host crash instead of throwing it.
 * - describeQuickJSError: a sandboxed error handle as one readable line, `Name: message` when it carries both.
 * - isQuickJSRunaway: whether a sandboxed failure means the code ran away (deadline, memory, stack) rather than threw.
 */
import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";

/** Below the host's own stack, so deep recursion stops inside the sandbox instead of overflowing the host first. */
export const QUICKJS_STACK_BYTES = 256 * 1024;

/**
 * A throw out of QuickJS means the host itself failed mid-entry (its stack ran out). That runtime is unusable and
 * disposing it aborts the module, so callers drop it without disposing.
 */
export function guardQuickJSHost<T>(run: () => T): { value: T } | { crashed: string } {
  try {
    return { value: run() };
  } catch (error) {
    return { crashed: error instanceof Error ? error.message : String(error) };
  }
}

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
