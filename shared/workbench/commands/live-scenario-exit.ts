/*
 * Exports:
 * - LiveScenarioExit: the line a streamed live scenario ends with, carrying its exit code, since the stream's HTTP status is
 *   sent before the scenario runs; formatting it and reading it back.
 */
const EXIT_LINE = /\[workbench live scenario exit (\d+)\]\s*$/u;

export namespace LiveScenarioExit {
  export function format(exitCode: number) {
    return `\n[workbench live scenario exit ${exitCode}]\n`;
  }

  /** The exit code `output` ends with; null when it ends without one, as a broken-off stream does. */
  export function read(output: string): number | null {
    const match = EXIT_LINE.exec(output);
    return match ? Number(match[1]) : null;
  }
}
