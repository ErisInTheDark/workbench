/*
 * Exports:
 * - readInstructionSource: synchronously load and normalize one instruction-root-relative Markdown source. Keywords: instructions, markdown, source.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { observeReloadInstructionSource } from "../reload-source-observer";

const instructionSourceRoot = path.join(process.cwd(), "lib", "workbench", "instructions");

export function readInstructionSource(relativePath: string) {
  const sourcePath = path.join(instructionSourceRoot, relativePath);
  const source = readFileSync(sourcePath, "utf8").replace(/\r\n?/gu, "\n").trim();
  observeReloadInstructionSource(sourcePath);
  return source;
}
