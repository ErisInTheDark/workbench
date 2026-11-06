/*
 * No exports. Opt-in live proof, run by `pnpm test:claude-account`: with the real login and real startup traffic, the pinned
 * Claude keeps the account email out of prompts on a config view, and the view costs no models or usage.
 * Prompts reach a local stand-in, so no model turn runs. Failures must never print the address or a request body.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";
import { captureProviderRuntimePins, resolveProviderRuntime } from "../provider-runtimes";
import { claudeAccountLimits } from "./ClaudeConfigurationController";
import ClaudeConfigView from "./ClaudeConfigView";
import { claudeEnvironment } from "./claude-process-options";
import { spawnTrackedClaude } from "./ClaudeSessionHost";

const BOOTSTRAP_DEADLINE_MS = 30_000;
const BOOTSTRAP_SETTLED = /\[Bootstrap\] (?:Cache updated|Cache unchanged)/u;
const BOOTSTRAP_FAILED = /\[Bootstrap\] (?:Skipped|Fetch failed|fetchBootstrapData failed)/u;
const REGAINED_WARNING = "regained the account email";

async function realAccount() {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json");
  const account = JSON.parse(await fs.readFile(file, "utf8")).oauthAccount as
    { accountUuid?: unknown; emailAddress?: unknown } | undefined;
  const { accountUuid, emailAddress } = account ?? {};
  assert.ok(typeof accountUuid === "string" && typeof emailAddress === "string" && emailAddress,
    "This scenario needs Claude signed in on this machine.");
  return { accountUuid, emailAddress };
}

/** Passing with bootstrap unfinished would prove nothing, so an unknown or failed bootstrap fails the scenario. */
async function bootstrapSettled(debugFile: string) {
  const deadline = Date.now() + BOOTSTRAP_DEADLINE_MS;
  while (Date.now() < deadline) {
    const log = await fs.readFile(debugFile, "utf8").catch(() => "");
    if (BOOTSTRAP_FAILED.test(log)) throw new Error("Claude's bootstrap failed or was skipped; this scenario needs real network and login.");
    if (BOOTSTRAP_SETTLED.test(log)) return;
    await delay(100);
  }
  throw new Error("Claude's debug log never reported bootstrap finishing; recheck the bootstrap markers against this Claude version.");
}

function launchOptions(workspace: string, env: NodeJS.ProcessEnv, debugFile: string, onExit: (exit: Promise<void>) => void): Options {
  return {
    cwd: workspace,
    debugFile,
    env,
    pathToClaudeCodeExecutable: resolveProviderRuntime(resolveWorkbenchDataRoot(), "claude", captureProviderRuntimePins().claude()).executable,
    persistSession: false,
    settingSources: [],
    spawnClaudeCodeProcess: options => spawnTrackedClaude(options, onExit),
    tools: [],
  };
}

function answerWithText(response: http.ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: {
    id: "msg_stand_in", type: "message", role: "assistant", model: "stand-in", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  } });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", {});
  response.end();
}

async function withModelStandIn<T>(use: (endpoint: string, prompts: string[]) => Promise<T>) {
  const prompts: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (request.url?.split("?")[0] !== "/v1/messages") {
        response.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      prompts.push(body);
      answerWithText(response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    return await use(`http://127.0.0.1:${port}`, prompts);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

/** Run one prompt after bootstrap lands, the order that exposes a restored email; returns the requests Claude sent. */
async function promptsAfterBootstrap(workspace: string, name: string, serverAccountUuid: string | null) {
  const view = await ClaudeConfigView.create(path.join(workspace, "views"));
  try {
    if (serverAccountUuid) {
      const file = path.join(view.env.CLAUDE_CONFIG_DIR!, ".claude.json");
      const config = JSON.parse(await fs.readFile(file, "utf8"));
      config.oauthAccount.accountUuid = serverAccountUuid;
      await fs.writeFile(file, JSON.stringify(config));
    }
    return await withModelStandIn(async (endpoint, prompts) => {
      const debugFile = path.join(workspace, `${name}.log`);
      const send = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      async function* prompt(): AsyncGenerator<SDKUserMessage> {
        await send.promise;
        yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: "hello" } };
        await finish.promise;
      }
      let exit: Promise<void> | null = null;
      const sdkQuery = query({
        prompt: prompt(),
        options: {
          ...launchOptions(workspace, { ...claudeEnvironment(undefined, view.env), ANTHROPIC_BASE_URL: endpoint }, debugFile, value => { exit = value; }),
          model: "sonnet",
        },
      });
      try {
        await bootstrapSettled(debugFile);
        send.resolve();
        for await (const message of sdkQuery) {
          if (message.type !== "result") continue;
          assert.equal(message.subtype, "success", "The stand-in turn must finish");
          break;
        }
      } finally {
        finish.resolve();
        sdkQuery.close();
        await exit;
      }
      assert.ok(prompts.length > 0, "Claude must send its prompt to the stand-in");
      return prompts;
    });
  } finally {
    await view.dispose();
  }
}

async function catalogue(workspace: string, name: string, view: ClaudeConfigView | null) {
  const lifetime = new AbortController();
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>(resolve => lifetime.signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  const debugFile = path.join(workspace, `${name}.log`);
  let exit: Promise<void> | null = null;
  const sdkQuery = query({
    prompt: idle(),
    options: {
      ...launchOptions(workspace, claudeEnvironment(undefined, view?.env), debugFile, value => { exit = value; }),
      abortController: lifetime,
    },
  });
  try {
    await bootstrapSettled(debugFile);
    const models = await sdkQuery.supportedModels();
    const { rateLimits } = claudeAccountLimits(
      await sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
    return {
      models: models.map(model => model.value).sort(),
      fastModels: models.filter(model => model.supportsFastMode).map(model => model.value).sort(),
      plan: rateLimits.planType,
      // Percentages move between reads; which windows exist does not.
      windows: { primary: Boolean(rateLimits.primary), secondary: Boolean(rateLimits.secondary), tertiary: Boolean(rateLimits.tertiary) },
    };
  } finally {
    lifetime.abort();
    sdkQuery.close();
    await exit;
  }
}

test("real startup traffic cannot put the account email in a prompt on a config view", async (t) => {
  const { accountUuid, emailAddress } = await realAccount();
  const warn = t.mock.method(console, "warn", () => undefined);
  const regainedWarnings = () => warn.mock.calls.filter(call => String(call.arguments[0]).includes(REGAINED_WARNING)).length;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wb-claude-account-"));
  try {
    const leaked = await promptsAfterBootstrap(workspace, "control", accountUuid);
    assert.ok(leaked.some(body => body.includes(emailAddress)),
      "Control must leak: with the server's exact account id, Claude no longer restores the email, so this scenario proves nothing. Recheck how Claude sources it.");
    const controlWarnings = regainedWarnings();

    const prompts = await promptsAfterBootstrap(workspace, "protected", null);
    assert.ok(!prompts.some(body => body.includes(emailAddress)), "Claude restored the account email in a prompt despite the config view.");
    assert.equal(controlWarnings, 1, "A view whose email came back must warn on disposal");
    assert.equal(regainedWarnings(), 1, "A protected view must keep the email out of its config");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a config view costs no models, fast modes, plan or usage windows", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wb-claude-account-"));
  try {
    const viewless = await catalogue(workspace, "viewless", null);
    const view = await ClaudeConfigView.create(path.join(workspace, "views"));
    try {
      assert.deepEqual(await catalogue(workspace, "view", view), viewless);
    } finally {
      await view.dispose();
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
});
