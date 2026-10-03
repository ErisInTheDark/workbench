/*
 * Exports:
 * - CodexSandboxAclCommandRunner: run one argv as an identity; the daemon runner ignores the root, the sandbox runner makes it writable.
 * - CodexSandboxAclRunner: daemon-identity ports for icacls reads and repair commands.
 * - CodexSandboxAclControllerOptions: platform, Codex capability file, runner and filesystem ports.
 * - parseIcaclsAcl: read one icacls object listing into inherited/explicit ACE facts.
 * - default CodexSandboxAclController: silently repair Codex Windows sandbox write ACEs that never reached existing objects,
 *   alternating daemon-user and sandbox-user passes because each can only rewrite ACLs on objects it owns.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { resolveCodexHome } from "./lib/codex/codex-home";
import { log, logError } from "./process-helpers";

export type CodexSandboxAclCommandRunner = (command: string[], root: string, signal: AbortSignal) => Promise<{ code: number; stdout: string }>;

export interface CodexSandboxAclRunner {
  /** Reads tolerate partial failures, so the caller interprets the exit code. */
  icacls(args: string[], signal: AbortSignal): Promise<{ code: number; stdout: string }>;
  daemon: CodexSandboxAclCommandRunner;
}

export interface CodexSandboxAclControllerOptions {
  platform?: NodeJS.Platform;
  readCapabilities?: () => Promise<string | null>;
  runner?: CodexSandboxAclRunner;
  exists?: (target: string) => Promise<boolean>;
}

type IcaclsAce = { sid: string | null; inherited: boolean; deny: boolean; flags: string };
type SandboxRoot = { key: string; root: string; sids: string[] };
/** `broken` counts objects found missing an ACE during the pass; `fixed` of those verified repaired afterwards. */
type PassResult = { broken: number; fixed: number; failed: number };

/** Codex keys capability SIDs by lowercase forward-slash root path. */
const CapabilityFileSchema = z.object({
  workspace_by_cwd: z.record(z.string(), z.string()).optional(),
  writable_root_by_path: z.record(z.string(), z.string()).optional(),
}).passthrough();

const SID_PATTERN = /(?:^|\s)(S-1-[0-9-]+):\(/u;
/** Alternating identities converge within depth; this bounds pathological ownership layering. */
const MAX_PASSES = 4;

export function parseIcaclsAcl(lines: readonly string[]): IcaclsAce[] {
  return lines.flatMap((line) => {
    const flags = /:((?:\([^()]*\))+)\s*$/u.exec(line)?.[1];
    if (!flags) return [];
    return [{
      sid: SID_PATTERN.exec(line)?.[1] ?? null,
      inherited: flags.includes("(I)"),
      deny: flags.includes("(DENY)"),
      flags,
    }];
  });
}

/** Split a multi-object icacls listing into per-object ACE lists; continuation lines are indented. */
function parseIcaclsObjects(stdout: string) {
  const objects: string[][] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (!/^\s/u.test(line)) objects.push([]);
    objects.at(-1)?.push(line);
  }
  return objects.map(parseIcaclsAcl).filter((aces) => aces.length > 0);
}

function rootKey(target: string) {
  return path.win32.resolve(target).replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

function inheritsAll(aces: readonly IcaclsAce[], sids: readonly string[]) {
  const inherited = new Set(aces.filter((ace) => ace.inherited && !ace.deny && ace.sid).map((ace) => ace.sid));
  return sids.every((sid) => inherited.has(sid));
}

function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 400);
}

function powershellLiteral(value: string) {
  return `'${value.replace(/'/gu, "''")}'`;
}

/**
 * Re-apply each broken object's own DACL so Windows recomputes inherited ACEs from its parent and keeps explicit ones.
 * Uses only .NET so module autoloading cannot fail under an inherited PowerShell 7 module path or a sandbox token.
 */
