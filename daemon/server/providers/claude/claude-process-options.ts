/*
 * Exports:
 * - claudeExecutable: resolve the installed Claude Code executable.
 * - claudeEnvironment: default eager tool-input streaming, disable account connectors, apply an optional config view and selected context window, and isolate fake-model traffic.
 */
import { existsSync } from "node:fs";
import path from "node:path";

export function claudeExecutable() {
  const candidates = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const explicit = process.env.CLAUDE_CODE_EXECUTABLE;
  if (explicit && path.isAbsolute(explicit) && existsSync(explicit)) return explicit;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const candidate of candidates) {
      const resolved = path.join(directory, candidate);
      if (existsSync(resolved)) return resolved;
    }
  }
  throw new Error("Claude Code executable was not found on PATH.");
}

export function claudeEnvironment(
  endpoint?: string, view?: NodeJS.ProcessEnv, contextWindowTokens: number | null = null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Streams commentary-tool text as it is generated; an explicit user setting still wins.
    CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "1",
    ...process.env,
    ...view,
    // Claude Code's window cap; it outranks the model's native window and drives auto-compaction.
    ...(contextWindowTokens !== null ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindowTokens) } : {}),
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    // Workbench owns tool exposure; claude.ai account connectors would otherwise auto-load.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };
  if (!endpoint) return env;
  for (const key of [
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
    "ANTHROPIC_VERTEX_PROJECT_ID", "AWS_PROFILE", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS",
  ]) delete env[key];
  return {
    ...env,
    ANTHROPIC_BASE_URL: endpoint,
    ANTHROPIC_AUTH_TOKEN: "workbench-fake",
    ANTHROPIC_API_KEY: "workbench-fake",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost",
  };
}
