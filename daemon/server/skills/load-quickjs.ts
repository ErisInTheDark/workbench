/*
 * Exports:
 * - default loadQuickJS: the daemon's one QuickJS module for testing skill MCP matchers as the client runs them; a failed
 *   load is retried by the next caller.
 */
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";

let loading: Promise<QuickJSWASMModule> | null = null;

export default function loadQuickJS() {
  loading ??= newQuickJSWASMModuleFromVariant(variant).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}
