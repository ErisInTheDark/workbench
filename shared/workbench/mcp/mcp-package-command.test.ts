/*
 * No production exports. Tests protect how a typed or pasted stdio server command splits into package, version and
 * arguments, and that npm-flag-shaped or path-shaped packages never reach an install.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpPackageCommand } from "./mcp-package-command.ts";

test("a pasted README launcher line keeps only the package and its own arguments", () => {
  assert.deepEqual(parseMcpPackageCommand("npx -y @azure-devops/mcp contoso"), { command: { package: "@azure-devops/mcp", args: ["contoso"] } });
  assert.deepEqual(parseMcpPackageCommand("pnpm dlx @azure-devops/mcp contoso -d core"),
    { command: { package: "@azure-devops/mcp", args: ["contoso", "-d", "core"] } });
  assert.deepEqual(parseMcpPackageCommand("  @azure-devops/mcp   contoso "), { command: { package: "@azure-devops/mcp", args: ["contoso"] } });
});

test("a version follows the package name's own @, and quotes keep spaces inside one argument", () => {
  assert.deepEqual(parseMcpPackageCommand("@scope/server@^2.1 --root 'C:/My Files' \"\""),
    { command: { package: "@scope/server", version: "^2.1", args: ["--root", "C:/My Files", ""] } });
  assert.deepEqual(parseMcpPackageCommand("plain-server@latest"), { command: { package: "plain-server", version: "latest", args: [] } });
});

test("anything npm could read as a flag, path or URL is refused before install", () => {
  for (const text of ["", "npx -y", "--registry=https://evil.example pkg", "./local", "git+https://host/repo.git", "Upper", "pkg@", "pkg@-x", "pkg 'open"]) {
    assert.ok("error" in parseMcpPackageCommand(text), text);
  }
});
