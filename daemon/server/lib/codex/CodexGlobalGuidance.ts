/*
 * Exports:
 * - CodexGlobalGuidanceSnapshot: resolved Codex global guidance content.
 * - readCodexGlobalGuidance: read Codex home guidance using global precedence.
 * - containsExactGuidanceText: test whether guidance already contains a generated section.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCodexHome } from "./codex-home";

export interface CodexGlobalGuidanceSnapshot {
  readonly content: string;
  readonly path: string | null;
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

async function readNonEmptyFile(filePath: string) {
  try {
    const content = normalizeLineEndings(await fs.readFile(filePath, "utf8"));
    return content.trim() ? content : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function readCodexGlobalGuidance(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexGlobalGuidanceSnapshot> {
  const codexHome = resolveCodexHome(env);
  for (const fileName of ["AGENTS.override.md", "AGENTS.md"]) {
    const filePath = path.join(codexHome, fileName);
    const content = await readNonEmptyFile(filePath);
    if (content !== null) {
      return {
        content,
        path: filePath,
      };
    }
  }

  return {
    content: "",
    path: null,
  };
}

export function containsExactGuidanceText(
  guidance: CodexGlobalGuidanceSnapshot,
  text: string | null | undefined,
) {
  const normalizedText = normalizeLineEndings(text ?? "").trim();
  return Boolean(normalizedText) && guidance.content.includes(normalizedText);
}
