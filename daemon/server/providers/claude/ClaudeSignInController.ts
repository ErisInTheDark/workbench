/*
 * Exports:
 * - claudeSignInUrl: the authorize link `claude auth login` printed, from raw terminal output.
 * - ClaudeSignInOptions: pinned executable plus injectable environment, command runner and pseudo-terminal.
 * - default ClaudeSignInController: sign Claude Code in and out through its own `claude auth` commands, using the user's real config.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import type { ProviderAccountIntegration } from "workbench-shared/workbench/provider/provider-account-sign-in";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import spawnPseudoTerminal from "../../lib/pseudo-terminal";
import type { ProviderSignInAdapter, ProviderSignInFlow } from "../ProviderSignInSession";

const INTEGRATION_ID = "anthropic";
const METHODS = [
  { id: "claudeai", label: "Claude subscription", kind: "browser" },
  { id: "console", label: "Anthropic Console", kind: "browser" },
] as const;
const LINK_WAIT_MS = 30_000;
const OUTPUT_LIMIT = 8_000;

const AuthStatusSchema = z.object({
  loggedIn: z.boolean(),
  email: z.string().nullable().optional(),
  orgName: z.string().nullable().optional(),
}).passthrough();

// CSI and OSC sequences; ConPTY and Claude's renderer both emit them around plain text.
const TERMINAL_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][0-9A-Za-z]/gu;
// Trailing whitespace proves the link is complete; terminal output can arrive split mid-link.
const AUTHORIZE_URL = /https:\/\/[^\s"'<>]+\/oauth\/authorize\?[^\s"'<>]+(?=\s)/u;

function plain(output: string) {
  return output.replace(TERMINAL_SEQUENCE, "");
}

export function claudeSignInUrl(output: string) {
  return AUTHORIZE_URL.exec(plain(output))?.[0] ?? null;
}

function lastLine(output: string) {
  return plain(output).split(/\r?\n|\r/u).map(line => line.trim()).filter(Boolean).at(-1) ?? "";
}

/** Resolves stdout; a non-zero exit rejects with stdout attached, since status still reports JSON when signed out. */
type CommandRunner = (file: string, args: string[]) => Promise<string>;

const runCommand: CommandRunner = async (file, args) => (
  await promisify(execFile)(file, args, { windowsHide: true, env: process.env })
).stdout;

function failureOutput(error: unknown) {
  const stdout = (error as { stdout?: unknown } | null)?.stdout;
  return typeof stdout === "string" && stdout.trim() ? stdout : null;
}

export interface ClaudeSignInOptions {
  resolveExecutable: () => string;
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
  spawn?: typeof spawnPseudoTerminal;
}

export default class ClaudeSignInController implements ProviderSignInAdapter {
  private readonly run: CommandRunner;
  private readonly spawn: typeof spawnPseudoTerminal;

  constructor(private readonly options: ClaudeSignInOptions) {
    this.run = options.run ?? runCommand;
    this.spawn = options.spawn ?? spawnPseudoTerminal;
  }

  async read(): Promise<ProviderAccountIntegration[]> {
    const output = await this.run(this.options.resolveExecutable(), ["auth", "status", "--json"]).catch((error: unknown) => {
      const stdout = failureOutput(error);
      if (stdout === null) throw error;
      return stdout;
    });
    const status = conformToZodSchema(AuthStatusSchema, JSON.parse(output) as unknown, { loggedIn: false }).data;
    return [{
      id: INTEGRATION_ID, label: "Anthropic", primary: true, signedIn: status.loggedIn,
      accountLabel: status.loggedIn ? status.email ?? status.orgName ?? null : null,
      methods: METHODS.map(method => ({ ...method })),
    }];
  }

  /** Runs `claude auth login` in a terminal, since Claude only reads a pasted code from a TTY. */
  async begin(integrationId: string, methodId: string, signal: AbortSignal): Promise<ProviderSignInFlow> {
    if (integrationId !== INTEGRATION_ID || !METHODS.some(method => method.id === methodId)) throw new Error("Unknown Claude sign-in method.");
    const terminal = await this.spawn(this.options.resolveExecutable(), ["auth", "login", `--${methodId}`], {
      env: this.options.env ?? process.env, cwd: os.homedir(),
    });
    let output = "";
    let linkFound!: (url: string) => void;
    const link = new Promise<string>(resolve => { linkFound = resolve; });
    terminal.onOutput(text => {
      output = (output + text).slice(-OUTPUT_LIMIT);
      const url = claudeSignInUrl(output);
      if (url) linkFound(url);
    });
    const stop = () => terminal.kill();
    signal.addEventListener("abort", stop, { once: true });
    const settled = terminal.exited.then(code => {
      signal.removeEventListener("abort", stop);
      if (code !== 0) throw new Error(lastLine(output) || `Claude sign-in exited with status ${code}.`);
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const url = await Promise.race([
        link,
        settled.then(() => { throw new Error("Claude finished without showing a sign-in link."); }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Claude didn't show a sign-in link. Its output ended with: ${lastLine(output) || "nothing"}`)), LINK_WAIT_MS);
        }),
      ]);
      return {
        url, userCode: null, acceptsCode: true, expiresAt: null, settled,
        submitCode: async code => { terminal.write(`${code}\r`); },
        cancel: async () => { stop(); },
      };
    } catch (error) {
      stop();
      settled.catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async connectKey(): Promise<void> {
    throw new Error("Claude Code has no key sign-in here; set ANTHROPIC_API_KEY for the daemon instead.");
  }

  async signOut(integrationId: string) {
    if (integrationId !== INTEGRATION_ID) throw new Error("Unknown Claude account.");
    await this.run(this.options.resolveExecutable(), ["auth", "logout"]);
  }
}
