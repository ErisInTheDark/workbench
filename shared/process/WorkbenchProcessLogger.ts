/*
 * Default export:
 * - WorkbenchProcessLogger: frame Workbench process lines, preserve producer styling, and derive producer-formatted views. Keywords: logging, ANSI, timestamp, stream.
 */
const ANSI_BLUE = "\u001b[34m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_GRAY = "\u001b[90m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_RED = "\u001b[31m";
const ANSI_RESET = "\u001b[0m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

type WorkbenchProcessLogDomain = "app" | "client" | "esbuild" | "http" | "orchestrator" | "runner" | "tailwind";

interface WorkbenchProcessLoggerOptions {
  color?: boolean;
  formatMessage?: (message: string) => string;
  now?: () => Date;
  writeError?: (value: string) => void;
  writeOutput?: (value: string) => void;
}

const domainColors: Record<WorkbenchProcessLogDomain, string> = {
  app: ANSI_CYAN,
  client: ANSI_RED,
  esbuild: ANSI_GREEN,
  http: ANSI_BLUE,
  orchestrator: ANSI_CYAN,
  runner: ANSI_YELLOW,
  tailwind: ANSI_YELLOW,
};

function timestamp(now: Date) {
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export default class WorkbenchProcessLogger {
  private readonly color: boolean;
  private readonly formatMessage: (message: string) => string;
  private readonly now: () => Date;
  private readonly writeError: (value: string) => void;
  private readonly writeOutput: (value: string) => void;

  constructor(options: WorkbenchProcessLoggerOptions = {}) {
    this.color = options.color ?? true;
    this.formatMessage = options.formatMessage ?? ((message) => message);
    this.now = options.now ?? (() => new Date());
    this.writeError = options.writeError ?? ((value) => process.stderr.write(value));
    this.writeOutput = options.writeOutput ?? ((value) => process.stdout.write(value));
  }

  line(domain: WorkbenchProcessLogDomain, message: string) {
    this.writeOutput(this.format(domain, message));
  }

  error(domain: WorkbenchProcessLogDomain, message: string) {
    this.writeError(this.format(domain, message));
  }

  withMessageFormatter(formatMessage: (message: string) => string) {
    const current = this.formatMessage;
    return new WorkbenchProcessLogger({
      color: this.color,
      formatMessage: (message) => formatMessage(current(message)),
      now: this.now,
      writeError: this.writeError,
      writeOutput: this.writeOutput,
    });
  }

  createLineStream(domain: WorkbenchProcessLogDomain, error = false, onLine: () => void = () => {}) {
    let buffered = "";
    const emit = (line: string) => {
      if (!line.trim()) return;
      onLine();
      if (error) this.error(domain, line);
      else this.line(domain, line);
    };
    return {
      flush: () => {
        if (buffered) emit(buffered);
        buffered = "";
      },
      write: (chunk: string | Buffer) => {
        const lines = `${buffered}${chunk.toString()}`.split(/\r\n|\n|\r/u);
        buffered = lines.pop() ?? "";
        for (const line of lines) emit(line);
      },
    };
  }

  private format(domain: WorkbenchProcessLogDomain, message: string) {
    const formattedMessage = this.formatMessage(message).trimEnd();
    const content = this.color ? formattedMessage : formattedMessage.replace(ANSI_PATTERN, "");
    return content.split(/\r\n|\n|\r/u).map((line) => {
      if (!this.color) return `${timestamp(this.now())} ${domain} ${line}\n`;
      return `${ANSI_GRAY}${timestamp(this.now())}${ANSI_RESET} ${domainColors[domain]}${domain}${ANSI_RESET} ${line}\n`;
    }).join("");
  }
}
