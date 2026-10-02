/*
 * Exports:
 * - RipgrepOutputMode/RipgrepCaseMode: what a wb rg query prints and how it treats letter case.
 * - RipgrepQuery: typed, structured-clone-safe rg-compatible search request.
 * - RipgrepArgumentsResult: parsed query or user-facing rejection message.
 * - RIPGREP_DEFAULT_MAX_RESULTS/RIPGREP_DEFAULT_MAX_FILESIZE: Workbench guard defaults.
 * - RIPGREP_HELP_TEXT: supported-flag summary printed by --help.
 * - parseRipgrepArguments: parse rg-style argument vectors, rejecting unsupported flags.
 */
import { RIPGREP_FILE_TYPES } from "./ripgrep-file-types";
import { compileRipgrepGlob, type RipgrepGlobSpec } from "./ripgrep-globs";

export type RipgrepOutputMode =
  | "lines" | "files-with-matches" | "files-without-match" | "count" | "count-matches" | "files" | "type-list" | "help";
export type RipgrepCaseMode = "sensitive" | "insensitive" | "smart";

export interface RipgrepQuery {
  patterns: string[];
  paths: string[];
  mode: RipgrepOutputMode;
  fixedStrings: boolean;
  caseMode: RipgrepCaseMode;
  wordRegexp: boolean;
  lineRegexp: boolean;
  invertMatch: boolean;
  multiline: boolean;
  multilineDotall: boolean;
  lineNumbers: boolean;
  column: boolean;
  heading: boolean;
  withFilename: boolean;
  onlyMatching: boolean;
  trim: boolean;
  afterContext: number;
  beforeContext: number;
  maxCount: number | null;
  maxColumns: number | null;
  maxDepth: number | null;
  globs: RipgrepGlobSpec[];
  types: string[];
  typesNot: string[];
  hidden: boolean;
  noIgnore: boolean;
  binary: boolean;
  maxFilesize: number;
  /** 0 means unlimited. */
  maxResults: number;
}

export type RipgrepArgumentsResult = { kind: "query"; query: RipgrepQuery } | { kind: "rejected"; message: string };

export const RIPGREP_DEFAULT_MAX_RESULTS = 500;
export const RIPGREP_DEFAULT_MAX_FILESIZE = 4 * 1024 * 1024;

export const RIPGREP_HELP_TEXT = `wb rg: rg-compatible project search (JavaScript regex syntax).
usage: wb rg -- [flags] <pattern> [path...]   |   wb rg -- [flags] -e <pattern>... [path...]   |   wb rg -- --files [path...]

ignore: gitignored files are skipped even under explicit paths. --no-ignore / -u walks the disk instead
  (.git always skipped); -uu or --hidden / -. adds dotfiles there; -uuu also searches binary files.
matching: -e -F -i -S -s -w -x -v -U --multiline-dotall
output: -n -N --column --heading --no-heading -H -I -l --files-without-match -c --count-matches -o --trim
  -A -B -C -m -M --files --type-list
filters: -g/--glob (! negates, later globs win, {a,b} braces) --iglob -t/--type -T/--type-not -d/--max-depth
  -a/--text --max-filesize (default 4M)
guards: --max-results N caps printed result lines (default ${RIPGREP_DEFAULT_MAX_RESULTS}, 0 = unlimited)
no-ops: --color --no-config --no-messages --sort path -j/--threads -p/--pretty
`;

interface Draft {
  query: RipgrepQuery;
  expressions: string[];
  positionals: string[];
  context: number | null;
  after: number | null;
  before: number | null;
  unrestricted: number;
}

type SwitchFlag = { kind: "switch"; apply(draft: Draft): void };
type ValueFlag = { kind: "value"; apply(draft: Draft, value: string): string | null };
type Flag = SwitchFlag | ValueFlag;

function switchFlag(apply: (draft: Draft) => void): SwitchFlag {
  return { kind: "switch", apply };
}

function valueFlag(apply: (draft: Draft, value: string) => string | null): ValueFlag {
  return { kind: "value", apply };
}

function noOp(): SwitchFlag {
  return switchFlag(() => undefined);
}

function parseCount(name: string, value: string): number | string {
  if (!/^\d+$/u.test(value)) return `${name} expects a non-negative integer, got "${value}".`;
  return Number(value);
}

function parseSize(value: string): number | string {
  const match = /^(\d+)([KMG])?$/iu.exec(value);
  if (!match) return `--max-filesize expects a size like 500K, 4M or 1G, got "${value}".`;
  const unit = (match[2] ?? "").toUpperCase();
  const multiplier = unit === "K" ? 1024 : unit === "M" ? 1024 ** 2 : unit === "G" ? 1024 ** 3 : 1;
  return Number(match[1]) * multiplier;
}

