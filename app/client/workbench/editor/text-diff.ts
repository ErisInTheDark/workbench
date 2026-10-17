/*
 * Exports:
 * - TextSpan: a character range of one side of a diff.
 * - diffWords: which words of `before` were deleted and which words of `after` were inserted.
 */

export interface TextSpan {
  end: number;
  start: number;
}

interface Token {
  end: number;
  start: number;
  text: string;
}

/** Above this many token pairs the sides are reported as wholly replaced instead of diffed. */
const MAX_DIFF_CELLS = 2_000_000;
const TOKEN_PATTERN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

function tokenize(text: string): Token[] {
  return Array.from(text.matchAll(TOKEN_PATTERN), (match) => ({
    end: match.index + match[0].length,
    start: match.index,
    text: match[0],
  }));
}

function isWhitespace(token: Token) {
  return /^\s+$/u.test(token.text);
}

/** Changed words become spans; whitespace joins changed words on both sides of it but never starts or ends a span. */
function toSpans(tokens: readonly Token[], changed: readonly boolean[]) {
  const spans: TextSpan[] = [];
  let open: TextSpan | null = null;
  tokens.forEach((token, index) => {
    if (isWhitespace(token)) {
      return;
    }
    if (!changed[index]) {
      open = null;
    } else if (open) {
      open.end = token.end;
    } else {
      open = { end: token.end, start: token.start };
      spans.push(open);
    }
  });
  return spans;
}

export function diffWords(before: string, after: string) {
  const left = tokenize(before);
  const right = tokenize(after);
  const deleted = left.map(() => true);
  const inserted = right.map(() => true);

  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix]!.text === right[prefix]!.text) {
    deleted[prefix] = false;
    inserted[prefix] = false;
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix]!.text === right[right.length - 1 - suffix]!.text
  ) {
    deleted[left.length - 1 - suffix] = false;
    inserted[right.length - 1 - suffix] = false;
    suffix += 1;
  }

  const middleLeft = left.slice(prefix, left.length - suffix);
  const middleRight = right.slice(prefix, right.length - suffix);
  if (middleLeft.length * middleRight.length <= MAX_DIFF_CELLS) {
    const columns = middleRight.length + 1;
    const lengths = new Uint32Array((middleLeft.length + 1) * columns);
    for (let row = middleLeft.length - 1; row >= 0; row -= 1) {
      for (let column = middleRight.length - 1; column >= 0; column -= 1) {
        lengths[row * columns + column] = middleLeft[row]!.text === middleRight[column]!.text
          ? lengths[(row + 1) * columns + column + 1]! + 1
          : Math.max(lengths[(row + 1) * columns + column]!, lengths[row * columns + column + 1]!);
      }
    }

    let row = 0;
    let column = 0;
    while (row < middleLeft.length && column < middleRight.length) {
      if (middleLeft[row]!.text === middleRight[column]!.text) {
        deleted[prefix + row] = false;
        inserted[prefix + column] = false;
        row += 1;
        column += 1;
      } else if (lengths[(row + 1) * columns + column]! >= lengths[row * columns + column + 1]!) {
        row += 1;
      } else {
        column += 1;
      }
    }
  }

  return { deleted: toSpans(left, deleted), inserted: toSpans(right, inserted) };
}
