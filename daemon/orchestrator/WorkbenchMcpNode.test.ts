/*
 * Keywords: MCP, reload, executor, restoration, cancellation.
 * No exports. Tests exercise the real MCP node's command-generation lifecycle.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import ReloadableNode, { defineReloadableNodeGraph } from "./ReloadableNode";
import ReloadableNodeHost from "./ReloadableNodeHost";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";

test("restoring the MCP node installs a usable executor without bumping freshness", async () => {
  let bumps = 0;
  const registrations = {
    agentCommand: { executeStructuredRequest: async () => new Response("restored") },
    codexMcpGeneration: { bump: () => { bumps += 1; } },
    threadState: { controller: { setThreadWaitState: () => undefined } },
  } as unknown as OrchestratorRuntimeObjects;
  const instance = WorkbenchMcpNode.create({
    legacyMigrationProjectRoot: process.cwd(),
    localOrchestratorOrigin: "http://127.0.0.1:4500",
  } as OrchestratorProcessContext, {
    get: (key) => registrations[key],
    handoffState: undefined,
    isReplacing: () => true,
    lease: { isCurrent: () => true },
    mode: "restore",
  });
  try {
    await instance.start();
    instance.afterCommit?.();
    const result = await getProcessWorkbenchAgentMcpRequestRegistry().executeCommand({
      method: "POST", path: "/api/request-user-input", responseKind: "native",
    }, new AbortController().signal);
    assert.equal(await result.text(), "restored");
    assert.equal(bumps, 0);
  } finally {
    await instance.dispose();
  }
});

for (const outcome of ["replacement", "retiring success", "rollback", "admitted during startup"] as const) {
  test(`a pending command survives topology handoff with ${outcome}`, async () => {
    let reportStarting!: () => void;
    let finishStarting!: () => void;
    const starting = new Promise<void>((resolve) => { reportStarting = resolve; });
    const canStart = new Promise<void>((resolve) => { finishStarting = resolve; });
    let finishOldCommand!: () => void;
    const context = {
      legacyMigrationProjectRoot: process.cwd(),
      localOrchestratorOrigin: "http://127.0.0.1:4500",
      refreshWorkbenchPromptFiles: async () => {
        if (outcome === "rollback") throw new Error("candidate prompt refresh failed");
        if (outcome === "admitted during startup") {
          reportStarting();
          await canStart;
        }
      },
    } as OrchestratorProcessContext;
    const parent = (replacement: boolean) => new ReloadableNode({
      access: "agent", children: [WorkbenchMcpNode], description: "MCP parent",
      lifecycle: "atomic", safeAll: true, scope: "server:parent", sources: "parent.ts", requires: [],
      provides: [...WorkbenchMcpNode.requires, ...(replacement ? ["modules" as const] : [])],
      create: (_context, build) => {
        const registrations = Object.fromEntries(WorkbenchMcpNode.requires.map((key) => [key, {}]));
        if (replacement) registrations.modules = {};
        registrations.agentCommand = {
          executeStructuredRequest: async (_request: object, signal: AbortSignal) => {
            if (build.mode !== "initial") return new Response(build.mode);
            return await new Promise<Response>((resolve, reject) => {
              finishOldCommand = () => resolve(new Response("rollback"));
              signal.addEventListener("abort", () => {
                if (outcome === "retiring success") resolve(new Response("retiring success"));
                else reject(signal.reason);
              }, { once: true });
            });
          },
        };
        registrations.threadState = { controller: { setThreadWaitState: () => undefined } };
        registrations.codexMcpGeneration = { bump: () => undefined };
        return { registrations, dispose: () => undefined, start: () => undefined };
      },
    });
    const initial = defineReloadableNodeGraph([parent(false)]);
    const replacement = defineReloadableNodeGraph([parent(true)]);
    const host = new ReloadableNodeHost(context, { load: () => initial, reload: () => replacement });
    await host.start();
    let reload: Promise<void> | null = null;
    if (outcome === "admitted during startup") {
      reload = host.reload(["server:topology"]);
      await starting;
    }
    const command = getProcessWorkbenchAgentMcpRequestRegistry().executeCommand({
      method: "POST", path: "/api/request-user-input", responseKind: "native",
    }, new AbortController().signal);
    const result = command.then((response) => response.text());
    // Observe failure immediately too, so a broken handoff cannot produce an unhandled rejection.
    const checked = result.then((value) => assert.equal(value, outcome === "admitted during startup" ? "replacement" : outcome));
    finishStarting();
    reload ??= host.reload(["server:topology"]);
    if (outcome === "rollback") {
      await assert.rejects(reload, /candidate prompt refresh failed/u);
      finishOldCommand();
    }
    else await reload;
    await checked;
    await host.dispose();
  });
}

test("candidate activation failure leaves the live MCP executor and freshness intact", async () => {
  let bumps = 0;
  const failedChild = new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
    access: "agent", children: [], description: "activation failure",
    lifecycle: "atomic", safeAll: true, scope: "server:failure", sources: "failure.ts",
    requires: [], provides: [],
    create: (_context, build) => ({
      registrations: {},
      start: () => {},
      activate: () => {
        if (build.mode === "replacement") throw new Error("activation rejected");
      },
      dispose: () => {},
    }),
  });
  const parent = new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
    access: "agent", children: [WorkbenchMcpNode, failedChild], description: "MCP parent",
    lifecycle: "atomic", safeAll: true, scope: "server:parent", sources: "parent.ts",
    requires: [], provides: [...WorkbenchMcpNode.requires],
    create: (_context, build) => {
      const registrations = Object.fromEntries(WorkbenchMcpNode.requires.map((key) => [key, {}]));
      registrations.agentCommand = {
        executeStructuredRequest: async () => new Response(build.mode),
      };
      registrations.threadState = { controller: { setThreadWaitState: () => {} } };
      registrations.codexMcpGeneration = { bump: () => { bumps += 1; } };
      return { registrations, start: () => {}, dispose: () => {} };
    },
  });
  const graph = defineReloadableNodeGraph([parent]);
  const host = new ReloadableNodeHost({
    legacyMigrationProjectRoot: process.cwd(),
    localOrchestratorOrigin: "http://127.0.0.1:4500",
    refreshWorkbenchPromptFiles: async () => {},
  } as OrchestratorProcessContext, { load: () => graph, reload: () => graph });
  await host.start();
  try {
    await assert.rejects(host.reload(["server:parent"]), /activation rejected/u);
    const response = await getProcessWorkbenchAgentMcpRequestRegistry().executeCommand({
      method: "POST", path: "/api/request-user-input", responseKind: "native",
    }, new AbortController().signal);
    assert.equal(await response.text(), "initial");
    assert.equal(bumps, 0);
  } finally {
    await host.dispose();
  }
});
