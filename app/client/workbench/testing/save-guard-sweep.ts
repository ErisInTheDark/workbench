/*
 * Exports:
 * - SweepFailure: one swept editor state that blocked its save, changed its words, or saved unstable markdown.
 * - checkSavedWords: press save on a mounted panel and record a failure unless it wrote markdown with the expected words.
 * - checkReopenedFixpoint: reopen saved markdown and record a failure unless saving it again writes the same file.
 * - reportSweep: summarise failures with a sample of every failure kind.
 */
import { markdownToHtml } from "../markdown/markdown-html-render";
import { renderedWords } from "./editor-text";
import MountedFilePanel, { SaveBlockedError } from "./MountedFilePanel";

const FAILURE_SAMPLE = 2;
const FAILURE_KINDS = ["blocked", "words", "unstable"] as const;

export interface SweepFailure {
  input: string;
  kind: (typeof FAILURE_KINDS)[number];
  reason: string;
}

/** Resolves with the saved markdown, or null after recording why the state failed. */
export async function checkSavedWords(panel: MountedFilePanel, input: string, expectedWords: string[], failures: SweepFailure[]) {
  try {
    const output = await panel.save();
    const words = renderedWords(markdownToHtml(output));
    if (JSON.stringify(words) !== JSON.stringify(expectedWords)) {
      failures.push({ input, kind: "words", reason: `words ${JSON.stringify(expectedWords)} became ${JSON.stringify(words)} in ${JSON.stringify(output)}` });
      return null;
    }
    return output;
  } catch (error) {
    if (!(error instanceof SaveBlockedError)) throw error;
    failures.push({ input, kind: "blocked", reason: error.message });
    return null;
  }
}

export async function checkReopenedFixpoint(input: string, saved: string, failures: SweepFailure[]) {
  const reopened = await MountedFilePanel.open(saved);
  try {
    const resaved = await reopened.save();
    if (resaved !== saved) {
      failures.push({ input, kind: "unstable", reason: `${JSON.stringify(saved)} resaved as ${JSON.stringify(resaved)}` });
    }
  } catch (error) {
    if (!(error instanceof SaveBlockedError)) throw error;
    failures.push({ input, kind: "blocked", reason: `reopened ${JSON.stringify(saved)}: ${error.message}` });
  } finally {
    reopened.dispose();
  }
}

/** Samples each failure kind separately so a common failure cannot hide a rarer one. */
export function reportSweep(failures: SweepFailure[], total: number) {
  const sample = FAILURE_KINDS.flatMap(kind => failures.filter(failure => failure.kind === kind).slice(0, FAILURE_SAMPLE));
  const lines = sample.map(({ input, kind, reason }) => `- [${kind}] ${JSON.stringify(input)}\n  ${reason.replaceAll("\n", "\n  ")}`);
  return `${failures.length}/${total} cases failed:\n${lines.join("\n")}`;
}
