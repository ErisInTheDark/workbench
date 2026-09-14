/*
 * Exports:
 * - default ProjectTestCatalog: discover project files and validate colocated test ownership.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const ROOTS = ["app", "daemon", "package", "shared", "test"];
const EXCLUDED = new Set([".next", "build", "coverage", "dist", "generated", "node_modules", ".git", ".workbench", "target", "gen"]);
const TEST = /\.test\.tsx?$/u;

export default class ProjectTestCatalog {
  readonly tests: string[];
  readonly sources: string[];
  readonly owners = new Map<string, string[]>();
  readonly explicitStandaloneTests: ReadonlySet<string>;

  constructor(
    readonly root: string,
    readonly files: readonly string[],
    explicitStandaloneTests: readonly string[] = [],
  ) {
    this.explicitStandaloneTests = new Set(explicitStandaloneTests);
    this.tests = files.filter(file => TEST.test(file)).sort();
    this.sources = files.filter(file => !TEST.test(file)).sort();
    const byDirectory = new Map<string, string[]>();
    for (const file of this.sources) {
      const directory = path.dirname(file);
      const entries = byDirectory.get(directory) ?? [];
      entries.push(file);
      byDirectory.set(directory, entries);
    }
    for (const file of this.tests) {
      const stem = path.basename(file).replace(TEST, "");
      this.owners.set(file, (byDirectory.get(path.dirname(file)) ?? []).filter(source => {
        const name = path.basename(source);
        const sourceStem = name.slice(0, name.length - path.extname(name).length);
        return stem === name || stem === sourceStem || stem.startsWith(`${sourceStem}.`);
      }));
    }
  }

  static async read(root: string, inputs: readonly string[] = []) {
    root = path.resolve(root);
    const files = new Set<string>();
    const explicitStandaloneTests: string[] = [];
    const walk = async (candidate: string): Promise<void> => {
      const info = await stat(candidate);
      if (info.isFile()) { files.add(candidate); return; }
      if (!info.isDirectory() || EXCLUDED.has(path.basename(candidate))) return;
      const entries = await readdir(candidate, { withFileTypes: true });
      await Promise.all(entries.map(async entry => {
        if (entry.isFile()) files.add(path.join(candidate, entry.name));
        else if (entry.isDirectory() && !EXCLUDED.has(entry.name)) await walk(path.join(candidate, entry.name));
      }));
    };
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.all(entries.map(async entry => {
      if (entry.isFile()) files.add(path.join(root, entry.name));
      else if (entry.isDirectory() && ROOTS.includes(entry.name)) await walk(path.join(root, entry.name));
    }));
    for (const input of inputs) {
      const candidate = path.resolve(root, input);
      if (files.has(candidate) || candidate === root) continue;
      const info = await stat(candidate);
      // Explicit diagnostics are opt-in; neighbouring non-tests remain available as ownership context.
      if (info.isFile()) {
        files.add(candidate);
        if (TEST.test(candidate)) explicitStandaloneTests.push(candidate);
        const neighbours = await readdir(path.dirname(candidate), { withFileTypes: true });
        for (const entry of neighbours) {
          if (entry.isFile() && !TEST.test(entry.name)) files.add(path.join(path.dirname(candidate), entry.name));
        }
      } else {
        await walk(candidate);
      }
    }
    return new ProjectTestCatalog(root, [...files].sort(), explicitStandaloneTests);
  }

  validate() {
    const unmatched = this.tests.filter(file =>
      !this.explicitStandaloneTests.has(file) && !this.owners.get(file)?.length);
    if (unmatched.length) throw new Error(`Tests without colocated source owners:\n${unmatched.map(file => path.relative(this.root, file)).join("\n")}`);
  }

  select(inputs: readonly string[] = []) {
    if (!inputs.length) return [...this.tests];
    const paths = inputs.map(input => path.resolve(this.root, input));
    return this.tests.filter(file => paths.some(input => file === input || file.startsWith(`${input}${path.sep}`)));
  }

  companions(sources: Iterable<string>) {
    const selected = new Set(sources);
    return this.tests.filter(file => this.owners.get(file)?.some(owner => selected.has(owner)));
  }
}
