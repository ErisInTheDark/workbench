/*
 * Exports: types for ./browse-driver-extensions.mjs, which patches untyped upstream Browse modules at runtime.
 * - extractSnapshotSubtree/formatRuntimeException/patchBrowseDriverCommandSchema/patchBrowseDriverExtensions.
 */
export function extractSnapshotSubtree(tree: unknown, ref: string): string;
export function formatRuntimeException(exceptionDetails: unknown): string;
export function patchBrowseDriverCommandSchema(typesModule: object): void;
export function patchBrowseDriverExtensions(sessionManagerModule: object): void;
