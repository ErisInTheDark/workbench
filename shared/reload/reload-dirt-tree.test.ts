import assert from "node:assert/strict";
import test from "node:test";
import type { ReloadDirtScope as WorkbenchReloadDirtScope } from "./reload-dirt-scope.ts";
import { buildReloadDirtTree, type ReloadDirtNode } from "./reload-dirt-tree.ts";

const dirty = (scope: string, dependantScopes: string[], extra: Partial<WorkbenchReloadDirtScope> = {}): WorkbenchReloadDirtScope =>
  ({ scope, dependantScopes, description: scope, destructive: false, ...extra });
const shape = (nodes: ReloadDirtNode[]): unknown => nodes.map(node => [node.scope.scope, node.size, shape(node.children)]);

test("dirty scopes nest under the smallest dirty reload that already covers them", () => {
  const tree = buildReloadDirtTree([
    dirty("server:database", ["server:core", "server:codex", "server:codex/tools", "server:turns"]),
    dirty("server:core", ["server:codex", "server:codex/tools"]),
    dirty("server:codex", ["server:codex/tools"]),
    dirty("server:codex/tools", []),
    dirty("server:instructions", []),
  ]);
  assert.deepEqual(shape(tree), [
    ["server:database", 4, [["server:core", 3, [["server:codex", 2, [["server:codex/tools", 1, []]]]]]]],
    ["server:instructions", 1, []],
  ]);
});

test("clean scopes in a closure do not become nodes, and restarts then migrations lead the roots", () => {
  const tree = buildReloadDirtTree([
    dirty("server:instructions", []),
    dirty("server:database", ["server:core", "server:mcp"], { migration: { label: "database", from: 30, to: 31 } }),
    dirty("server:mcp", []),
    dirty("client:process", ["client:http", "client:install"], { destructive: true }),
    dirty("client:http", []),
  ]);
  assert.deepEqual(shape(tree), [
    ["client:process", 2, [["client:http", 1, []]]],
    ["server:database", 2, [["server:mcp", 1, []]]],
    ["server:instructions", 1, []],
  ]);
});

test("scopes that cover each other still form a forest", () => {
  const tree = buildReloadDirtTree([
    dirty("client:install", ["client:process", "client:http"], { destructive: true }),
    dirty("client:process", ["client:install", "client:http"], { destructive: true }),
    dirty("client:http", []),
  ]);
  assert.deepEqual(shape(tree), [["client:install", 3, [["client:process", 2, [["client:http", 1, []]]]]]]);
});
