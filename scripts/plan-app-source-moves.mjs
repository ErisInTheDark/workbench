/*
 * Build a deterministic, executable `wb git arc mv --map` plan that moves
 * browser-only Workbench source into app and browser/daemon source into shared.
 */
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const repositoryRoot = process.cwd();
const require = createRequire(import.meta.url);
const typescriptPath = require.resolve("typescript", { paths: [path.join(repositoryRoot, "app")] });
const ts = require(typescriptPath);
const sourceRoots = ["app", "shared", "webapp"];
const ignoredDirectoryNames = new Set([".next", "node_modules", "target"]);
const codeFilePattern = /\.[cm]?[jt]sx?$/u;
const testFilePattern = /\.(?:spec|test)\.[cm]?[jt]sx?$/u;
const extensionCandidates = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const maxMappingsPerCommand = 200;
const maxCommandLength = 24_000;

function normalisePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function repositoryPath(absolutePath) {
  return normalisePath(path.relative(repositoryRoot, absolutePath));
}

async function collectFiles(directoryPath) {
  const files = [];
  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue;
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(entryPath));
    else if (entry.isFile()) files.push(repositoryPath(entryPath));
  }
  return files;
}

function importedModuleSpecifiers(sourceFile) {
  const specifiers = [];
  const addStringLiteral = (node) => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addStringLiteral(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addStringLiteral(node.argument.literal);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) addStringLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function workspacePackagePath(specifier) {
  if (specifier.startsWith("workbench-shared/")) return `shared/${specifier.slice("workbench-shared/".length)}`;
  if (specifier.startsWith("workbench/")) return `webapp/${specifier.slice("workbench/".length)}`;
  return null;
}

function resolutionCandidates(sourcePath, specifier) {
  const packagePath = workspacePackagePath(specifier);
  const cleanSpecifier = specifier.split(/[?#]/u, 1)[0];
  if (!packagePath && !cleanSpecifier.startsWith(".")) return [];
  const base = packagePath
    ? path.resolve(repositoryRoot, packagePath)
    : path.resolve(repositoryRoot, path.dirname(sourcePath), cleanSpecifier);
  const extension = path.extname(base);
  const candidates = [base];
  if (!extension) {
    candidates.push(
      ...extensionCandidates.map((candidate) => `${base}${candidate}`),
      ...extensionCandidates.map((candidate) => path.join(base, `index${candidate}`)),
    );
  } else if (/^\.m?[cm]?jsx?$/u.test(extension)) {
    const withoutExtension = base.slice(0, -extension.length);
    candidates.push(...extensionCandidates.map((candidate) => `${withoutExtension}${candidate}`));
  }
  return candidates.map(repositoryPath);
}

function resolveImport(sourcePath, specifier, knownFiles) {
  return resolutionCandidates(sourcePath, specifier).find((candidate) => knownFiles.has(candidate)) ?? null;
}

function transitiveClosure(graph, roots) {
  const visited = new Set();
  const pending = [...roots];
  while (pending.length) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const dependency of graph.get(current) ?? []) pending.push(dependency);
  }
  return visited;
}

function destinationFor(source, owner) {
  if (source.startsWith("webapp/components/")) {
    if (owner !== "app") throw new Error(`Frontend component has mixed ownership: ${source}`);
    return `app/components/${source.slice("webapp/components/".length)}`;
  }
  if (source.startsWith("webapp/lib/")) {
    return `${owner}/${source.slice("webapp/lib/".length)}`;
  }
  throw new Error(`Frontend dependency has no move rule: ${source}`);
}

function sidecarSource(testPath, knownFiles) {
  const sourcePath = testPath.replace(/\.(?:spec|test)(\.[cm]?[jt]sx?)$/u, "$1");
  return knownFiles.has(sourcePath) ? sourcePath : null;
}

function quoteShellArgument(value) {
  if (/['\r\n]/u.test(value)) {
    throw new Error(`Path cannot be emitted safely for both PowerShell and POSIX shells: ${value}`);
  }
  return `'${value}'`;
}

function commandFor(mappings) {
  return [
    "wb git arc mv",
    ...mappings.flatMap(({ destination, source }) => [
      "--map",
      quoteShellArgument(source),
      quoteShellArgument(destination),
    ]),
  ].join(" ");
}

function commandBatches(mappings) {
  const batches = [];
  let current = [];
  for (const mapping of mappings) {
    const candidate = [...current, mapping];
    if (
      current.length > 0
      && (candidate.length > maxMappingsPerCommand || commandFor(candidate).length > maxCommandLength)
    ) {
      batches.push(current);
      current = [mapping];
    } else {
      current = candidate;
    }
    if (commandFor(current).length > maxCommandLength) {
      throw new Error(`One move mapping exceeds the command length limit: ${mapping.source}`);
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

async function main() {
  if (process.argv.length !== 2) throw new Error("This script does not accept arguments.");

  const files = (await Promise.all(
    sourceRoots.map((sourceRoot) => collectFiles(path.join(repositoryRoot, sourceRoot))),
  )).flat().sort();
  const knownFiles = new Set(files);
  const codeFiles = files.filter((file) => codeFilePattern.test(file));
  const graph = new Map();
  const unresolvedImports = [];

  for (const sourcePath of codeFiles) {
    const source = await readFile(path.join(repositoryRoot, sourcePath), "utf8");
    const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
    const dependencies = new Set();
    for (const specifier of importedModuleSpecifiers(sourceFile)) {
      const candidates = resolutionCandidates(sourcePath, specifier);
      if (!candidates.length) continue;
      const resolved = resolveImport(sourcePath, specifier, knownFiles);
      if (resolved) dependencies.add(resolved);
      else unresolvedImports.push(`${sourcePath} -> ${specifier}`);
    }
    graph.set(sourcePath, dependencies);
  }

  if (unresolvedImports.length) {
    throw new Error(`Unresolved local imports:\n${unresolvedImports.sort().join("\n")}`);
  }

  const componentRoots = codeFiles.filter((file) => (
    file.startsWith("webapp/components/") && !testFilePattern.test(file)
  ));
  const frontendRoots = ["app/browser-entry.tsx", ...componentRoots];
  if (!knownFiles.has(frontendRoots[0])) throw new Error(`Frontend entry is missing: ${frontendRoots[0]}`);
  const frontendClosure = transitiveClosure(graph, frontendRoots);
  const frontendWebappFiles = [...frontendClosure].filter((file) => file.startsWith("webapp/"));
  const daemonRoots = codeFiles.filter((file) => (
    file.startsWith("webapp/")
    && !frontendClosure.has(file)
    && !file.startsWith("webapp/components/")
    && !testFilePattern.test(file)
  ));
  const daemonClosure = transitiveClosure(graph, daemonRoots);
  const owners = new Map();

  for (const source of frontendWebappFiles) {
    const owner = daemonClosure.has(source) ? "shared" : "app";
    if (source.startsWith("webapp/components/") && owner === "shared") {
      throw new Error(`Daemon source imports a frontend component: ${source}`);
    }
    owners.set(source, owner);
  }

  for (const source of files.filter((file) => file.startsWith("webapp/components/"))) {
    owners.set(source, "app");
  }

  const testFiles = codeFiles.filter((file) => file.startsWith("webapp/lib/") && testFilePattern.test(file));
  for (const testFile of testFiles) {
    const sidecar = sidecarSource(testFile, knownFiles);
    if (sidecar && owners.has(sidecar)) {
      owners.set(testFile, owners.get(sidecar));
      continue;
    }
    const testClosure = transitiveClosure(graph, [testFile]);
    const referencedOwners = new Set(
      [...testClosure].map((file) => owners.get(file)).filter(Boolean),
    );
    const reachesDaemon = [...testClosure].some((file) => (
      file.startsWith("webapp/")
      && !testFilePattern.test(file)
      && !owners.has(file)
    ));
    if (!reachesDaemon && referencedOwners.has("app")) owners.set(testFile, "app");
    else if (!reachesDaemon && referencedOwners.size === 1 && referencedOwners.has("shared")) {
      owners.set(testFile, "shared");
    }
  }

  const mappings = [...owners]
    .map(([source, owner]) => ({ destination: destinationFor(source, owner), owner, source }))
    .sort((left, right) => left.source.localeCompare(right.source));
  const destinations = new Map();
  for (const mapping of mappings) {
    const previousSource = destinations.get(mapping.destination);
    if (previousSource) {
      throw new Error(`Duplicate destination ${mapping.destination}: ${previousSource}, ${mapping.source}`);
    }
    if (knownFiles.has(mapping.destination)) {
      throw new Error(`Move destination already exists: ${mapping.source} -> ${mapping.destination}`);
    }
    destinations.set(mapping.destination, mapping.source);
  }

  const unmappedFrontendFiles = frontendWebappFiles.filter((file) => !owners.has(file));
  if (unmappedFrontendFiles.length) {
    throw new Error(`Frontend files remain under webapp:\n${unmappedFrontendFiles.sort().join("\n")}`);
  }

  const batches = commandBatches(mappings);
  for (const batch of batches) process.stdout.write(`${commandFor(batch)}\n`);

  const appCount = mappings.filter(({ owner }) => owner === "app").length;
  const sharedCount = mappings.length - appCount;
  console.error(
    [
      `planned ${mappings.length} moves in ${batches.length} commands`,
      `app: ${appCount}`,
      `shared: ${sharedCount}`,
      `largest command: ${Math.max(...batches.map((batch) => commandFor(batch).length))} characters`,
      `largest batch: ${Math.max(...batches.map((batch) => batch.length))} mappings`,
    ].join("\n"),
  );
}

await main();
