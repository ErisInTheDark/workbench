/*
 * Exports:
 * - readInstructionSource: synchronously load and normalize one instruction-root-relative Markdown source. Keywords: instructions, markdown, source.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const instructionSourceRoot = path.join(process.cwd(), "lib", "workbench", "instructions");

export function readInstructionSource(relativePath: string) {
  return readFileSync(path.join(instructionSourceRoot, relativePath), "utf8").replace(/\r\n?/gu, "\n").trim();
}
