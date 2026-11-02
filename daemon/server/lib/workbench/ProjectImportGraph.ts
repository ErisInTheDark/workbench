/*
 * Exports:
 * - default ProjectImportGraph: index current runtime imports, traverse either direction, and explain how one file reaches another
 *   or where a closure first leaves an allowed set.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const CODE = /\.(?:[cm]?[jt]sx?)$/u;

export default class ProjectImportGraph {
  readonly imports = new Map<string, Set<string>>();
  readonly importers = new Map<string, Set<string>>();
  private readonly failures = new Map<string, string[]>();
  private readonly resolutionCache: ts.ModuleResolutionCache;
  private readonly options: ts.CompilerOptions = {
    allowJs: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true,
  };

  constructor(readonly root: string, files: readonly string[]) {
    this.resolutionCache = ts.createModuleResolutionCache(root, file => file, this.options);
    for (const file of files) this.read(file);
  }

  closure(roots: Iterable<string>, direction: "imports" | "importers" = "imports", stops: ReadonlySet<string> = new Set()) {
    const found = new Set<string>();
    const visit = (file: string) => {
      if (found.has(file) || stops.has(file)) return;
      found.add(file);
      for (const next of this[direction].get(file) ?? []) visit(next);
    };
    for (const file of roots) visit(file);
    const errors = [...found].flatMap(file => (this.failures.get(file) ?? []).map(specifier => `${path.relative(this.root, file)} -> ${specifier}`));
    if (errors.length) throw new Error(`Unresolved local imports:\n${errors.join("\n")}`);
    return found;
  }

  /** The shortest runtime import path from `from` to `to`, both included; null when `to` is unreachable. */
  chain(from: string, to: string): string[] | null {
    const previous = new Map<string, string | null>([[from, null]]);
    const queue = [from];
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      if (file === to) {
        const path: string[] = [];
        for (let step: string | null = to; step !== null; step = previous.get(step) ?? null) path.unshift(step);
        return path;
      }
      for (const next of this.imports.get(file) ?? []) {
        if (previous.has(next)) continue;
        previous.set(next, file);
        queue.push(next);
      }
    }
    return null;
  }

  /** Where `entry`'s runtime imports first leave `inside`: the chain to each first outside file, and how many outside files it brings. */
  crossings(entry: string, inside: ReadonlySet<string>) {
    const crossings = new Map<string, { chain: string[]; pulled: number }>();
    for (const file of this.closure([entry])) {
      if (inside.has(file)) continue;
      const chain = this.chain(entry, file)!;
      const first = chain.findIndex(step => !inside.has(step));
      const crossing = crossings.get(chain[first]!) ?? { chain: chain.slice(0, first + 1), pulled: 0 };
      crossing.pulled += 1;
      crossings.set(chain[first]!, crossing);
    }
    return [...crossings.values()];
  }

  private read(file: string) {
    if (this.imports.has(file)) return;
    const edges = new Set<string>();
    this.imports.set(file, edges);
    if (!CODE.test(file) || /\.d\.[cm]?ts$/u.test(file)) return;
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const specifiers: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const erased = clause?.isTypeOnly || (clause && !clause.name && bindings && ts.isNamedImports(bindings)
          && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly));
        if (!erased) specifiers.push(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const erased = node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0
          && node.exportClause.elements.every(element => element.isTypeOnly);
        if (!erased) specifiers.push(node.moduleSpecifier.text);
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
        specifiers.push(node.moduleReference.expression.text);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of specifiers) {
      const resolved = ts.resolveModuleName(specifier, file, this.options, ts.sys, this.resolutionCache).resolvedModule;
      let target = resolved?.resolvedFileName;
      if (!target && specifier.startsWith(".")) {
        const candidate = path.resolve(path.dirname(file), specifier);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) target = candidate;
      }
      if (!target) {
        if (specifier.startsWith(".") || specifier.startsWith("workbench-shared/")) {
          const errors = this.failures.get(file) ?? [];
          errors.push(specifier);
          this.failures.set(file, errors);
        }
        continue;
      }
      target = fs.realpathSync(target);
      const relative = path.relative(this.root, target);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(path.sep).includes("node_modules")) continue;
      edges.add(target);
      const dependants = this.importers.get(target) ?? new Set<string>();
      dependants.add(file);
      this.importers.set(target, dependants);
      this.read(target);
    }
  }
}
