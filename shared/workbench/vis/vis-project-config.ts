/*
 * Exports:
 * - VisProjectCommandSchema/VisProjectCommand: one project command a vis render runs; its stdout is the result.
 * - VisProjectConfigSectionSchema: the `vis` section of `.wb.json`.
 * - VisBuildOutputSchema/VisBuildOutput: what a `vis.build` command prints: the document and the files it read.
 * - expandVisProjectCommand: substitute `{file}`, `{root}` and `{input}` into a command and its input.
 */
import { z } from "zod";
import { VIS_MAX_DOCUMENT_LENGTH } from "./vis-contract";

export const VisProjectCommandSchema = z.object({
  command: z.array(z.string().min(1).max(4_000)).min(1).max(64)
    .describe("Argument vector run from the project root, inside the calling thread's sandbox. Its stdout is the result. {file}, {root} and {input} are substituted."),
  input: z.string().max(16_000).optional()
    .describe("Written to a temporary file named by {input}, for tools that read an entry file rather than arguments."),
}).strict();
export type VisProjectCommand = z.infer<typeof VisProjectCommandSchema>;

export const VisProjectConfigSectionSchema = z.object({
  css: VisProjectCommandSchema.optional()
    .describe("Compiles CSS for .html and .svg vis files containing <link rel=\"workbench-css\">."),
  build: VisProjectCommandSchema.optional()
    .describe("Builds .tsx and .jsx vis files; prints JSON { document, inputs }."),
}).strict().describe("Live visual drafts agents show with wb vis start.");

export const VisBuildOutputSchema = z.object({
  document: z.string().max(VIS_MAX_DOCUMENT_LENGTH),
  /** Project files the build read; any change to one re-renders. */
  inputs: z.array(z.string().min(1).max(4_000)).max(5_000),
}).strict();
export type VisBuildOutput = z.infer<typeof VisBuildOutputSchema>;

/** Forward slashes keep substituted paths valid inside CSS and JS strings on every platform. */
export function expandVisProjectCommand(command: VisProjectCommand, paths: { file: string; root: string; input: string }) {
  const slashed = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, value.replaceAll("\\", "/")]));
  const expand = (text: string) => text.replace(/\{(file|root|input)\}/gu, (_, key: string) => slashed[key]!);
  return { command: command.command.map(expand), input: command.input === undefined ? null : expand(command.input) };
}
