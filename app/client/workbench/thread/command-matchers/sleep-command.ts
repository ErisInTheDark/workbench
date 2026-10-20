/*
 * Exports:
 * - parseSleepCommandMs: the duration of a command that only sleeps (PowerShell Start-Sleep or its alias, POSIX sleep), or null.
 */

const UNIT_MS = { "": 1_000, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const POWERSHELL = /^(?:start-sleep|sleep)\s+(?:-(seconds|s|milliseconds|m)\s+)?(\d+(?:\.\d+)?)$/iu;
const POSIX = /^sleep\s+(\d+(?:\.\d+)?)([smhd]?)$/u;

/** Whole commands only: a sleep chained with other work is that work, not a sleep. */
export function parseSleepCommandMs(command: string): number | null {
  const text = command.trim();
  const posix = POSIX.exec(text);
  if (posix) return Math.round(Number(posix[1]) * UNIT_MS[posix[2] as keyof typeof UNIT_MS]);
  const powershell = POWERSHELL.exec(text);
  if (!powershell) return null;
  const milliseconds = /^m/iu.test(powershell[1] ?? "");
  return Math.round(Number(powershell[2]) * (milliseconds ? 1 : 1_000));
}