function countFlag(name: string, assign: (draft: Draft, value: number) => void) {
  return valueFlag((draft, value) => {
    const count = parseCount(name, value);
    if (typeof count === "string") return count;
    assign(draft, count);
    return null;
  });
}

function globFlag(caseInsensitive: boolean) {
  return valueFlag((draft, value) => {
    try {
      compileRipgrepGlob(value, caseInsensitive);
    } catch (error) {
      return `Invalid glob: ${error instanceof Error ? error.message : String(error)}`;
    }
    draft.query.globs.push({ glob: value, caseInsensitive });
    return null;
  });
}

function typeFlag(name: string, target: (draft: Draft) => string[]) {
  return valueFlag((draft, value) => {
    if (!RIPGREP_FILE_TYPES[value]) return `${name}: unknown file type "${value}". Use --type-list to see supported types.`;
    target(draft).push(value);
    return null;
  });
}

const FLAG_ENTRIES: Array<[string[], Flag]> = [
  [["-h", "--help"], switchFlag(draft => { draft.query.mode = "help"; })],
  [["-e", "--regexp"], valueFlag((draft, value) => { draft.expressions.push(value); return null; })],
  [["-F", "--fixed-strings"], switchFlag(draft => { draft.query.fixedStrings = true; })],
  [["-i", "--ignore-case"], switchFlag(draft => { draft.query.caseMode = "insensitive"; })],
  [["-S", "--smart-case"], switchFlag(draft => { draft.query.caseMode = "smart"; })],
  [["-s", "--case-sensitive"], switchFlag(draft => { draft.query.caseMode = "sensitive"; })],
  [["-w", "--word-regexp"], switchFlag(draft => { draft.query.wordRegexp = true; })],
  [["-x", "--line-regexp"], switchFlag(draft => { draft.query.lineRegexp = true; })],
  [["-v", "--invert-match"], switchFlag(draft => { draft.query.invertMatch = true; })],
  [["-U", "--multiline"], switchFlag(draft => { draft.query.multiline = true; })],
  [["--multiline-dotall"], switchFlag(draft => { draft.query.multilineDotall = true; })],
  [["-n", "--line-number"], switchFlag(draft => { draft.query.lineNumbers = true; })],
  [["-N", "--no-line-number"], switchFlag(draft => { draft.query.lineNumbers = false; })],
  [["--column"], switchFlag(draft => { draft.query.column = true; })],
  [["--no-column"], switchFlag(draft => { draft.query.column = false; })],
  [["--heading"], switchFlag(draft => { draft.query.heading = true; })],
  [["--no-heading"], switchFlag(draft => { draft.query.heading = false; })],
  [["-H", "--with-filename"], switchFlag(draft => { draft.query.withFilename = true; })],
  [["-I", "--no-filename"], switchFlag(draft => { draft.query.withFilename = false; })],
  [["-l", "--files-with-matches"], switchFlag(draft => { draft.query.mode = "files-with-matches"; })],
  [["--files-without-match"], switchFlag(draft => { draft.query.mode = "files-without-match"; })],
  [["-c", "--count"], switchFlag(draft => { draft.query.mode = "count"; })],
  [["--count-matches"], switchFlag(draft => { draft.query.mode = "count-matches"; })],
  [["-o", "--only-matching"], switchFlag(draft => { draft.query.onlyMatching = true; })],
  [["--trim"], switchFlag(draft => { draft.query.trim = true; })],
  [["--files"], switchFlag(draft => { draft.query.mode = "files"; })],
  [["--type-list"], switchFlag(draft => { draft.query.mode = "type-list"; })],
  [["-A", "--after-context"], countFlag("-A/--after-context", (draft, value) => { draft.after = value; })],
  [["-B", "--before-context"], countFlag("-B/--before-context", (draft, value) => { draft.before = value; })],
  [["-C", "--context"], countFlag("-C/--context", (draft, value) => { draft.context = value; })],
  [["-m", "--max-count"], countFlag("-m/--max-count", (draft, value) => { draft.query.maxCount = value; })],
  [["-M", "--max-columns"], countFlag("-M/--max-columns", (draft, value) => { draft.query.maxColumns = value || null; })],
  [["-d", "--max-depth", "--maxdepth"], countFlag("-d/--max-depth", (draft, value) => { draft.query.maxDepth = value; })],
  [["--max-results"], countFlag("--max-results", (draft, value) => { draft.query.maxResults = value; })],
  [["--max-filesize"], valueFlag((draft, value) => {
    const size = parseSize(value);
    if (typeof size === "string") return size;
    draft.query.maxFilesize = size;
    return null;
  })],
  [["-g", "--glob"], globFlag(false)],
  [["--iglob"], globFlag(true)],
  [["-t", "--type"], typeFlag("-t/--type", draft => draft.query.types)],
  [["-T", "--type-not"], typeFlag("-T/--type-not", draft => draft.query.typesNot)],
  [["--hidden", "-."], switchFlag(draft => { draft.query.hidden = true; })],
  [["--no-hidden"], switchFlag(draft => { draft.query.hidden = false; })],
  [["--no-ignore", "--no-ignore-vcs"], switchFlag(draft => { draft.query.noIgnore = true; })],
  [["-u", "--unrestricted"], switchFlag(draft => { draft.unrestricted += 1; })],
  [["-a", "--text"], switchFlag(draft => { draft.query.binary = true; })],
  [["-p", "--pretty"], switchFlag(draft => { draft.query.heading = true; draft.query.lineNumbers = true; })],
  [["--sort"], valueFlag((_draft, value) => (value === "path" || value === "none"
    ? null
    : `--sort ${value} is unsupported; results are always sorted by path.`))],
  [["--color", "--colour", "-j", "--threads"], valueFlag(() => null)],
  [["--no-config", "--no-messages", "--no-ignore-messages", "--line-buffered", "--block-buffered", "--crlf"], noOp()],
];

