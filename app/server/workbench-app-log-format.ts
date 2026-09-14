/*
 * Exports:
 * - formatWorkbenchAppLogMessage: colour durations in app-produced process messages. Keywords: app, logging, ANSI, duration.
 */
const ANSI_MAGENTA = "\u001b[35m";
const ANSI_RESET = "\u001b[0m";
const DURATION_PATTERN = /(?<![\p{L}\p{N}_])(\d+(?:\.\d+)?(?:\u00b5s|ms|s))(?![\p{L}\p{N}_])/gu;

export function formatWorkbenchAppLogMessage(message: string) {
  return message.replace(DURATION_PATTERN, `${ANSI_MAGENTA}$1${ANSI_RESET}`);
}
