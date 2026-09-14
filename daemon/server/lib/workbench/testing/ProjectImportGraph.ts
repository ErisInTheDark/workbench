/*
 * Exports:
 * - default ProjectImportGraph: index current runtime imports and traverse either direction.
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
