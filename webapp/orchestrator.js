const { spawn, spawnSync } = require("node:child_process");
const APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4500";
const NEXT_PORT = process.env.PORT ?? "3002";
const RESTART_DELAY_MS = 1000;

const processes = new Map();
let shuttingDown = false;

const specs = [
  {
    name: "codex-app-server",
    command: "pnpm",
    args: ["run", "dev:app-server"],
    env: {
      CODEX_APP_SERVER_URL: APP_SERVER_URL,
    },
  },
  {
    name: "next-dev",
    command: "pnpm",
    args: ["run", "dev:next"],
    env: {
      CODEX_APP_SERVER_URL: APP_SERVER_URL,
      NEXT_PUBLIC_CODEX_APP_SERVER_URL: APP_SERVER_URL,
      PORT: NEXT_PORT,
    },
  },
];

function log(name, message) {
  process.stdout.write(`[${name}] ${message}\n`);
}

function logError(name, message) {
  process.stderr.write(`[${name}] ${message}\n`);
}

function pipeChildStream(name, stream, write) {
  if (!stream) {
    return;
  }

  stream.on("data", (chunk) => {
    write(chunk);
  });
}

function quoteWindowsCommandPart(part) {
  if (!part.length) {
    return '""';
  }

  if (!/[\s"]/u.test(part)) {
    return part;
  }

  return `"${part.replace(/"/g, '\\"')}"`;
}

function getSpawnDescriptor(spec) {
  if (process.platform !== "win32") {
    return {
      command: spec.command,
      args: spec.args,
    };
  }

  const commandLine = [spec.command, ...spec.args]
    .map((part) => quoteWindowsCommandPart(part))
    .join(" ");

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

function killProcessTree(pid) {
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
}

function stopAllChildren() {
  for (const entry of processes.values()) {
    if (entry.child && !entry.child.killed) {
      killProcessTree(entry.child.pid);
    }
  }
}

function scheduleRestart(spec) {
  if (shuttingDown) {
    return;
  }

  const existing = processes.get(spec.name);
  if (existing?.restartTimer) {
    return;
  }

  const restartTimer = setTimeout(() => {
    const latest = processes.get(spec.name);
    if (latest) {
      latest.restartTimer = null;
    }
    startChild(spec);
  }, RESTART_DELAY_MS);

  processes.set(spec.name, {
    ...(existing ?? {}),
    restartTimer,
  });
}

function startChild(spec) {
  const spawnDescriptor = getSpawnDescriptor(spec);
  const child = spawn(spawnDescriptor.command, spawnDescriptor.args, {
    cwd: __dirname,
    env: {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
      ...spec.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
    detached: process.platform !== "win32",
  });

  processes.set(spec.name, {
    child,
    restartTimer: null,
  });

  pipeChildStream(spec.name, child.stdout, (chunk) => process.stdout.write(chunk));
  pipeChildStream(spec.name, child.stderr, (chunk) => process.stderr.write(chunk));

  child.once("error", (error) => {
    logError(spec.name, `failed to start: ${error instanceof Error ? error.message : String(error)}`);
  });

  child.once("exit", (code, signal) => {
    log(spec.name, `exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);

    const existing = processes.get(spec.name);
    processes.set(spec.name, {
      child: null,
      restartTimer: existing?.restartTimer ?? null,
    });

    if (!shuttingDown) {
      scheduleRestart(spec);
    }
  });
}

function shutdownAndExit(exitCode, error) {
  if (shuttingDown) {
    if (error) {
      logError("orchestrator", error instanceof Error ? error.stack ?? error.message : String(error));
    }
    process.exit(exitCode);
    return;
  }

  shuttingDown = true;
  if (error) {
    logError("orchestrator", error instanceof Error ? error.stack ?? error.message : String(error));
  }

  stopAllChildren();
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdownAndExit(0));
}

process.on("uncaughtException", (error) => shutdownAndExit(1, error));
process.on("unhandledRejection", (reason) => shutdownAndExit(1, reason));
process.on("exit", () => {
  shuttingDown = true;
  stopAllChildren();
});

log("orchestrator", `starting codex app-server at ${APP_SERVER_URL} and Next.js on port ${NEXT_PORT}`);
for (const spec of specs) {
  startChild(spec);
}
