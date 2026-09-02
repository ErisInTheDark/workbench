/*
 * Exports:
 * - WorkbenchFrontendGeneration: JavaScript and stylesheet identities for one browser build snapshot.
 * - WORKBENCH_STYLESHEET_GENERATION_PROPERTY: CSS custom property carrying the loaded stylesheet identity.
 * - default frontendJavaScriptGeneration: fallback token replaced by the frontend compiler in browser bundles.
 */
export interface WorkbenchFrontendGeneration {
  javascript: string;
  stylesheet: string;
}

export const WORKBENCH_STYLESHEET_GENERATION_PROPERTY = "--workbench-frontend-stylesheet-generation";

const frontendJavaScriptGeneration = "unbundled";

export default frontendJavaScriptGeneration;
