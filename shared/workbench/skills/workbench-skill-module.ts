/*
 * Exports:
 * - WORKBENCH_SKILL_MODULE_SOURCE: the `workbench-skill` module skill matcher files import their helpers from; served as
 *   a virtual module both to matcher bundles and to vis pages previewing them.
 */
export const WORKBENCH_SKILL_MODULE_SOURCE = `
  export function defineMcpMatcher(match) {
    if (typeof match !== "function") throw new Error("defineMcpMatcher expects a function (call => presentation | null).");
    return match;
  }
  export const code = value => ({ code: String(value) });
  export const primary = value => ({ primary: String(value) });
  export const path = value => ({ path: String(value) });
  export const thread = value => ({ thread: String(value) });
`;