function repairScript(root: SandboxRoot, targets: readonly string[]) {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sids = @(${root.sids.map(powershellLiteral).join(", ")})
$targets = @(${targets.map(powershellLiteral).join(", ")})
$access = [System.Security.AccessControl.AccessControlSections]::Access
$sections = $access -bor [System.Security.AccessControl.AccessControlSections]::Owner
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$script:broken = 0; $script:fixed = 0; $script:failed = 0
function Test-Inherits($acl) {
  $have = @{}
  foreach ($rule in $acl.GetAccessRules($false, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') { $have[$rule.IdentityReference.Value] = $true }
  }
  foreach ($sid in $sids) { if (-not $have.ContainsKey($sid)) { return $false } }
  return $true
}
function Repair($info) {
  try { $acl = $info.GetAccessControl($sections) } catch { $script:failed++; return }
  if ($acl.AreAccessRulesProtected -or (Test-Inherits $acl)) { return }
  $script:broken++
  # Only an object's owner may rewrite its DACL; the other identity's pass owns the rest.
  if (-not $me.Equals($acl.GetOwner([System.Security.Principal.SecurityIdentifier]))) { return }
  try {
    $acl = $info.GetAccessControl($access)
    $acl.SetSecurityDescriptorSddlForm($acl.GetSecurityDescriptorSddlForm($access), $access)
    $info.SetAccessControl($acl)
  } catch {}
  try { if (Test-Inherits ($info.GetAccessControl($access))) { $script:fixed++ } } catch {}
}
if ($targets.Count) {
  foreach ($target in $targets) {
    if ([System.IO.Directory]::Exists($target)) { Repair ([System.IO.DirectoryInfo]::new($target)) } else { Repair ([System.IO.FileInfo]::new($target)) }
  }
} else {
  # Breadth-first: shallow folders are fixed first, and each fix propagates into its own subtree.
  $queue = [System.Collections.Generic.Queue[System.IO.DirectoryInfo]]::new()
  $queue.Enqueue([System.IO.DirectoryInfo]::new(${powershellLiteral(root.root)}))
  while ($queue.Count) {
    try { $entries = $queue.Dequeue().GetFileSystemInfos() } catch { $script:failed++; continue }
    foreach ($entry in $entries) {
      Repair $entry
      if (($entry -is [System.IO.DirectoryInfo]) -and -not ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { $queue.Enqueue($entry) }
    }
  }
}
"WBACL broken=$($script:broken) fixed=$($script:fixed) failed=$($script:failed)"
`;
}

export function codexSandboxAclPowershellCommand(script: string) {
  return [
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function parsePass(stdout: string): PassResult {
  const match = /WBACL broken=(\d+) fixed=(\d+) failed=(\d+)/u.exec(stdout);
  if (!match) throw new Error("The ACL repair pass reported no result.");
  return { broken: Number(match[1]), fixed: Number(match[2]), failed: Number(match[3]) };
}

function runFile(command: string[], signal: AbortSignal) {
  return new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    execFile(command[0]!, command.slice(1), { maxBuffer: 16 * 1024 * 1024, signal, windowsHide: true }, (error, stdout) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout });
    });
  });
}

const defaultRunner: CodexSandboxAclRunner = {
  icacls: (args, signal) => runFile([path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), ...args], signal),
  daemon: (command, _root, signal) => runFile(command, signal),
};

async function readDefaultCapabilities() {
  try {
    return await fs.readFile(path.join(resolveCodexHome(), "cap_sid"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(target: string) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export default class CodexSandboxAclController {
  private readonly platform: NodeJS.Platform;
  private readonly readCapabilities: NonNullable<CodexSandboxAclControllerOptions["readCapabilities"]>;
  private readonly runner: CodexSandboxAclRunner;
  private readonly exists: NonNullable<CodexSandboxAclControllerOptions["exists"]>;
  private readonly lifetime = new AbortController();
  /** Root+SID sets a verified full walk found clean; nothing else may mark a root healthy. */
  private readonly healthy = new Set<string>();
  /** Root+SID sets whose direct children scanned clean; skips rescans without claiming deep health. */
  private readonly scanned = new Set<string>();
  private readonly walks = new Map<string, Promise<void>>();
  private readonly scans = new Map<string, Promise<void>>();
  /** Every background lookup, scan and walk; each settles without rejecting. */
  private readonly background = new Set<Promise<void>>();

  constructor(options: CodexSandboxAclControllerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.readCapabilities = options.readCapabilities ?? readDefaultCapabilities;
    this.runner = options.runner ?? defaultRunner;
    this.exists = options.exists ?? pathExists;
  }

  /** Repair every target's ancestor chain before a sandboxed patch writes it. Never throws except on abort. */
  async ensureWritable(paths: readonly string[], signal: AbortSignal, sandbox?: CodexSandboxAclCommandRunner) {
    if (this.platform !== "win32" || !paths.length) return;
    const linked = AbortSignal.any([signal, this.lifetime.signal]);
    try {
      for (const root of await this.roots(paths, linked)) {
        if (this.healthy.has(this.healthKey(root))) continue;
        const broken = await this.brokenChains(root, paths.filter((candidate) => this.contains(root, candidate)), linked);
        if (!broken.length) continue;
        const result = await this.repair(root, broken, sandbox, linked);
        log("codex-sandbox-acl", `Repaired ${result.fixed} of ${result.broken} patch target ACL(s) under ${root.root}${result.failed ? `; ${result.failed} still unwritable` : ""}.`);
        this.scheduleWalk(root, sandbox);
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!this.lifetime.signal.aborted) logError("codex-sandbox-acl", `Patch target ACL repair failed: ${sanitize(error)}`);
    }
  }

  /** Scan the sandbox root above a command cwd and repair the whole tree in the background when its children lost inheritance. */
  checkInBackground(cwd: string, sandbox?: CodexSandboxAclCommandRunner) {
    if (this.platform !== "win32" || this.lifetime.signal.aborted) return;
    this.track(this.roots([cwd], this.lifetime.signal).then((roots) => {
      for (const root of roots) this.scheduleScan(root, sandbox);
    }, (error) => {
      if (!this.lifetime.signal.aborted) logError("codex-sandbox-acl", `Sandbox root lookup failed: ${sanitize(error)}`);
    }));
  }

  /** Resolve once no background repair remains, including work scheduled while waiting. */
  async idle() {
    while (this.background.size) await Promise.all(this.background);
  }

  async dispose() {
    this.lifetime.abort(new Error("Codex sandbox ACL repair was disposed."));
    await this.idle();
  }

  private track(work: Promise<void>) {
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
    return work;
  }

  private healthKey(root: SandboxRoot) {
    return `${root.key}\0${[...root.sids].sort().join(",")}`;
  }

  private contains(root: SandboxRoot, target: string) {
    const key = rootKey(target);
    return key !== root.key && key.startsWith(`${root.key}/`);
  }

  /** Codex roots containing the targets, limited to SIDs the root really grants as inheritable allow ACEs. */
  private async roots(paths: readonly string[], signal: AbortSignal): Promise<SandboxRoot[]> {
    const raw = await this.readCapabilities();
    signal.throwIfAborted();
    if (!raw) return [];
    const capabilities = CapabilityFileSchema.parse(JSON.parse(raw) as unknown);
    const sidsByKey = new Map<string, Set<string>>();
    for (const map of [capabilities.writable_root_by_path, capabilities.workspace_by_cwd]) {
      for (const [key, sid] of Object.entries(map ?? {})) {
        const normalized = rootKey(key);
        sidsByKey.set(normalized, (sidsByKey.get(normalized) ?? new Set()).add(sid));
      }
    }
    const roots: SandboxRoot[] = [];
    for (const [key, sids] of sidsByKey) {
      const root = path.win32.normalize(key);
      // Shell cwds are usually the root itself; patch targets are always beneath it.
      if (!paths.some((target) => rootKey(target) === key || this.contains({ key, root, sids: [] }, target))) continue;
      const aces = await this.read(root, signal);
      const granted = aces.filter((ace) => !ace.inherited && !ace.deny && ace.sid && sids.has(ace.sid)
        && ace.flags.includes("(OI)") && ace.flags.includes("(CI)"));
      const required = [...new Set(granted.map((ace) => ace.sid!))];
      if (required.length) roots.push({ key, root, sids: required });
    }
    return roots;
  }

  private async read(target: string, signal: AbortSignal) {
    const { code, stdout } = await this.runner.icacls([target], signal);
    signal.throwIfAborted();
    const aces = parseIcaclsAcl(stdout.split(/\r?\n/u));
    if (code !== 0 && !aces.length) throw new Error(`icacls could not read an ACL (exit ${code}).`);
    return aces;
  }

  /** Existing chain objects, top-down, from the first one missing a sandbox ACE to each target. */
  private async brokenChains(root: SandboxRoot, targets: readonly string[], signal: AbortSignal) {
    const reads = new Map<string, Promise<IcaclsAce[]>>();
    const broken: string[] = [];
    for (const target of targets) {
      const segments = path.win32.relative(root.root, path.win32.resolve(target)).split(/[\\/]+/u).filter(Boolean);
      let current = root.root;
      let repairing = false;
      for (const segment of segments) {
        current = path.win32.join(current, segment);
        if (!await this.exists(current)) break;
        signal.throwIfAborted();
        const key = current.toLowerCase();
        let pending = reads.get(key);
        if (!pending) {
          pending = this.read(current, signal);
          reads.set(key, pending);
        }
        // Once an ancestor is re-inherited, every descendant's inherited ACEs must be recomputed too.
        repairing ||= !inheritsAll(await pending, root.sids);
        if (repairing && !broken.some((candidate) => candidate.toLowerCase() === key)) broken.push(current);
      }
    }
    return broken;
  }

  /** Alternate daemon and sandbox passes until clean or neither identity can make progress. */
  private async repair(root: SandboxRoot, targets: readonly string[], sandbox: CodexSandboxAclCommandRunner | undefined, signal: AbortSignal) {
    // Sandboxed agents create most objects that miss the grant, so their owner goes first.
    const identities = sandbox ? [sandbox, this.runner.daemon] : [this.runner.daemon];
    const command = codexSandboxAclPowershellCommand(repairScript(root, targets));
    let broken: number | null = null;
    let fixed = 0;
    let remaining = 0;
    let idle = 0;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const { code, stdout } = await identities[pass % identities.length]!(command, root.root, signal);
      signal.throwIfAborted();
      if (code !== 0) throw new Error(`An ACL repair pass exited ${code}.`);
      const result = parsePass(stdout);
      broken ??= result.broken;
      fixed += result.fixed;
      remaining = result.broken - result.fixed;
      if (!remaining) break;
      idle = result.fixed ? 0 : idle + 1;
      if (idle >= identities.length) break;
    }
    return { broken: broken ?? 0, fixed, failed: remaining };
  }

  private scheduleScan(root: SandboxRoot, sandbox: CodexSandboxAclCommandRunner | undefined) {
    const key = this.healthKey(root);
    if (this.healthy.has(key) || this.scanned.has(key) || this.scans.has(key) || this.walks.has(key)) return;
    const scan = (async () => {
      try {
        const { code, stdout } = await this.runner.icacls([path.win32.join(root.root, "*")], this.lifetime.signal);
        const children = parseIcaclsObjects(stdout);
        if (code !== 0 && !children.length) throw new Error(`icacls could not read sandbox root children (exit ${code}).`);
        // Children without inherited ACEs opted out of inheritance; no repair can change them.
        const broken = children.filter((aces) => aces.some((ace) => ace.inherited) && !inheritsAll(aces, root.sids)).length;
        if (broken) {
          log("codex-sandbox-acl", `${broken} of ${children.length} children of ${root.root} lack inherited sandbox ACEs.`);
          this.scheduleWalk(root, sandbox);
        } else this.scanned.add(key);
      } catch (error) {
        if (!this.lifetime.signal.aborted) logError("codex-sandbox-acl", `Sandbox root ACL scan failed: ${sanitize(error)}`);
      } finally {
        this.scans.delete(key);
      }
    })();
    this.scans.set(key, this.track(scan));
  }

  private scheduleWalk(root: SandboxRoot, sandbox: CodexSandboxAclCommandRunner | undefined) {
    const key = this.healthKey(root);
    if (this.healthy.has(key) || this.walks.has(key)) return;
    const walk = (async () => {
      const startedAt = Date.now();
      log("codex-sandbox-acl", `Repairing sandbox ACEs below ${root.root}${sandbox ? "" : " without a sandbox identity"}.`);
      try {
        const result = await this.repair(root, [], sandbox, this.lifetime.signal);
        if (result.failed) {
          logError("codex-sandbox-acl", `Sandbox ACE repair below ${root.root} left ${result.failed} object(s) unwritable after ${Date.now() - startedAt}ms.`);
          return;
        }
        log("codex-sandbox-acl", `Repaired ${result.fixed} object(s) below ${root.root} in ${Date.now() - startedAt}ms.`);
        this.healthy.add(key);
      } catch (error) {
        if (!this.lifetime.signal.aborted) logError("codex-sandbox-acl", `Sandbox ACE repair below ${root.root} failed: ${sanitize(error)}`);
      } finally {
        this.walks.delete(key);
      }
    })();
    this.walks.set(key, this.track(walk));
  }
}
