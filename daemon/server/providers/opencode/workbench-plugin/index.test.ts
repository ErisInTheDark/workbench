/* No production exports. Tests protect native admission, preview visibility, turn-end guidance and companion lifecycle. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import type { Result } from "@opencode/plugin/promise/tool";
import { createOpenCodeWorkbenchPlugin, MANAGED_DISABLED_NATIVE_TOOLS, readOpenCodeGoQuota, resolveOpenCodeGoCredential } from "./index";
import { OPENCODE_COMMENTARY_TOOL_NAME } from "../opencode-workbench-rpc";
import {
  OPENCODE_COMMENTARY_FINISHING_HINT, OPENCODE_COMMENTARY_HINT, openCodeCommentaryResult,
} from "./open-code-commentary-tool";

async function* lifecycleEvents({ signal }: { signal: AbortSignal }) {
  if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
}

interface FixtureTool {
  name: string;
  execute(input: unknown, context: { sessionID: string; id: string; messageID: string }): Promise<{ content?: unknown }>;
}

async function fixture(options: {
  fail?: string; claim?: () => Response; cwd?: string; catalogue?: string[]; toolFails?: boolean;
} = {}) {
  const hooks = new Map<string, (input: never) => Promise<void>>();
  const registered: string[] = [];
  const disposed: string[] = [];
  const observations: { kind?: string; files?: { path: string }[] }[] = [];
  const checks: URLSearchParams[] = [];
  const tools = new Map<string, FixtureTool>();
  const synthetic: string[] = [];
  let closed = 0;
  const register = async (name: string, callback?: (input: never) => Promise<void>) => {
    if (name === options.fail) throw new Error("registration failed");
    registered.push(name);
    if (callback) hooks.set(name, callback);
    return { dispose: async () => { disposed.push(name); } };
  };
  const plugin = createOpenCodeWorkbenchPlugin({
    isManagedSession: async session => session === "managed",
    resolveDaemonOrigin: async () => "http://127.0.0.1:43001",
    connectTools: async () => ({
      listTools: async () => ({ tools: (options.catalogue ?? []).map(name => ({ name, inputSchema: { type: "object" as const } })) }),
      callTool: async () => options.toolFails
        ? { content: [{ type: "text" as const, text: "refused" }], isError: true }
        : { content: [] },
      close: async () => { closed++; },
    }),
    fetch: async (_url, init) => {
      checks.push(new URLSearchParams(String(init?.body)));
      return options.claim?.() ?? Response.json({ allowed: true });
    },
  });
  const setup = async () => plugin.setup({
    app: { version: "2.0.9" },
    event: { subscribe: lifecycleEvents },
    rpc: { register: async () => ({ ...await register("rpc"),
      events: { emit: async (_name: string, observation: typeof observations[number]) => { observations.push(observation); } } }) },
    session: {
      get: async () => ({ location: { directory: options.cwd ?? "C:/repo" } }),
      hook: register,
      synthetic: async ({ text }: { text: string }) => { synthetic.push(text); },
    },
    tool: {
      hook: register,
      transform: async (edit: (editor: { add(tool: FixtureTool): void }) => void) => {
        edit({ add: tool => { tools.set(tool.name, tool); } });
        return register("tools");
      },
    },
    permission: { hook: register },
  } as never);
  return { setup, hooks, registered, disposed, observations, checks, tools, synthetic, closed: () => closed };
}

test("companion hooks attach write evidence to the native result without replacing the native tool", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-companion-write-");
  const root = temporary.path;
  const owner = await fixture({ cwd: root });
  const cleanup = await owner.setup();
  try {
    const input = { tool: "write", sessionID: "managed", id: "write", input: { path: "new.ts", content: "native content" } };
    await owner.hooks.get("execute.before")!(input as never);
    await fs.writeFile(path.join(root, "new.ts"), "formatted content\n");
    const settled = { ...input, status: "completed", result: { output: { existed: false }, content: "native result" } as Result };
    await owner.hooks.get("execute.after")!(settled as never);
    assert.equal(settled.result.content, "native result");
    assert.equal(settled.result.metadata?.files[0]?.status, "added");
    assert.match(settled.result.metadata?.files[0]?.patch ?? "", /\+formatted content/);
  } finally {
    if (typeof cleanup === "function") await cleanup();
    await temporary.dispose();
  }
});

test("the shared edit permission guards writes, edits and every patch target without changing ordinary sessions", async () => {
  const owner = await fixture({ claim: () => Response.json({ allowed: false, reason: "Claim src/new.ts before editing." }) });
  const cleanup = await owner.setup();
  try {
    for (const resources of [["write.ts"], ["edit.ts"], ["old.ts", "src/new.ts", "deleted.ts"]]) {
      const input = { sessionID: "managed", action: "edit", resources, effect: "allow", message: "" };
      await owner.hooks.get("evaluate")!(input as never);
      assert.equal(input.effect, "deny");
      assert.match(input.message, /src\/new.ts/);
      assert.deepEqual(JSON.parse(owner.checks.at(-1)!.get("hookInput")!), { sessionID: "managed", resources });
    }
    const ordinary = { sessionID: "ordinary", action: "edit", resources: ["ordinary.ts"], effect: "ask" };
    await owner.hooks.get("evaluate")!(ordinary as never);
    assert.equal(ordinary.effect, "ask");
    assert.equal(owner.checks.length, 3);
    const read = { sessionID: "managed", action: "read", resources: ["read.ts"], effect: "allow" };
    await owner.hooks.get("evaluate")!(read as never);
    assert.equal(owner.checks.length, 3);
  } finally { if (typeof cleanup === "function") await cleanup(); }
});

test("claim success preserves native restrictions and invalid responses deny without leaking payloads", async t => {
  let malformed = false;
  const owner = await fixture({ claim: () => malformed ? Response.json({ private: "SECRET" }) : Response.json({ allowed: true }) });
  const cleanup = await owner.setup();
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  try {
    const input = { sessionID: "managed", action: "edit", resources: ["a.ts"], effect: "ask", message: "" };
    await owner.hooks.get("evaluate")!(input as never);
    assert.equal(input.effect, "ask");
    malformed = true;
    await owner.hooks.get("evaluate")!(input as never);
    assert.equal(input.effect, "deny");
    assert.ok(warnings.length);
    assert.doesNotMatch(input.message + warnings.join(""), /SECRET/);
  } finally { if (typeof cleanup === "function") await cleanup(); }
});

test("unavailable claim admission denies native mutation with a bounded agent-visible failure", async t => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  for (const claim of [
    () => new Response("PRIVATE upstream failure", { status: 503 }),
    () => { throw new Error("PRIVATE network failure"); },
  ]) {
    const owner = await fixture({ claim });
    const cleanup = await owner.setup();
    try {
      const input = { sessionID: "managed", action: "edit", resources: ["delete.ts"], effect: "allow", message: "" };
      await owner.hooks.get("evaluate")!(input as never);
      assert.equal(input.effect, "deny");
      assert.ok(input.message.length > 0 && input.message.length < 1000);
      assert.doesNotMatch(input.message + warnings.join(""), /PRIVATE/);
    } finally { if (typeof cleanup === "function") await cleanup(); }
  }
  assert.equal(warnings.length, 2);
});

for (const failure of ["rpc", "http.response"]) {
  test(`failed ${failure} registration disposes every successful registration and client`, async () => {
    const owner = await fixture({ fail: failure });
    await assert.rejects(owner.setup, /registration failed/);
    assert.deepEqual(owner.disposed.sort(), owner.registered.sort());
    assert.equal(owner.closed(), 1);
  });
}

test("managed native command, search, read, question, and skill denial preserves ordinary skill use, commentary scope and hosted request identity", async () => {
  const owner = await fixture();
  const cleanup = await owner.setup();
  try {
    const retained = ["edit", "write", "patch", "execute", OPENCODE_COMMENTARY_TOOL_NAME];
    const tools = Object.fromEntries([...MANAGED_DISABLED_NATIVE_TOOLS, ...retained].map(name => [name, { description: name }]));
    await owner.hooks.get("context")!({ sessionID: "managed", tools } as never);
    assert.deepEqual(Object.keys(tools), retained);
    const ordinaryCommentary = { [OPENCODE_COMMENTARY_TOOL_NAME]: { description: "commentary" }, edit: { description: "edit" } };
    await owner.hooks.get("context")!({ sessionID: "ordinary", tools: ordinaryCommentary } as never);
    assert.deepEqual(Object.keys(ordinaryCommentary), ["edit"], "ordinary sessions keep native text output");
    for (const tool of MANAGED_DISABLED_NATIVE_TOOLS) {
      await assert.rejects(owner.hooks.get("execute.before")!({ sessionID: "managed", tool } as never), /unavailable/);
      await owner.hooks.get("execute.before")!({ sessionID: "ordinary", tool } as never);
    }
    const ordinaryTools = { skill: { description: "native skill with <available_skills>" } };
    await owner.hooks.get("context")!({ sessionID: "ordinary", tools: ordinaryTools } as never);
    assert.equal(ordinaryTools.skill.description, "native skill with <available_skills>");
    const hosted = { sessionID: "managed", model: { providerID: "opencode" },
      request: new Request("https://example.test", { headers: { existing: "retained" } }) };
    await owner.hooks.get("http.request")!(hosted as never);
    assert.equal(hosted.request.headers.get("existing"), "retained");
    assert.equal(hosted.request.headers.get("x-opencode-session"), "managed");
    const external = { ...hosted, model: { providerID: "anthropic" }, request: new Request("https://example.test") };
    await owner.hooks.get("http.request")!(external as never);
    assert.equal(external.request.headers.has("x-opencode-session"), false);
  } finally { if (typeof cleanup === "function") await cleanup(); }
});

test("patch targets appear while both response and arguments are unfinished and native bytes stay unchanged", async () => {
  const owner = await fixture();
  const cleanup = await owner.setup();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
  const prefix = JSON.stringify({ patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n" }).slice(0, -2);
  const bytes = new TextEncoder().encode(
    frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-a", name: "patch", input: {} } })
    + frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: prefix } }),
  );
  const input = { sessionID: "managed", kind: "primary", model: { providerID: "anthropic", modelID: "test" },
    request: new Request("https://example.test/v1/messages"),
    response: new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; controller.enqueue(bytes); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } }),
  };
  try {
    await owner.hooks.get("http.response")!(input as never);
    const reader = input.response.body!.getReader();
    assert.deepEqual((await reader.read()).value, bytes);
    assert.ok(owner.observations.some(observation => observation.files?.some(file => file.path === "src/a.ts")));
    const second = new TextEncoder().encode(frame({ type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: "*** Add File: src/b.ts\\n+second\\n" } }));
    source.enqueue(second);
    assert.deepEqual((await reader.read()).value, second);
    assert.deepEqual(owner.observations.at(-1)?.files?.map(file => file.path), ["src/a.ts", "src/b.ts"]);
    await reader.cancel();
    assert.equal(cancelled, true);
    assert.equal(owner.observations.at(-1)?.kind, "withdraw");
  } finally { if (typeof cleanup === "function") await cleanup(); }
});

test("a successful task status call turns commentary results and bare-text hints into empty-reply turn-end guidance", async () => {
  const bareText = async (owner: Awaited<ReturnType<typeof fixture>>) => {
    const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
    const input = { sessionID: "managed", kind: "primary", model: { providerID: "opencode-go", modelID: "test" },
      request: new Request("https://example.test/v1/chat/completions"),
      response: new Response(new TextEncoder().encode(
        frame({ id: "c", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }] })
        + frame({ choices: [{ index: 0, delta: { content: "Done." } }] }),
      ), { headers: { "content-type": "text/event-stream" } }),
    };
    await owner.hooks.get("http.response")!(input as never);
    assert.doesNotMatch(await input.response.text(), /Done\./u);
  };
  const call = { sessionID: "managed", id: "call", messageID: "message" };
  const failing = await fixture({ catalogue: ["task_completed"], toolFails: true });
  const failingCleanup = await failing.setup();
  try {
    await assert.rejects(failing.tools.get("task_completed")!.execute({}, call), /refused/u);
    assert.equal((await failing.tools.get(OPENCODE_COMMENTARY_TOOL_NAME)!.execute({ text: "x" }, call)).content,
      openCodeCommentaryResult(false), "a failed status call changes nothing");
  } finally { if (typeof failingCleanup === "function") await failingCleanup(); }

  const owner = await fixture({ catalogue: ["task_completed", "git_arc_status"] });
  const cleanup = await owner.setup();
  try {
    const commentary = owner.tools.get(OPENCODE_COMMENTARY_TOOL_NAME)!;
    await bareText(owner);
    await owner.tools.get("git_arc_status")!.execute({}, call);
    assert.equal((await commentary.execute({ text: "x" }, call)).content, openCodeCommentaryResult(false));
    await owner.tools.get("task_completed")!.execute({}, call);
    assert.equal((await commentary.execute({ text: "x" }, call)).content, openCodeCommentaryResult(true));
    assert.equal((await commentary.execute({ text: "x" }, { ...call, sessionID: "other" })).content,
      openCodeCommentaryResult(false), "status belongs to the session that set it");
    await bareText(owner);
    assert.deepEqual(owner.synthetic, [OPENCODE_COMMENTARY_HINT, OPENCODE_COMMENTARY_FINISHING_HINT]);
  } finally { if (typeof cleanup === "function") await cleanup(); }
});

function goContext(integrationID: string | undefined, credentials: Record<string, { type: string; key?: string; access?: string; metadata?: Record<string, unknown> }>) {
  const connection = (id: string) => ({ type: "credential" as const, id, label: id, method: "key" as const });
  return {
    provider: { get: async () => ({ data: { integrationID } }) },
    integration: {
      connection: {
        active: async (id: string) => id === "opencode" && credentials[id] ? connection(id) : undefined,
        resolve: async (info: { type: string; id?: string }) => info.type === "credential" && info.id ? credentials[info.id] : undefined,
      },
      get: async ({ integrationID: id }: { integrationID: string }) => ({ data: { connections: credentials[id] ? [connection(id)] : [] } }),
    },
  };
}

test("Go credentials follow the integration OpenCode binds Go models to", async () => {
  const console = (access: string) => ({
    type: "oauth", access, metadata: { accountID: "acc", orgID: "org", email: "me@example.com" },
  });
  const credentials = { "opencode-go": { type: "key", key: "expired" }, opencode: console("fresh") };
  const bound = await resolveOpenCodeGoCredential(goContext("opencode", credentials));
  assert.equal(bound?.token, "fresh");
  assert.equal(bound?.orgID, "org");
  assert.equal(bound?.label, "me@example.com");
  // Refreshing the console token keeps the same account.
  const refreshed = await resolveOpenCodeGoCredential(goContext("opencode", { ...credentials, opencode: console("rotated") }));
  assert.equal(refreshed?.identity, bound?.identity);
  const unbound = await resolveOpenCodeGoCredential(goContext(undefined, credentials));
  assert.equal(unbound?.token, "expired");
  assert.equal(unbound?.orgID, null);
});

test("Go quota sends the bound credential and names its account without exposing it", async () => {
  const result = await readOpenCodeGoQuota({
    resolveCredential: async () => ({ token: "secret", orgID: "org", identity: "private-account\0org", label: "me@example.com" }),
    fetch: async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer secret");
      assert.equal(headers.get("x-org-id"), "org");
      return Response.json({ usage: Object.fromEntries(["rolling", "weekly", "monthly"].map(key =>
        [key, { status: "ok", percent: 1, resetsAt: "2026-09-27T01:00:00.000Z" }])) });
    },
  });
  assert.ok(result.ok);
  assert.equal(result.quota.accountLabel, "me@example.com");
  assert.doesNotMatch(JSON.stringify(result), /secret|private-account/u);
});

test("an expired Go key says so without leaking it", async () => {
  const failure = await readOpenCodeGoQuota({
    resolveCredential: async () => ({ token: "secret", orgID: null, identity: "secret", label: null }),
    fetch: async () => Response.json({ error: { code: "api_key_expired", message: "secret expired" } }, { status: 401 }),
  });
  assert.equal(failure.ok, false);
  assert.match(JSON.stringify(failure), /expired/u);
  assert.doesNotMatch(JSON.stringify(failure), /secret/u);
});

test("Go quota normalises windows and returns sanitised failures", async () => {
  const key = { token: "secret", orgID: null, identity: "secret", label: null };
  const result = await readOpenCodeGoQuota({
    now: () => 100, resolveCredential: async () => key,
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
      assert.equal(new Headers(init?.headers).has("x-org-id"), false);
      return Response.json({ usage: Object.fromEntries(["rolling", "weekly", "monthly"].map((key, index) =>
        [key, { status: "ok", percent: index + 1, resetsAt: "2026-09-27T01:00:00.000Z" }])) });
    },
  });
  assert.ok(result.ok);
  assert.equal(result.quota.observedAt, 100);
  assert.equal(result.quota.windows.monthly.percent, 3);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  for (const request of [
    async () => { throw new Error("PRIVATE"); },
    async () => new Response(null, { status: 403 }),
  ]) {
    const failure = await readOpenCodeGoQuota({ resolveCredential: async () => key, fetch: request });
    assert.equal(failure.ok, false);
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE|secret/);
  }
  assert.equal((await readOpenCodeGoQuota({ resolveCredential: async () => undefined })).ok, false);
});
