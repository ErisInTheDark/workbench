/*
 * Exports:
 * - getPackageScriptPrefix: derive an exact script invocation prefix without trailing script arguments.
 */
interface Runner {
  commands: readonly string[];
  shortcuts?: readonly string[];
  builtins?: readonly string[];
  switches: readonly string[];
  values: readonly string[];
}

const runners: Readonly<Record<string, Runner>> = {
  npm: {
    commands: ["run", "run-script"], shortcuts: ["test", "t", "tst", "start", "stop", "restart"],
    switches: ["--silent", "-s", "--if-present", "--ignore-scripts", "--workspaces", "-ws", "--include-workspace-root", "--foreground-scripts"],
    values: ["--prefix", "--workspace", "-w", "--script-shell", "--loglevel"],
  },
  pnpm: {
    commands: ["run", "run-script"],
    builtins: "add approve-builds audit bin cache cat-file cat-index completion config create dedupe deploy dlx doctor env exec fetch find-hash help import init install i link list ls outdated pack patch patch-commit patch-remove prune publish rebuild remove rm uninstall unlink update up upgrade self-update server setup store why root".split(" "),
    switches: ["--silent", "-s", "--recursive", "-r", "--parallel", "--stream", "--aggregate-output", "--if-present", "--workspace-root", "-w", "--reverse", "--no-sort", "--sort", "--report-summary"],
    values: ["--dir", "-C", "--filter", "-F", "--filter-prod", "--workspace-concurrency", "--reporter", "--resume-from", "--config.script-shell"],
  },
  yarn: {
    commands: ["run"],
    builtins: "add audit autoclean bin cache check config constraints create dedupe dlx exec generate-lock-entry global help import info init install licenses link list login logout node npm offline-mirror outdated owner pack patch patch-commit plugin policies rebuild remove set stage tag team unlink unplug up upgrade upgrade-interactive version versions why workspace workspaces".split(" "),
    switches: ["--silent", "-s", "--ignore-engines", "--ignore-platform", "--top-level", "-T", "--binaries-only", "-B"],
    values: ["--cwd", "--mutex", "--use-yarnrc"],
  },
  bun: {
    commands: ["run"],
    builtins: "add audit build completions create exec help info init install i link outdated patch patch-commit pm publish remove repl test unlink update upgrade x".split(" "),
    switches: ["--silent", "--if-present", "--bun", "--hot", "--watch", "--smol"],
    values: ["--cwd", "--filter", "--env-file", "--config", "-c", "--shell"],
  },
  node: { commands: ["--run"], switches: [], values: [] },
  deno: {
    commands: ["task"], switches: ["--quiet", "-q", "--no-config", "--no-check", "--recursive", "-r"],
    values: ["--cwd", "--config", "-c", "--filter", "--env-file"],
  },
  composer: {
    commands: ["run-script", "run"],
    switches: ["--no-interaction", "-n", "--quiet", "-q", "--verbose", "-v", "-vv", "-vvv", "--no-plugins", "--no-scripts", "--dev", "--no-dev"],
    values: ["--working-dir", "-d", "--timeout"],
  },
};

function executableName(value: string) {
  return value.replaceAll("\\", "/").split("/").at(-1)!.replace(/\.(exe|cmd|bat|ps1)$/iu, "").toLowerCase();
}

function skipOptions(argv: readonly string[], start: number, runner: Runner) {
  let index = start;
  while (argv[index]?.startsWith("-")) {
    const token = argv[index]!;
    const equals = token.indexOf("=");
    const key = equals < 0 ? token : token.slice(0, equals);
    if (runner.switches.includes(key) && equals < 0) index += 1;
    else if (runner.values.includes(key)) {
      if (equals >= 0) {
        if (!token.slice(equals + 1)) return null;
        index += 1;
      } else {
        if (!argv[index + 1] || argv[index + 1]!.startsWith("-")) return null;
        index += 2;
      }
    } else return null;
  }
  return index;
}

export function getPackageScriptPrefix(argv: readonly string[]): string[] | null {
  if (!argv.length) return null;
  let index = 1;
  let name = executableName(argv[0]!);
  if (name === "corepack") {
    name = executableName(argv[index++] ?? "").replace(/@.+$/u, "");
    if (!["npm", "pnpm", "yarn"].includes(name)) return null;
  }
  const runner = runners[name];
  if (!runner) return null;
  // --run is itself Node's dispatch flag, not a general runtime-option parser.
  if (name === "node") {
    const token = argv[index];
    if (token?.startsWith("--run=")) return token.length > 6 ? argv.slice(0, index + 1) : null;
    if (token !== "--run") return null;
  } else {
    const next = skipOptions(argv, index, runner);
    if (next === null) return null;
    index = next;
  }
  const verb = argv[index];
  if (!verb) return null;
  if (runner.shortcuts?.includes(verb)) return argv.slice(0, index + 1);
  if (runner.commands.includes(verb)) {
    const next = skipOptions(argv, index + 1, runner);
    if (next === null) return null;
    index = next;
  } else if (!runner.builtins || runner.builtins.includes(verb)) return null;
  const script = argv[index];
  if (!script || script.startsWith("-") || /[/\\*?]/u.test(script) || (name === "bun" && /\.(?:[cm]?[jt]sx?|wasm)$/iu.test(script))) return null;
  return argv.slice(0, index + 1);
}
