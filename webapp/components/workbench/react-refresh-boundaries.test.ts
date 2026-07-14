/*
 * Exports:
 * - No production exports; Node tests guard Workbench TSX modules against mixed React component and non-component runtime exports. Keywords: react, refresh, boundary, exports, HMR.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

type RuntimeExportKind = "component" | "value";

interface RuntimeExport {
  kind: RuntimeExportKind;
  name: string;
}

const workbenchComponentsDirectory = fileURLToPath(new URL(".", import.meta.url));

function readTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return readTsxFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith(".tsx") ? [entryPath] : [];
  });
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function isPascalCase(value: string) {
  return /^[A-Z]/u.test(value);
}

function isReactClass(node: ts.ClassLikeDeclaration) {
  return node.heritageClauses?.some((clause) => (
    clause.token === ts.SyntaxKind.ExtendsKeyword
    && clause.types.some((type) => /(?:^|\.)(?:Pure)?Component$/u.test(type.expression.getText()))
  )) ?? false;
}

function isComponentInitializer(initializer: ts.Expression | undefined, exportName: string) {
  if (!initializer) {
    return false;
  }

  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return isPascalCase(exportName);
  }

  if (ts.isClassExpression(initializer)) {
    return isReactClass(initializer);
  }

  if (!ts.isCallExpression(initializer)) {
    return false;
  }

  const calleeName = ts.isIdentifier(initializer.expression)
    ? initializer.expression.text
    : ts.isPropertyAccessExpression(initializer.expression)
      ? initializer.expression.name.text
      : "";
  return calleeName === "memo" || calleeName === "forwardRef";
}

function classifyDeclaration(statement: ts.Statement): RuntimeExport[] {
  if (ts.isFunctionDeclaration(statement)) {
    const name = statement.name?.text ?? "default";
    return [{ kind: isPascalCase(name) ? "component" : "value", name }];
  }

  if (ts.isClassDeclaration(statement)) {
    const name = statement.name?.text ?? "default";
    return [{ kind: isReactClass(statement) ? "component" : "value", name }];
  }

  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => {
      if (!ts.isIdentifier(declaration.name)) {
        return [];
      }

      const name = declaration.name.text;
      return [{
        kind: isComponentInitializer(declaration.initializer, name) ? "component" as const : "value" as const,
        name,
      }];
    });
  }

  if (ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
    return [{ kind: "value", name: statement.name.getText() }];
  }

  return [];
}

function getRuntimeExports(filePath: string) {
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const runtimeExports: RuntimeExport[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        continue;
      }

      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) {
          continue;
        }

        const name = element.name.text;
        runtimeExports.push({ kind: isPascalCase(name) ? "component" : "value", name });
      }
      continue;
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      runtimeExports.push({
        kind: isComponentInitializer(statement.expression, "Default") ? "component" : "value",
        name: "default",
      });
      continue;
    }

    if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      runtimeExports.push(...classifyDeclaration(statement));
    }
  }

  return runtimeExports;
}

test("Workbench TSX modules do not mix React component and non-component runtime exports", () => {
  const violations = readTsxFiles(workbenchComponentsDirectory).flatMap((filePath) => {
    const runtimeExports = getRuntimeExports(filePath);
    const hasComponents = runtimeExports.some((entry) => entry.kind === "component");
    const hasValues = runtimeExports.some((entry) => entry.kind === "value");
    if (!hasComponents || !hasValues) {
      return [];
    }

    return [{
      exports: runtimeExports.map((entry) => `${entry.kind}:${entry.name}`).join(", "),
      file: path.relative(workbenchComponentsDirectory, filePath).replaceAll("\\", "/"),
    }];
  });

  assert.deepEqual(violations, []);
});
