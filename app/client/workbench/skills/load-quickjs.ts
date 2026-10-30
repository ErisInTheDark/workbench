/*
 * Exports:
 * - default loadQuickJS: the browser's one QuickJS module, fetched only when a thread first needs skill matchers; a failed
 *   load is retried by the next caller.
 */
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";

let loading: Promise<QuickJSWASMModule> | null = null;

async function load() {
  // Imported on demand: the bundler turns it into an asset path, but Node (tests importing this module) cannot load wasm as a module.
  const { default: wasmPath } = await import("@jitl/quickjs-wasmfile-release-sync/wasm");
  // The emitted asset sits beside the bundle, so it resolves against the bundle rather than the page route.
  const response = await fetch(new URL(wasmPath, import.meta.url));
  if (!response.ok) throw new Error(`QuickJS failed to load (${response.status}).`);
  const wasmBinary = await response.arrayBuffer();
  return await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmBinary }));
}

export default function loadQuickJS() {
  loading ??= load().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}
