/*
 * Exports:
 * - AccountName: masked and full account labels; mask chooses a distinguishing prefix.
 */
export interface AccountName {
  short: string;
  full: string;
}

export namespace AccountName {
  export function mask(label: string, others: readonly string[] = []): AccountName {
    const at = label.indexOf("@");
    const maximum = Math.max(0, Math.min(at < 0 ? label.length : at, label.length - 1));
    let length = Math.min(1, maximum);
    while (length < maximum && others.some(other => other !== label && other.startsWith(label.slice(0, length)))) length++;
    return { short: `${label.slice(0, length)}***`, full: label };
  }
}
