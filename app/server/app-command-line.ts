/*
 * Exports:
 * - readWorkbenchAppCommandLine: admit standalone app CLI and environment port configuration.
 */
import { parseArgs } from "node:util";

function configuredPort(value: string | undefined) {
  if (!value?.trim()) return null;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Workbench app port must be an integer from 0 through 65535.");
  }
  return port;
}

export function readWorkbenchAppCommandLine(
  argumentsList = process.argv.slice(2),
  environmentPort = process.env.WORKBENCH_APP_PORT,
) {
  const { tokens, values } = parseArgs({
    allowPositionals: false,
    args: argumentsList,
    options: { port: { type: "string" } },
    strict: true,
    tokens: true,
  });
  if (tokens.filter((token) => token.kind === "option" && token.name === "port").length > 1) {
    throw new Error("Workbench app port may be provided only once.");
  }
  return { port: configuredPort(values.port ?? environmentPort) };
}
