/*
 * Default export:
 * - WorkbenchAppLogger: format app-owned terminal lines and frame child-process output by line. Keywords: logging, ANSI, timestamp, stream.
 */
const ANSI_BLUE = "\u001b[34m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_GRAY = "\u001b[90m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_MAGENTA = "\u001b[35m";
const ANSI_RESET = "\u001b[0m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const DURATION_PATTERN = /(?<![\p{L}\p{N}_])(\d+(?:\.\d+)?(?:µs|ms|s))(?![\p{L}\p{N}_])/gu;

type WorkbenchAppLogDomain = "app" | "esbuild" | "http" | "tailwind";

interface WorkbenchAppLoggerOptions {
  color?: boolean;
  now?: () => Date;
  writeError?: (value: string) => void;
  writeOutput?: (value: string) => void;
}

const domainColors: Record<WorkbenchAppLogDomain, string> = {
  app: ANSI_CYAN,
  esbuild: ANSI_GREEN,
  http: ANSI_BLUE,
  tailwind: ANSI_YELLOW,
};

function timestamp(now: Date) {
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export default class WorkbenchAppLogger {
  private readonly color: boolean;
  private readonly now: () => Date;
  private readonly writeError: (value: string) => void;
  private readonly writeOutput: (value: string) => void;

  constructor(options: WorkbenchAppLoggerOptions = {}) {
    this.color = options.color ?? !("NO_COLOR" in process.env);
    this.now = options.now ?? (() => new Date());
    this.writeError = options.writeError ?? ((value) => process.stderr.write(value));
    this.writeOutput = options.writeOutput ?? ((value) => process.stdout.write(value));
  }

  line(domain: WorkbenchAppLogDomain, message: string) {
    this.writeOutput(this.format(domain, message));
  }

  error(domain: WorkbenchAppLogDomain, message: string) {
    this.writeError(this.format(domain, message));
  }

  createLineStream(domain: WorkbenchAppLogDomain, error = false) {
    let buffered = "";
    const emit = (line: string) => {
      if (!line.trim()) return;
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

  private format(domain: WorkbenchAppLogDomain, message: string) {
    const cleanMessage = message.replace(ANSI_PATTERN, "").trimEnd();
    if (!this.color) return `${timestamp(this.now())} ${domain} ${cleanMessage}\n`;
    const coloredMessage = cleanMessage.replace(
      DURATION_PATTERN,
      `${ANSI_MAGENTA}$1${ANSI_RESET}`,
    );
    return `${ANSI_GRAY}${timestamp(this.now())}${ANSI_RESET} ${domainColors[domain]}${domain}${ANSI_RESET} ${coloredMessage}\n`;
  }
}
