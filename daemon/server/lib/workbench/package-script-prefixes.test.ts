/*
 * No production exports. Protect runner recognition and conservative ambiguity handling.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getPackageScriptPrefix } from "./package-script-prefixes.ts";

test("runner forms preserve invocation through the script name, excluding its arguments", () => {
  for (const prefix of [
    ["npm", "run", "check"], ["npm", "run-script", "check"], ["npm", "test"],
    ["npm", "start"], ["npm", "stop"], ["npm", "restart"],
    ["pnpm", "run", "check"], ["pnpm", "run-script", "check"], ["pnpm", "check"],
    ["yarn", "run", "check"], ["yarn", "verify"], ["bun", "run", "check"], ["bun", "check"],
    ["node", "--run", "check"], ["deno", "task", "check"],
    ["composer", "run-script", "check"], ["composer", "run", "check"],
    ["corepack", "pnpm", "run", "check"], ["corepack", "yarn", "verify"],
    ["C:\\node\\npm.cmd", "run", "check"],
    ["pnpm", "--filter", "web", "run", "check"],
    ["pnpm", "-C", "packages/web", "-r", "run", "check"],
    ["npm", "--workspace=web", "run", "check"],
    ["yarn", "--cwd", "web", "run", "check"],
    ["bun", "--cwd", "web", "run", "check"],
    ["deno", "task", "--cwd", "web", "check"],
    ["composer", "--working-dir", "web", "run", "check"],
  ]) assert.deepEqual(getPackageScriptPrefix([...prefix, "--", "--watch"]), prefix, prefix.join(" "));
});

test("builtins, executable launchers, missing values and unknown flags are not guessed as scripts", () => {
  for (const argv of [
    ["npm", "install"], ["pnpm", "install"], ["yarn", "add", "pkg"], ["bun", "build", "index.ts"],
    ["npx", "test"], ["pnpm", "dlx", "test"], ["pnpm", "exec", "test"], ["bunx", "test"],
    ["pnpm", "--mystery", "value", "test"], ["npm", "run"], ["pnpm", "--filter"],
    ["yarn", "run", "--mystery", "test"], ["corepack", "prepare", "pnpm"],
    ["bun", "app.ts"], ["pnpm", "run", "/test.*/"], ["deno", "run", "app.ts"],
  ]) assert.equal(getPackageScriptPrefix(argv), null, argv.join(" "));
});
