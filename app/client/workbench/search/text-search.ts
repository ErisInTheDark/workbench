/*
 * Exports:
 * - TextSearch: a parsed query; every `include` term must appear and no `exclude` term may.
 * - TextSearch.parse: split a query into folded terms; "quoted phrases" stay whole and a leading - excludes a term.
 * - TextSearch.isActive: whether the search narrows anything.
 * - TextSearch.fold: case-, accent- and whitespace-insensitive form of text, the side a search matches against.
 * - TextSearch.matches: whether folded text satisfies the search.
 * - TextSearch.ranges: merged [start, end) offsets of included terms in raw text, for painting matches.
 */

export interface TextSearch {
  readonly exclude: readonly string[];
  readonly include: readonly string[];
}

const TERM = /(-?)"([^"]*)"?|(-?)(\S+)/gu;
const MARKS = /\p{M}/gu;
const SPACE = /\s/u;

/** Folds one code point at a time so every folded character maps back to the raw character it came from. */
function foldMapped(text: string) {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  let spaced = true;
  for (const char of text) {
    const space = SPACE.test(char);
    const next = space ? (spaced ? "" : " ")
      : char < "\u0080" ? char.toLowerCase()
        : char.normalize("NFD").replace(MARKS, "").toLowerCase();
    spaced = space;
    for (let offset = 0; offset < next.length; offset += 1) {
      starts.push(index);
      ends.push(index + char.length);
    }
    folded += next;
    index += char.length;
  }
  return { ends, folded, starts };
}

export const TextSearch = {
  parse(query: string): TextSearch {
    const include: string[] = [];
    const exclude: string[] = [];
    for (const match of query.matchAll(TERM)) {
      const negated = (match[1] ?? match[3]) === "-";
      const term = TextSearch.fold(match[2] ?? match[4] ?? "").trim();
      if (term) (negated ? exclude : include).push(term);
    }
    return { exclude, include };
  },

  isActive(search: TextSearch) {
    return search.include.length > 0 || search.exclude.length > 0;
  },

  fold(text: string) {
    return foldMapped(text).folded;
  },

  matches(search: TextSearch, folded: string) {
    return search.include.every((term) => folded.includes(term)) && !search.exclude.some((term) => folded.includes(term));
  },

  ranges(search: TextSearch, text: string): Array<readonly [number, number]> {
    if (!search.include.length) return [];
    const { ends, folded, starts } = foldMapped(text);
    const found: Array<[number, number]> = [];
    for (const term of search.include) {
      for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + 1)) {
        found.push([starts[at]!, ends[at + term.length - 1]!]);
      }
    }
    found.sort((left, right) => left[0] - right[0]);
    const merged: Array<[number, number]> = [];
    for (const range of found) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push(range);
    }
    return merged;
  },
};
