/*
 * Exports:
 * - CodexGlobalGuidanceSnapshot: resolved Codex global guidance content. Keywords: codex, AGENTS, guidance, dedupe.
 * - readCodexGlobalGuidance: read Codex home guidance using Codex global precedence. Keywords: CODEX_HOME, AGENTS.override.md, AGENTS.md.
 * - containsExactGuidanceText: test whether a guidance file already contains a generated Workbench section. Keywords: exact match, dedupe.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CodexGlobalGuidanceSnapshot {
  readonly content: string;
  readonly path: string | null;
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

function resolveCodexHome(env: NodeJS.ProcessEnv) {
  const configuredHome = env.CODEX_HOME?.trim();
  return path.resolve(configuredHome || path.join(os.homedir(), ".codex"));
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
