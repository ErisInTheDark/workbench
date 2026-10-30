/*
 * Exports: the `workbench/kit/thread` module that kit-context vis files import; separate from `workbench/kit` so only
 * pages previewing transcripts carry the transcript renderer.
 * - ThreadPreview: a real Workbench transcript from shorthand items, with skill matchers and components.
 */
export { default as ThreadPreview } from "./ThreadPreview";
