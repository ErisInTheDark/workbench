/*
 * Exports:
 * - default loadProcessViewControls: load and create full `wb view` process controls from the natively started view.
 *
 * Controls reach into app and host code that needs tsx and installed dependencies, so tsx loads lazily here. The root
 * package declares no module type, so tsx compiles that code as CommonJS; requiring it keeps its default export intact
 * where an ESM import would only see the CommonJS wrapper.
 */
import type { ProcessViewControls, WorkbenchProcessViewControlsOptions } from "./WorkbenchProcessViewControls.ts";

export default async function loadProcessViewControls(
  options: WorkbenchProcessViewControlsOptions,
): Promise<ProcessViewControls> {
  const { require: tsxRequire } = await import("tsx/cjs/api");
  const controls: typeof import("./WorkbenchProcessViewControls.ts") = tsxRequire("./WorkbenchProcessViewControls.ts", import.meta.url);
  return await controls.default(options);
}
