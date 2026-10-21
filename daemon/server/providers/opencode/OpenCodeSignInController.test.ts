/* Exports: none. Protect which OpenCode integrations Workbench offers and how their sign-in state reads. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntegrationInfo } from "@opencode/client";
import { openCodeAccountIntegrations } from "./OpenCodeSignInController";

const info = (id: string, name: string, methods: IntegrationInfo["methods"], connections: IntegrationInfo["connections"] = []) => (
  { id, name, methods, connections } as IntegrationInfo
);

test("the console comes first, terminal-only integrations are dropped, and connections mark sign-in", () => {
  const integrations = openCodeAccountIntegrations([
    info("anthropic", "Anthropic", [{ id: "max", type: "oauth", label: "Claude Max" }, { type: "key" }],
      [{ type: "credential", id: "cred-1", label: "work", method: "key" }]),
    info("custom", "Custom", [{ id: "run", type: "command", label: "Run", command: ["login"] }]),
    info("env-only", "Env only", [{ type: "env", names: ["ENV_ONLY_KEY"] }], [{ type: "env", name: "ENV_ONLY_KEY" }]),
    info("opencode", "OpenCode Console", [{ id: "browser", type: "oauth", label: "Browser" }]),
  ]);
  assert.deepEqual(integrations.map(integration => integration.id), ["opencode", "anthropic", "env-only"]);
  assert.deepEqual(integrations[0], {
    id: "opencode", label: "OpenCode Console", primary: true, signedIn: false, accountLabel: null,
    methods: [{ id: "browser", label: "Browser", kind: "browser" }],
  });
  assert.deepEqual(integrations[1]?.methods.map(method => method.kind), ["browser", "key"]);
  assert.equal(integrations[1]?.accountLabel, "work");
  assert.deepEqual(integrations[2]?.methods, []);
  assert.equal(integrations[2]?.signedIn, true);
});
