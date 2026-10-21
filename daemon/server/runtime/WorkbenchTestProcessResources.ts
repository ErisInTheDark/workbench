/*
 * Exports:
 * - default WorkbenchTestProcessResources: retain isolated service and workspace records outside a test worker,
 *   keep a killed scenario's logs before removing its workspace, and cap retained scenario diagnostics.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import WorkbenchTemporaryDirectory from "../lib/workbench/WorkbenchTemporaryDirectory";

const REGISTRY_ENV = "WORKBENCH_TEST_SERVICE_RECORDS";
const ServiceProcess = z.object({ pid: z.number().int().min(2) });
const WorkspaceRecord = z.object({
  kind: z.literal("workspace"),
  root: z.string().min(1),
  source: z.string().min(1),
}).strict();
const ResourceRecord = z.union([z.string(), WorkspaceRecord]);

function within(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function validateWorkspace(source: string, root: string, projectRoot?: string) {
  const resolvedSource = path.resolve(source);
  const resolvedRoot = path.resolve(root);
  const packageTempRoot = projectRoot && path.join(path.dirname(projectRoot), ".workbench", "tmp");
  if (projectRoot && !within(projectRoot, resolvedSource)
    && !(packageTempRoot && within(packageTempRoot, resolvedSource))) {
    throw new Error("Scenario source is outside the owning project.");
  }
  if (path.dirname(resolvedRoot) !== path.join(resolvedSource, ".workbench", "test-runs")
    || !/^wb-scenario-[^\\/]+$/u.test(path.basename(resolvedRoot))) {
    throw new Error("Not an owned scenario workspace.");
  }
  return resolvedRoot;
}

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Only named logs; never cloned databases, credentials or identity links. */
const SCENARIO_DIAGNOSTIC_LOGS = ["scenario.log", "daemon.log", "service.log", "app.log"] as const;
const SCENARIO_DIAGNOSTIC_PREFIX = "failure-wb-scenario-";
/** Recent failures are what get read; older ones only grow the fixtures directory. */
const RETAINED_SCENARIO_DIAGNOSTICS = 20;

async function retirePid(pid: number) {
  try { process.kill(pid, "SIGKILL"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
  // Validation cleanup owns this deadline. Do not release a successful result
  // while a known service may still hold the next run's files.
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    if (process.platform === "linux") {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        if (/^\s+[ZX]\s/u.test(stat.slice(stat.lastIndexOf(")") + 1))) return;
      } catch (error) { if (missing(error)) return; throw error; }
    }
    if (Date.now() >= deadline) throw new Error(`Owned test service PID ${pid} did not exit after termination.`);
    await delay(10);
  }
}

export default class WorkbenchTestProcessResources {
  private constructor(
    readonly file: string,
    private readonly ownedDirectory: WorkbenchTemporaryDirectory | null,
    private readonly projectRoot: string,
    private readonly report: (message: string) => void,
  ) {}

  static async create(inherit = false, projectRoot = process.cwd(), report = (message: string) => console.error(message)) {
    const inherited = inherit ? process.env[REGISTRY_ENV] : undefined;
    if (inherited) return new WorkbenchTestProcessResources(inherited, null, path.resolve(projectRoot), report);
    const directory = await WorkbenchTemporaryDirectory.create("wb-test-services-");
    const file = path.join(directory.path, "records.jsonl");
    await fs.writeFile(file, "");
    return new WorkbenchTestProcessResources(file, directory, path.resolve(projectRoot), report);
  }

  get environment() { return { [REGISTRY_ENV]: this.file }; }

  static async track(serviceFile: string) {
    const registry = process.env[REGISTRY_ENV];
    if (registry) await fs.appendFile(registry, `${JSON.stringify(serviceFile)}\n`);
  }

  static async trackWorkspace(source: string, root: string) {
    const owned = validateWorkspace(source, root);
    const registry = process.env[REGISTRY_ENV];
    if (registry) await fs.appendFile(registry, `${JSON.stringify({
      kind: "workspace", source: path.resolve(source), root: owned,
    })}\n`);
  }

  /** Copy a scenario workspace's logs beside it, drop all but the newest retained runs, and return the new directory. */
  static async retainScenarioDiagnostics(root: string) {
    const fixtures = path.dirname(root);
    const diagnostics = path.join(fixtures, `failure-${path.basename(root)}-${randomUUID()}`);
    await fs.mkdir(diagnostics);
    for (const file of SCENARIO_DIAGNOSTIC_LOGS) {
      await fs.copyFile(path.join(root, file), path.join(diagnostics, file)).catch(error => { if (!missing(error)) throw error; });
    }
    const retained = await Promise.all((await fs.readdir(fixtures, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith(SCENARIO_DIAGNOSTIC_PREFIX))
      .map(async entry => {
        const directory = path.join(fixtures, entry.name);
        return { directory, modified: directory === diagnostics ? Infinity : (await fs.stat(directory)).mtimeMs };
      }));
    for (const { directory } of retained.sort((left, right) => right.modified - left.modified).slice(RETAINED_SCENARIO_DIAGNOSTICS)) {
      await fs.rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
    }
    return diagnostics;
  }

  static async retireService(serviceFile: string, kill = retirePid) {
    let source: string;
    try { source = await fs.readFile(serviceFile, "utf8"); }
    catch (error) { if (missing(error)) return; throw error; }
    const { pid } = ServiceProcess.parse(JSON.parse(source));
    await kill(pid);
    // A second cleanup owner must not reuse a retired PID record.
    await fs.unlink(serviceFile).catch(error => { if (!missing(error)) throw error; });
  }

  async dispose() {
    const records = (await fs.readFile(this.file, "utf8")).split("\n").filter(Boolean)
      .map(line => ResourceRecord.parse(JSON.parse(line)));
    const services = records.filter((record): record is string => typeof record === "string");
    const results = await Promise.allSettled([...new Set(services)].map(file =>
      WorkbenchTestProcessResources.retireService(file)));
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "Owned test service cleanup failed.");
    const workspaces = records.filter((record): record is z.infer<typeof WorkspaceRecord> =>
      typeof record !== "string");
    for (const root of new Set(workspaces.map(record =>
      validateWorkspace(record.source, record.root, this.projectRoot)))) {
      // A scenario that closed removed its own root; one still holding logs was killed before it could keep them.
      const killed = await fs.stat(path.join(root, "scenario.log")).then(() => true, error => { if (missing(error)) return false; throw error; });
      if (killed) this.report(`Scenario diagnostics retained: ${await WorkbenchTestProcessResources.retainScenarioDiagnostics(root)}`);
      await fs.rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
    }
    if (this.ownedDirectory) await this.ownedDirectory.dispose();
  }
}
