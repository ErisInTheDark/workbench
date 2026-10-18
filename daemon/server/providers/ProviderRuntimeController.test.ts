/* Exports: none. Protect provider runtime install commits, single-flight installs, baseline fallback, failure state, auto-follow and disposal. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { ProviderRuntimeKey } from "workbench-shared/workbench/provider/provider-runtime";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import ProviderRuntimeController from "./ProviderRuntimeController";
import {
  providerRuntimeRoot,
  providerRuntimeVersionRoot,
  resolveProviderRuntime,
  type ProviderRuntimeDefinition,
} from "./provider-runtimes";

const target = { platform: "linux" as const, arch: "x64", musl: false };

function definition(packages = ["@test/primary", "@test/baseline"]): ProviderRuntimeDefinition {
  return {
    label: "Test runtime",
    packages: () => packages,
    executable: () => path.join("bin", "tool"),
  };
}

interface Harness {
  dataRoot: string;
  installs: string[];
  warnings: string[];
  controller: ProviderRuntimeController;
}

async function harness(context: TestContext, options: {
  version?: string;
  packages?: string[];
  npm?: (spec: string, signal: AbortSignal) => Promise<void>;
  /** Packages whose executable crashes when probed. */
  broken?: string[];
  reported?: (version: string) => string;
} = {}): Promise<Harness> {
  const temporary = await WorkbenchTemporaryDirectory.create("provider-runtime-controller-");
  context.after(() => temporary.dispose());
  const version = options.version ?? "1.0.0";
  const installs: string[] = [];
  const warnings: string[] = [];
  const definitions = { claude: definition(options.packages), opencode: definition(options.packages) } satisfies Record<ProviderRuntimeKey, ProviderRuntimeDefinition>;
  const pin = () => ({ packageVersion: version, version: `v${version}` });
  const controller = new ProviderRuntimeController({
    dataRoot: temporary.path,
    pins: { claude: pin, opencode: pin },
    definitions,
    target,
    warn: message => { warnings.push(message); },
    runNpm: async (args, signal) => {
      const spec = args.at(-1)!;
      installs.push(spec);
      await options.npm?.(spec, signal);
      const prefix = args[args.indexOf("--prefix") + 1]!;
      const name = spec.slice(0, spec.lastIndexOf("@"));
      const executable = path.join(prefix, "node_modules", name, "bin", "tool");
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, name);
    },
    probe: async executable => {
      if (options.broken?.includes(await readFile(executable, "utf8"))) throw new Error("illegal instruction");
      return (options.reported ?? (pin => `${pin} (test)`))(`v${version}`);
    },
  });
  context.after(() => controller.dispose());
  return { dataRoot: temporary.path, installs, warnings, controller };
}

const state = async (controller: ProviderRuntimeController, key: ProviderRuntimeKey = "claude") =>
  (await controller.read()).data.find(status => status.provider === key)!;

test("an install commits a verified runtime that then resolves", async context => {
  const { controller, dataRoot, installs } = await harness(context);
  assert.equal((await state(controller)).state, "missing");
  const snapshot = await controller.install("claude");
  assert.deepEqual(snapshot.data.find(status => status.provider === "claude"),
    { provider: "claude", version: "v1.0.0", installedVersion: "v1.0.0", state: "ready", error: null });
  assert.deepEqual(installs, ["@test/primary@1.0.0"]);
  const root = providerRuntimeVersionRoot(dataRoot, "claude", "1.0.0");
  assert.equal(existsSync(path.join(root, "installed.json")), true);
  assert.deepEqual(await readdir(providerRuntimeRoot(dataRoot, "claude")), ["1.0.0"]);
  // A second click on a ready runtime does nothing.
  await controller.install("claude");
  assert.equal(installs.length, 1);
});

test("concurrent installs share one flight and report installing while it runs", async context => {
  const release = Promise.withResolvers<void>();
  const { controller, installs } = await harness(context, { npm: () => release.promise });
  const first = controller.install("claude");
  const second = controller.install("claude");
  assert.equal((await state(controller)).state, "installing");
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(installs, ["@test/primary@1.0.0"]);
  assert.equal(a.data[0]!.state, "ready", a.data[0]!.error ?? undefined);
  assert.equal(b.data[0]!.state, "ready", b.data[0]!.error ?? undefined);
});

test("a primary build that cannot run falls back to the baseline build", async context => {
  const { controller, installs } = await harness(context, { broken: ["@test/primary"] });
  assert.equal((await controller.install("opencode")).data.find(status => status.provider === "opencode")!.state, "ready");
  assert.deepEqual(installs, ["@test/primary@1.0.0", "@test/baseline@1.0.0"]);
});

test("a failed verify leaves nothing installed and reports a retryable failure", async context => {
  const { controller, dataRoot, warnings } = await harness(context, { reported: () => "0.9.0" });
  const failed = (await controller.install("claude")).data[0]!;
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /instead of v1\.0\.0/u);
  assert.deepEqual(await readdir(providerRuntimeRoot(dataRoot, "claude")), []);
  assert.throws(() => resolveProviderRuntime(dataRoot, "claude", { packageVersion: "1.0.0", version: "v1.0.0" }));
  assert.equal(warnings.length, 1);
});

test("an npm failure does not try other builds and surfaces npm's error", async context => {
  const { controller, installs } = await harness(context, { npm: async () => { throw new Error("registry unreachable"); } });
  const failed = (await controller.install("claude")).data[0]!;
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /registry unreachable/u);
  assert.equal(installs.length, 1);
});

test("start reinstalls only runtimes the user installed for an earlier pin", async context => {
  const { controller, dataRoot, installs } = await harness(context, { version: "2.0.0" });
  const stale = providerRuntimeVersionRoot(dataRoot, "claude", "1.0.0");
  await mkdir(path.join(stale, "bin"), { recursive: true });
  await writeFile(path.join(stale, "bin", "tool"), "");
  await writeFile(path.join(stale, "installed.json"), JSON.stringify({
    packageName: "@test/primary", packageVersion: "1.0.0", version: "v1.0.0", executable: path.join("bin", "tool"),
  }));
  assert.deepEqual(await state(controller), { provider: "claude", version: "v2.0.0", installedVersion: "v1.0.0", state: "missing", error: null });
  controller.start();
  assert.equal((await state(controller)).state, "installing");
  assert.equal((await state(controller, "opencode")).state, "missing");
  await controller.install("claude");
  assert.deepEqual(installs, ["@test/primary@2.0.0"]);
  assert.deepEqual(await readdir(providerRuntimeRoot(dataRoot, "claude")), ["2.0.0"]);
});

test("disposal cancels a running install without recording a failure", async context => {
  const started = Promise.withResolvers<void>();
  const { controller, dataRoot } = await harness(context, {
    npm: (_spec, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started.resolve();
    }),
  });
  const installing = controller.install("claude");
  await started.promise;
  await controller.dispose();
  assert.equal((await installing).data[0]!.state, "missing");
  assert.deepEqual(await readdir(providerRuntimeRoot(dataRoot, "claude")), []);
  await assert.rejects(controller.install("claude"), /reloading/u);
});

test("an unsupported platform reports unsupported and never installs", async context => {
  const { controller, installs } = await harness(context, { packages: [] });
  assert.equal((await controller.install("claude")).data[0]!.state, "unsupported");
  assert.deepEqual(installs, []);
});
