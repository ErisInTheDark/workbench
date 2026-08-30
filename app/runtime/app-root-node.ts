/*
 * Default export:
 * - app root graph: declare the direct process root for reloadable app ownership. Keywords: app, reload, graph.
 */
import { defineReloadableNodeGraph } from "workbench-shared/reload/ReloadableNode";

import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import AppRuntimeNode from "./AppRuntimeNode.ts";

export default defineReloadableNodeGraph<AppProcessContext, AppRuntimeObjects, never>([AppRuntimeNode]);
