/*
 * Exports:
 * - dim/bold/green/yellow/red: ANSI styling for process log lines (status words coloured, secondary detail dim).
 */
const RESET = "\u001b[0m";

export function dim(value: string) { return `\u001b[2m${value}${RESET}`; }
export function bold(value: string) { return `\u001b[1m${value}${RESET}`; }
export function green(value: string) { return `\u001b[32m${value}${RESET}`; }
export function yellow(value: string) { return `\u001b[33m${value}${RESET}`; }
export function red(value: string) { return `\u001b[31m${value}${RESET}`; }
