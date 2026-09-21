/*
 * Exports:
 * - default service graph: persistence owns networking, which owns request admission.
 */
import { defineReloadableNodeGraph } from "../../../shared/reload/ReloadableNode.ts";
import type { ServiceProcessContext } from "./service-process-context.ts";
import type { ServiceRuntimeObjects } from "./service-runtime-objects.ts";
import ServiceDatabaseNode from "./ServiceDatabaseNode.ts";

export default defineReloadableNodeGraph<ServiceProcessContext, ServiceRuntimeObjects, never>([ServiceDatabaseNode]);
