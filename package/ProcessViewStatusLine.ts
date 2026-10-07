/*
 * Exports:
 * - ProcessViewStatusLineOutput: minimal TTY write/measure seam for the pinned bar.
 * - default ProcessViewStatusLine: own the pinned bottom keybind bar without mixing escapes into streamed logs.
 */
const ANSI_PATTERN = /\u001b\[[0-9;]*m/gu;

export interface ProcessViewStatusLineOutput {
  readonly isTTY?: boolean;
  readonly rows?: number;
  readonly columns?: number;
  write(text: string): unknown;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}

function visibleLength(text: string) {
  return text.replace(ANSI_PATTERN, "").length;
}

export default class ProcessViewStatusLine {
  private installed = false;
  private text = "";

  constructor(private readonly output: ProcessViewStatusLineOutput) {}

  get enabled() {
    const { isTTY, rows } = this.output;
    return Boolean(isTTY && typeof rows === "number" && rows >= 3);
  }

  install() {
    if (this.installed || !this.enabled) return;
    this.installed = true;
    this.output.on?.("resize", this.handleResize);
    // Reserve the final row as the bar so log output only scrolls above it.
    this.output.write("\u001b[?25l");
    this.output.write(this.region());
    this.output.write(`\u001b[${this.rows() - 1};1H`);
    this.draw();
  }

  update(text: string) {
    this.text = text;
    if (this.installed) this.draw();
  }

  notice(text: string) {
    // A partial log line may own the cursor; start the notice on a fresh line.
    this.output.write(`\n${text.replace(/\r?\n$/u, "")}\n`);
    if (this.installed) this.draw();
  }

  close() {
    if (!this.installed) return;
    this.installed = false;
    this.output.off?.("resize", this.handleResize);
    this.output.write("\u001b[r");
    this.output.write(`\u001b[${this.rows()};1H\u001b[2K`);
    this.output.write("\u001b[?25h");
  }

  private rows() {
    return Math.max(3, this.output.rows ?? 24);
  }

  private columns() {
    return Math.max(20, this.output.columns ?? 80);
  }

  private region() {
    return `\u001b[1;${this.rows() - 1}r`;
  }

  private readonly handleResize = () => {
    if (!this.installed) return;
    this.output.write(this.region());
    this.output.write(`\u001b[${this.rows() - 1};1H`);
    this.draw();
  };

  private draw() {
    this.output.write(`\u001b7\u001b[${this.rows()};1H\u001b[2K${this.fit(this.text)}\u001b8`);
  }

  /** Drop whole segments so ANSI never splits and the bar never wraps onto the log region. */
  private fit(text: string) {
    if (visibleLength(text) <= this.columns()) return text;
    const segments = text.split("  ");
    let fitted = "";
    for (const segment of segments) {
      const candidate = fitted ? `${fitted}  ${segment}` : segment;
      if (visibleLength(candidate) > this.columns()) break;
      fitted = candidate;
    }
    return fitted;
  }
}
