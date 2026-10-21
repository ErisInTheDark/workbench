/*
 * Exports:
 * - PseudoTerminalProcess: a child running in a pseudo-terminal: its output, input, exit and termination.
 * - default spawnPseudoTerminal: run an executable in a pseudo-terminal for programs that only prompt when they see a TTY.
 */
export interface PseudoTerminalProcess {
  onOutput(listener: (text: string) => void): void;
  write(text: string): void;
  /** Resolves with the exit code once the child exits. */
  exited: Promise<number>;
  kill(): void;
}

/** Loaded on first use, so a platform without a prebuilt binary fails only the caller that needs a terminal. */
export default async function spawnPseudoTerminal(file: string, args: string[], options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Wide enough that printed links never wrap. */
  cols?: number;
}): Promise<PseudoTerminalProcess> {
  let pty: typeof import("@lydell/node-pty");
  try { pty = await import("@lydell/node-pty"); }
  catch (error) {
    throw new Error(`This daemon's platform has no pseudo-terminal support: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
  const child = pty.spawn(file, args, { name: "xterm-256color", cols: options.cols ?? 4000, rows: 40, cwd: options.cwd, env: options.env });
  let running = true;
  const exited = new Promise<number>(resolve => {
    child.onExit(({ exitCode }) => {
      running = false;
      // ConPTY keeps its pipes and output worker open after the child exits until the terminal is killed.
      if (process.platform === "win32") {
        try { child.kill(); }
        catch (error) { console.warn(`[pseudo-terminal] ConPTY release failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`); }
      }
      resolve(exitCode);
    });
  });
  return {
    onOutput: listener => { child.onData(listener); },
    write: text => { if (running) child.write(text); },
    exited,
    kill: () => { if (running) child.kill(); },
  };
}
