/*
 * Exports:
 * - withExecRootMarker: make a sandboxed Windows pwsh command report its own process first.
 * - ExecRootMarkerScan/readExecRootMarker: read that report from the start of a command's stderr.
 *
 * Sandboxed commands run under another account, outside any job Workbench owns, so a hard-killed daemon cannot end
 * them. Each shell names its own root process so the next executor generation can find and stop what survived.
 */

/** Writes `<!--wb-exec-root <pid> <start FILETIME UTC>-->` and a newline to stderr, inside the same shell process. */
const WINDOWS_EXEC_ROOT_MARKER_SCRIPT = "[Console]::Error.WriteLine('<!--wb-exec-root ' + $PID + ' ' + (Get-Process -Id $PID).StartTime.ToFileTimeUtc() + '-->');";

/** Prefixes a Windows `pwsh … -Command <script>` with the marker statement; other commands run unchanged. */
export function withExecRootMarker(argv: readonly string[], platform: NodeJS.Platform): string[] {
  if (platform !== "win32" || argv.length < 3) return [...argv];
  const executable = argv[0]!.replace(/^.*[\\/]/u, "").toLowerCase();
  if ((executable !== "pwsh" && executable !== "pwsh.exe") || argv.at(-2)?.toLowerCase() !== "-command") return [...argv];
  return [...argv.slice(0, -1), `${WINDOWS_EXEC_ROOT_MARKER_SCRIPT} ${argv.at(-1)}`];
}

const PREFIX = "<!--wb-exec-root ";
const MARKER = /^<!--wb-exec-root (\d{1,10}) (\d{1,20})-->\r?\n/u;
/** What may follow the prefix while the marker line is still arriving. */
const PARTIAL = /^\d{0,10}(?: \d{0,20}(?:-(?:-(?:>\r?)?)?)?)?$/u;

export type ExecRootMarkerScan =
  | { kind: "incomplete" }
  | { kind: "absent" }
  /** `startedAt` stays text: FILETIME ticks exceed JavaScript's exact integers. */
  | { kind: "found"; pid: number; startedAt: string; rest: string };

export function readExecRootMarker(text: string): ExecRootMarkerScan {
  const match = MARKER.exec(text);
  if (match) return { kind: "found", pid: Number(match[1]), startedAt: match[2]!, rest: text.slice(match[0].length) };
  const arriving = PREFIX.startsWith(text) || (text.startsWith(PREFIX) && PARTIAL.test(text.slice(PREFIX.length)));
  return arriving ? { kind: "incomplete" } : { kind: "absent" };
}
