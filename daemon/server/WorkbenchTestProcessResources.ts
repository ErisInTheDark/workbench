/*
 * Exports:
 * - default WorkbenchTestProcessResources: retain isolated service PID records outside a test worker.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import WorkbenchTemporaryDirectory from "./lib/workbench/WorkbenchTemporaryDirectory";

const REGISTRY_ENV = "WORKBENCH_TEST_SERVICE_RECORDS";
const ServiceProcess = z.object({ pid: z.number().int().min(2) });

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

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
  private constructor(readonly file: string, private readonly ownedDirectory: WorkbenchTemporaryDirectory | null) {}

  static async create(inherit = false) {
    const inherited = inherit ? process.env[REGISTRY_ENV] : undefined;
    if (inherited) return new WorkbenchTestProcessResources(inherited, null);
    const directory = await WorkbenchTemporaryDirectory.create("wb-test-services-");
    const file = path.join(directory.path, "records.jsonl");
    await fs.writeFile(file, "");
    return new WorkbenchTestProcessResources(file, directory);
  }

  get environment() { return { [REGISTRY_ENV]: this.file }; }

  static async track(serviceFile: string) {
    const registry = process.env[REGISTRY_ENV];
    if (registry) await fs.appendFile(registry, `${JSON.stringify(serviceFile)}\n`);
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
      .map(line => z.string().parse(JSON.parse(line)));
    const results = await Promise.allSettled([...new Set(records)].map(file =>
      WorkbenchTestProcessResources.retireService(file)));
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "Owned test service cleanup failed.");
    if (this.ownedDirectory) await this.ownedDirectory.dispose();
  }
}
