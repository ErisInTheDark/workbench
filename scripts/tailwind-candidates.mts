/*
 * Exports:
 * - collectTailwindCandidates: extract balanced class candidates from bundled source.
 */
function balanced(token: string) {
  const closers: string[] = [];
  for (const character of token) {
    if (character === "(") closers.push(")");
    else if (character === "[") closers.push("]");
    else if ((character === ")" || character === "]") && closers.pop() !== character) return false;
  }
  return closers.length === 0;
}

export function collectTailwindCandidates(source: string): string[] {
  return [...new Set(source.match(/[^\s"'`{}\\]{2,}/gu) ?? [])]
    .filter(token => /[a-z]/u.test(token) && balanced(token));
}