const FLAGS = new Map(FLAG_ENTRIES.flatMap(([names, flag]) => names.map(name => [name, flag] as const)));

function unsupported(flag: string) {
  return `Unsupported flag ${flag}. wb rg supports common ripgrep flags with JavaScript regex syntax; pass --help to list them.`;
}

function initialQuery(): RipgrepQuery {
  return {
    patterns: [],
    paths: [],
    mode: "lines",
    fixedStrings: false,
    caseMode: "sensitive",
    wordRegexp: false,
    lineRegexp: false,
    invertMatch: false,
    multiline: false,
    multilineDotall: false,
    lineNumbers: true,
    column: false,
    heading: true,
    withFilename: true,
    onlyMatching: false,
    trim: false,
    afterContext: 0,
    beforeContext: 0,
    maxCount: null,
    maxColumns: null,
    maxDepth: null,
    globs: [],
    types: [],
    typesNot: [],
    hidden: false,
    noIgnore: false,
    binary: false,
    maxFilesize: RIPGREP_DEFAULT_MAX_FILESIZE,
    maxResults: RIPGREP_DEFAULT_MAX_RESULTS,
  };
}

export function parseRipgrepArguments(args: readonly string[]): RipgrepArgumentsResult {
  const draft: Draft = {
    query: initialQuery(), expressions: [], positionals: [], context: null, after: null, before: null, unrestricted: 0,
  };
  let flagsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (flagsEnded || argument === "" || !argument.startsWith("-")) {
      draft.positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      flagsEnded = true;
      continue;
    }
    if (argument === "-") return { kind: "rejected", message: "wb rg never reads stdin; pass a path to search instead of -." };
    if (argument.startsWith("--")) {
      const separator = argument.indexOf("=");
      const name = separator < 0 ? argument : argument.slice(0, separator);
      const inline = separator < 0 ? null : argument.slice(separator + 1);
      const flag = FLAGS.get(name);
      if (!flag) return { kind: "rejected", message: unsupported(name) };
      if (flag.kind === "switch") {
        if (inline !== null) return { kind: "rejected", message: `${name} does not take a value.` };
        flag.apply(draft);
        continue;
      }
      const value = inline ?? args[++index];
      if (value === undefined) return { kind: "rejected", message: `${name} requires a value.` };
      const error = flag.apply(draft, value);
      if (error) return { kind: "rejected", message: error };
      continue;
    }
    for (let offset = 1; offset < argument.length; offset += 1) {
      const name = `-${argument[offset]}`;
      const flag = FLAGS.get(name);
      if (!flag) return { kind: "rejected", message: unsupported(name) };
      if (flag.kind === "switch") {
        flag.apply(draft);
        continue;
      }
      const attached = argument.slice(offset + 1);
      const value = attached || args[++index];
      if (value === undefined) return { kind: "rejected", message: `${name} requires a value.` };
      const error = flag.apply(draft, value);
      if (error) return { kind: "rejected", message: error };
      break;
    }
  }

  const { query } = draft;
  if (draft.unrestricted >= 1) query.noIgnore = true;
  if (draft.unrestricted >= 2) query.hidden = true;
  if (draft.unrestricted >= 3) query.binary = true;
  query.afterContext = draft.after ?? draft.context ?? 0;
  query.beforeContext = draft.before ?? draft.context ?? 0;
  if (query.mode === "help" || query.mode === "type-list") return { kind: "query", query };
  if (query.mode === "files" || draft.expressions.length) {
    query.patterns = draft.expressions;
    query.paths = draft.positionals;
    return { kind: "query", query };
  }
  const [pattern, ...paths] = draft.positionals;
  if (pattern === undefined) return { kind: "rejected", message: "A search pattern is required. Pass --help for usage." };
  query.patterns = [pattern];
  query.paths = paths;
  return { kind: "query", query };
}
