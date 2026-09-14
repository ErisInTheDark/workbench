/*
 * Exports:
 * - TestReloadNode: source ownership and child boundaries used for test selection.
 * - ClaimedTestSelection: selected files, affected scopes and outside-node sources.
 * - default ClaimedTestSelector: select companions from claims and current reload/import graphs.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { createGitignoreMatcher } from "workbench-shared/source-pattern-matcher";
import ProjectTestCatalog from "../../../../../test/ProjectTestCatalog";
import ProjectImportGraph from "./ProjectImportGraph";

export interface TestReloadNode {
  scope: string;
  sources: string;
  boundarySources?: string;
  children: readonly TestReloadNode[];
}

export interface ClaimedTestSelection {
  files: string[];
  scopes: string[];
  outsideSources: string[];
}

export default class ClaimedTestSelector {
  constructor(
    private readonly catalog: ProjectTestCatalog,
    private readonly graph: ProjectImportGraph,
    private readonly roots: readonly TestReloadNode[],
    private readonly modules: ReadonlyMap<string, string>,
  ) {}

  static async load(catalog: ProjectTestCatalog) {
    // This is a local, short-lived command process. Loading definitions never constructs a host.
    const require = createRequire(path.join(catalog.root, "daemon", "package.json"));
    const server = require(path.join(catalog.root, "daemon/server/daemon-root-node.ts")) as { default: { roots: TestReloadNode[] } };
    const app = require(path.join(catalog.root, "app/server/runtime/app-root-node.ts")) as { default: { roots: TestReloadNode[] } };
    const modules = new Map<string, string>();
    for (const loaded of Object.values(require.cache)) {
      const exported = loaded?.exports?.default as Partial<TestReloadNode> | undefined;
      if (loaded && exported && typeof exported.scope === "string" && Array.isArray(exported.children)) {
        modules.set(exported.scope, loaded.filename);
      }
    }
    return new ClaimedTestSelector(catalog, new ProjectImportGraph(catalog.root, catalog.sources), [...server.default.roots, ...app.default.roots], modules);
  }

  select(claims: readonly string[]): ClaimedTestSelection {
    this.catalog.validate();
    if (!claims.length) throw new Error("No live Workbench claims. Claim the intended files before running wb test.");
    const nodes = new Map<string, TestReloadNode>();
    const visit = (node: TestReloadNode) => {
      if (nodes.has(node.scope)) return;
      nodes.set(node.scope, node);
      node.children.forEach(visit);
    };
    this.roots.forEach(visit);
    const nodeFiles = new Set(this.modules.values());
    const owned = new Map<string, Set<string>>();
    const matchers = new Map<string, ReturnType<typeof createGitignoreMatcher>>();
    for (const node of nodes.values()) {
      const matcher = createGitignoreMatcher(`${node.sources}\n${node.boundarySources ?? ""}`);
      matchers.set(node.scope, matcher);
      const files = this.catalog.sources.filter(file => matcher.matches(path.relative(this.catalog.root, file)));
      const module = this.modules.get(node.scope);
      if (module) files.push(module);
      const stops = new Set([...nodeFiles].filter(file => file !== module));
      owned.set(node.scope, this.graph.closure(files, "imports", stops));
    }
    const selectedNodes = new Set<string>();
    const selectedSources = new Set<string>();
    const selectedTests = new Set<string>();
    const outsideSources = new Set<string>();
    const includeNode = (node: TestReloadNode) => {
      if (selectedNodes.has(node.scope)) return;
      selectedNodes.add(node.scope);
      const module = this.modules.get(node.scope);
      if (module) selectedSources.add(module);
      node.children.forEach(includeNode);
    };
    for (const claim of claims) {
      const absolute = path.resolve(this.catalog.root, claim);
      const relative = path.relative(this.catalog.root, absolute);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Claim escapes the Workbench repository: ${claim}`);
      }
      const matching = this.catalog.files.filter(file => file === absolute || file.startsWith(`${absolute}${path.sep}`));
      for (const node of nodes.values()) {
        if (matchers.get(node.scope)!.matchesPathOrDescendant(relative || ".")
          || [...owned.get(node.scope)!].some(file => file === absolute || file.startsWith(`${absolute}${path.sep}`))) {
          includeNode(node);
        }
      }
      for (const file of matching) {
        if (this.catalog.owners.has(file)) { selectedTests.add(file); continue; }
        selectedSources.add(file);
        if ([...owned.values()].some(files => files.has(file))) continue;
        outsideSources.add(file);
      }
    }
    // Reloading a consumer does not make its unchanged dependencies affected sources.
    this.catalog.companions(this.graph.closure(selectedSources, "importers")).forEach(file => selectedTests.add(file));
    if (!selectedTests.size) throw new Error("No tests match the current Workbench claims.");
    return { files: [...selectedTests].sort(), scopes: [...selectedNodes].sort(), outsideSources: [...outsideSources].sort() };
  }
}
