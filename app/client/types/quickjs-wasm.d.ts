/** The bundler's file loader turns the QuickJS wasm into its emitted asset path, relative to the app bundle. */
declare module "@jitl/quickjs-wasmfile-release-sync/wasm" {
  const path: string;
  export default path;
}
