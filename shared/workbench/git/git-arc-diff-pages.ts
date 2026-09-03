/*
 * Exports:
 * - GIT_ARC_DIFF_PAGE_CHARACTER_LIMIT/GIT_ARC_DIFF_TRAILER_PREFIX: bound paged diff bodies and separate human notes from unified diff parsing. Keywords: git, arc, diff, page, trailer.
 * - GitArcDiffPageUnit/GitArcDiffPage: whole-file paging inputs and one rendered page result. Keywords: git, diff, file, page.
 * - createGitArcDiffPage: pack whole-file diff units into one deterministic bounded page. Keywords: git, diff, pagination, packing.
 */
import type { GitCheckpointFileChange } from "./checkpoint-contracts.ts";

export const GIT_ARC_DIFF_PAGE_CHARACTER_LIMIT = 15_000;
export const GIT_ARC_DIFF_TRAILER_PREFIX = "Workbench arc diff notes:";

export interface GitArcDiffPageUnit {
  change: GitCheckpointFileChange;
  content: string;
  groupHeading?: string;
}

export interface GitArcDiffPage {
  changes: GitCheckpointFileChange[];
  diff: string;
  nextPage: number | null;
  oversizedDiffPaths: string[];
  page: number;
  pageCount: number;
}

interface IndexedUnit extends GitArcDiffPageUnit {
  index: number;
}

function renderUnits(units: readonly IndexedUnit[]) {
  let previousGroup: string | null = null;
  return [...units]
    .sort((left, right) => left.index - right.index)
    .map((unit) => {
      const heading = unit.groupHeading && unit.groupHeading !== previousGroup
        ? `${unit.groupHeading}\n`
        : "";
      previousGroup = unit.groupHeading ?? null;
      return `${heading}${unit.content}`;
    })
    .join("\n\n");
}

export function createGitArcDiffPage(
  units: readonly GitArcDiffPageUnit[],
  options: { maxCharacters?: number; page?: number; paginate: boolean },
): GitArcDiffPage {
  const maxCharacters = options.maxCharacters ?? GIT_ARC_DIFF_PAGE_CHARACTER_LIMIT;
  const page = options.page ?? 1;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
    throw new Error("Git arc diff page character limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(page) || page <= 0) {
    throw new Error("Git arc diff page must be a positive safe integer.");
  }

  const indexed = units.map((unit, index): IndexedUnit => ({ ...unit, index }));
  if (!options.paginate) {
    return {
      changes: indexed.map(({ change }) => change),
      diff: renderUnits(indexed),
      nextPage: null,
      oversizedDiffPaths: [],
      page: 1,
      pageCount: 1,
    };
  }

  const oversized = indexed.filter((unit) => renderUnits([unit]).length > maxCharacters);
  const candidates = indexed
    .filter((unit) => !oversized.includes(unit))
    .sort((left, right) => {
      const bySize = renderUnits([right]).length - renderUnits([left]).length;
      return bySize || left.change.path.localeCompare(right.change.path);
    });
  const pages: IndexedUnit[][] = [];
  for (const candidate of candidates) {
    let bestPageIndex = -1;
    let bestRenderedLength = -1;
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const renderedLength = renderUnits([...pages[pageIndex]!, candidate]).length;
      if (renderedLength <= maxCharacters && renderedLength > bestRenderedLength) {
        bestPageIndex = pageIndex;
        bestRenderedLength = renderedLength;
      }
    }
    if (bestPageIndex < 0) pages.push([candidate]);
    else pages[bestPageIndex]!.push(candidate);
  }

  const pageCount = Math.max(1, pages.length);
  if (page > pageCount) {
    throw new Error(`Git arc diff page ${page} does not exist. Available pages: 1-${pageCount}.`);
  }
  const selected = pages[page - 1] ?? [];
  return {
    changes: [...selected].sort((left, right) => left.index - right.index).map(({ change }) => change),
    diff: renderUnits(selected),
    nextPage: page < pageCount ? page + 1 : null,
    oversizedDiffPaths: oversized.sort((left, right) => left.index - right.index).map(({ change }) => change.path),
    page,
    pageCount,
  };
}
