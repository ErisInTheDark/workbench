/*
 * Exports:
 * - tests: provider registration is exercised through graph tests rather than source-shape assertions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import providerRegistrations from "workbench-shared/workbench/provider/provider-registrations";
import OpenCodeProvider, { openCodeAccountLimits, openCodeModelOption } from "./OpenCodeProvider";
import type { CodexExecRequest } from "../../codex-exec-protocol";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

test("provider execution preserves configured sandbox policy and admitted boundaries", async () => {
  const calls: CodexExecRequest[] = [];
  const configurationReads: object[] = [];
  const registrations = {
    openCodeService: {},
    openCodeThreadOperations: {},
    codexExecutor: { execute: async (request: CodexExecRequest) => {
      calls.push(request);
      return { exitCode: 7, stdout: "", stderr: "failure" };
    } },
    codexThreadOperations: { requestNative: async (method: string, params: object) => {
      assert.equal(method, "config/read");
      configurationReads.push(params);
      return { config: { windows: { sandbox: "elevated", sandbox_private_desktop: false },
        shell_environment_policy: { inherit: "core" } } };
    } },
  };
  const instance = await OpenCodeProvider.create({} as never, {
    get: (key: keyof typeof registrations) => registrations[key],
  } as never);
  const result = await instance.registrations!.openCodeProvider!.tools!.execute!({
    caller: { harness: "opencode", cwd: process.cwd(), threadId: WorkbenchThreadIdSchema.parse("native-owner") },
    command: ["pwsh", "-Command", "exit 7"], cwd: process.cwd(),
    permissions: { mode: "restricted", writableRoots: [process.cwd()], network: false },
  }, new AbortController().signal);
  assert.equal(result.exitCode, 7);
  assert.equal(configurationReads.length, 1);
  assert.equal(calls[0]?.windowsSandboxLevel, "elevated");
  assert.equal(calls[0]?.windowsSandboxPrivateDesktop, false);
  assert.equal(calls[0]?.envPolicy.inherit, "core");
  assert.equal(calls[0]?.permissions.type, "managed");
  assert.ok(calls[0]?.permissions.type === "managed" && calls[0].permissions.network === "restricted");
});

test("installs OpenCode under its graph provider registration", () => {
  assert.equal(providerRegistrations.opencode, "openCodeProvider");
});

test("maps all three OpenCode Go windows into one account limit", () => {
  const limits = openCodeAccountLimits({
    observedAt: 1,
    windows: {
      rolling: { percent: 12, resetsAt: 1_000, status: "ok" },
      weekly: { percent: 34, resetsAt: 2_000, status: "ok" },
      monthly: { percent: 56, resetsAt: 3_000, status: "limited" },
    },
  });
  assert.equal(limits.rateLimits.primary?.windowDurationMins, 300);
  assert.equal(limits.rateLimits.secondary?.windowDurationMins, 10_080);
  assert.equal(limits.rateLimits.tertiary?.windowDurationMins, 43_200);
  assert.equal(limits.rateLimits.rateLimitReachedType, null);
});

test("keeps fixed OpenCode context as model metadata instead of configurable profile state", () => {
  const option = openCodeModelOption({
    id: "opencode-go/model",
    providerID: "opencode-go",
    modelID: "model",
    name: "Model",
    family: "family",
    enabled: true,
    status: "active",
    variants: [],
    capabilities: { input: ["text"], output: ["text"], tools: true },
    limit: { context: 200_000, output: 32_000 },
  }, "opencode-go/model");

  assert.equal(option.maxContextWindowTokens, 200_000);
  assert.equal(option.contextWindow, null);
  assert.equal(option.isDefault, true);
});
