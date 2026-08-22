/*
 * Exports:
 * - WorkbenchAgentCommandFlags: parse the allowlisted wb CLI option grammar before typed schema validation. Keywords: workbench, command, cli, flags.
 * - preservePowerShellTrailingPaths: recover PowerShell path operands when the launcher consumes the explicit separator. Keywords: workbench, powershell, paths.
 */
interface FlagSpec {
  boolean?: readonly string[];
  leadingDashValues?: readonly string[];
  repeatable?: readonly string[];
  trailing?: boolean;
  values?: readonly string[];
}

export class WorkbenchAgentCommandFlags {
  readonly booleans = new Set<string>();
  readonly trailing: string[];
  readonly values = new Map<string, string[]>();

  constructor(args: string[], spec: FlagSpec) {
    const booleanFlags = new Set(spec.boolean ?? []);
    const leadingDashValueFlags = new Set(spec.leadingDashValues ?? []);
    const repeatableFlags = new Set(spec.repeatable ?? []);
    const valueFlags = new Set([...(spec.values ?? []), ...repeatableFlags]);
    const trailingIndex = args.indexOf("--");
    this.trailing = trailingIndex >= 0 ? args.slice(trailingIndex + 1) : [];
    const optionArgs = trailingIndex >= 0 ? args.slice(0, trailingIndex) : args;
    if (trailingIndex >= 0 && !spec.trailing) throw new Error("This command does not accept trailing arguments after --.");

    for (let index = 0; index < optionArgs.length; index += 1) {
      const flag = optionArgs[index];
      if (!flag.startsWith("-")) throw new Error(`Unexpected argument: ${flag}`);
      if (booleanFlags.has(flag)) {
        this.booleans.add(flag);
        continue;
      }
      if (!valueFlags.has(flag)) throw new Error(`Unsupported option: ${flag}`);
      const value = optionArgs[index + 1];
      const recognizedOption = value && (booleanFlags.has(value) || valueFlags.has(value));
      if (!value || (value.startsWith("-") && (!leadingDashValueFlags.has(flag) || recognizedOption))) {
        throw new Error(`${flag} requires a value.`);
      }
      index += 1;
      if (!repeatableFlags.has(flag) && this.values.has(flag)) throw new Error(`${flag} may only be supplied once.`);
      this.values.set(flag, [...(this.values.get(flag) ?? []), value]);
    }
  }

  has(flag: string) { return this.booleans.has(flag); }
  optional(flag: string) { return this.values.get(flag)?.[0] ?? null; }
  repeated(flag: string) { return this.values.get(flag) ?? []; }
  required(flag: string) {
    const value = this.optional(flag)?.trim();
    if (!value) throw new Error(`${flag} is required.`);
    return value;
  }
  requiredRepeated(flag: string) {
    const values = this.repeated(flag).map((value) => value.trim());
    if (!values.length || values.some((value) => !value)) throw new Error(`${flag} is required.`);
    if (new Set(values).size !== values.length) throw new Error(`${flag} values must be unique.`);
    return values;
  }
  optionalNonNegativeInteger(flag: string) {
    const value = this.optional(flag);
    if (value === null) return null;
    if (!/^\d+$/u.test(value)) throw new Error(`${flag} must be a non-negative integer.`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be a safe non-negative integer.`);
    return parsed;
  }
}

export function preservePowerShellTrailingPaths(args: string[], {
  boolean = [],
  values = ["--worktree"],
}: {
  boolean?: readonly string[];
  values?: readonly string[];
} = {}) {
  if (args.includes("--")) return args;
  for (let index = 0; index < args.length; index += 1) {
    if (values.includes(args[index])) {
      index += 1;
      continue;
    }
    if (boolean.includes(args[index])) continue;
    if (!args[index].startsWith("-")) return [...args.slice(0, index), "--", ...args.slice(index)];
  }
  return args;
}
