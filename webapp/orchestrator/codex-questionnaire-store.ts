/*
 * Exports:
 * - CodexQuestionnaireStore: persist completed Codex questionnaire history under the project-local .workbench directory. Keywords: questionnaire, codex, persistence, .workbench.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type {
    WorkbenchQuestionnaireHistoryEntry,
    WorkbenchUserInputQuestion,
    WorkbenchUserInputRequest,
    WorkbenchUserInputResponse,
} from "../lib/types";

type StoredCodexQuestionnaireHistoryFile = {
  entries: WorkbenchQuestionnaireHistoryEntry[];
  version: 1;
};

const STORE_VERSION = 1 as const;

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : false;
}

function normalizeQuestionnaireQuestion(value: unknown, index: number): WorkbenchUserInputQuestion | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const options = Array.isArray(record.options)
    ? record.options.map((entry) => {
      const optionRecord = asRecord(entry);
      const label = asString(optionRecord?.label)?.trim() ?? "";
      if (!label) {
        return null;
      }

      return {
        description: asString(optionRecord?.description)?.trim() ?? "",
        label,
      };
    }).filter((entry): entry is WorkbenchUserInputQuestion["options"][number] => entry !== null)
    : [];

  return {
    allowOther: asBoolean(record.allowOther),
    header: asString(record.header)?.trim() ?? "",
    id: asString(record.id)?.trim() || `question-${index + 1}`,
    isSecret: asBoolean(record.isSecret),
    options,
    question: asString(record.question)?.trim() ?? "",
  };
}

function normalizeQuestionnaireRequest(value: unknown): WorkbenchUserInputRequest | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const questions = Array.isArray(record.questions)
    ? record.questions.map((entry, index) => normalizeQuestionnaireQuestion(entry, index)).filter((entry): entry is WorkbenchUserInputQuestion => entry !== null)
    : [];

  const id = asString(record.id)?.trim() ?? "";
  const title = asString(record.title)?.trim() ?? "";
  const summary = asString(record.summary)?.trim() ?? "";
  const submitLabel = asString(record.submitLabel)?.trim() ?? "";
  if (!id || !title || !submitLabel || !questions.length) {
    return null;
  }

  return {
    id,
    questions,
    submitLabel,
    summary,
    title,
  };
}

function normalizeQuestionnaireResponse(value: unknown): WorkbenchUserInputResponse | null {
  const record = asRecord(value);
  const answersRecord = asRecord(record?.answers);
  if (!answersRecord) {
    return null;
  }

  const answers = Object.fromEntries(Object.entries(answersRecord).map(([questionId, answerValue]) => {
    const answerRecord = asRecord(answerValue);
    const answerList = Array.isArray(answerRecord?.answers)
      ? answerRecord.answers.filter((entry): entry is string => typeof entry === "string")
      : [];
    return [questionId, { answers: answerList }];
  }));

  return { answers };
}

function normalizeHistoryEntry(value: unknown): WorkbenchQuestionnaireHistoryEntry | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const request = normalizeQuestionnaireRequest(record.request);
  const response = normalizeQuestionnaireResponse(record.response);
  const requestKey = asString(record.requestKey)?.trim() ?? "";
  const threadId = asString(record.threadId)?.trim() ?? "";
  const turnId = asString(record.turnId)?.trim() ?? "";
  const resolvedAt = asNumber(record.resolvedAt);
  if (!request || !response || !requestKey || !threadId || !turnId || resolvedAt === null) {
    return null;
  }

  return {
    insertAfterItemId: asString(record.insertAfterItemId)?.trim() ?? null,
    insertAfterItemIndex: asNumber(record.insertAfterItemIndex),
    itemId: asString(record.itemId)?.trim() ?? null,
    request,
    requestKey,
    resolvedAt,
    response,
    threadId,
    turnId,
  };
}

function sortHistoryEntries(entries: WorkbenchQuestionnaireHistoryEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.resolvedAt !== right.resolvedAt) {
      return left.resolvedAt - right.resolvedAt;
    }

    return left.requestKey.localeCompare(right.requestKey);
  });
}

export class CodexQuestionnaireStore {
  private readonly rootDirectoryPath: string;

  constructor(projectRoot: string) {
    this.rootDirectoryPath = path.join(projectRoot, ".workbench", "questionnaires", "codex");
  }

  async listThreadHistory(threadId: string) {
    const file = await this.readThreadFile(threadId);
    return file.entries;
  }

  async removeThreadEntry(threadId: string, requestKey: string) {
    const file = await this.readThreadFile(threadId);
    const nextEntries = file.entries.filter((entry) => entry.requestKey !== requestKey);
    await this.writeThreadFile(threadId, nextEntries);
  }

  async upsertThreadEntry(entry: WorkbenchQuestionnaireHistoryEntry) {
    const file = await this.readThreadFile(entry.threadId);
    const nextEntries = sortHistoryEntries([
      ...file.entries.filter((existingEntry) => existingEntry.requestKey !== entry.requestKey),
      entry,
    ]);
    await this.writeThreadFile(entry.threadId, nextEntries);
    return entry;
  }

  private createThreadFilePath(threadId: string) {
    const encodedThreadId = Buffer.from(threadId, "utf8").toString("base64url");
    return path.join(this.rootDirectoryPath, `${encodedThreadId}.json`);
  }

  private async readThreadFile(threadId: string): Promise<StoredCodexQuestionnaireHistoryFile> {
    const filePath = this.createThreadFilePath(threadId);

    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const record = asRecord(parsed);
      const version = asNumber(record?.version);
      const rawEntries = Array.isArray(record?.entries) ? record.entries : [];
      if (version !== STORE_VERSION) {
        return {
          entries: [],
          version: STORE_VERSION,
        };
      }

      return {
        entries: sortHistoryEntries(rawEntries.map(normalizeHistoryEntry).filter((entry): entry is WorkbenchQuestionnaireHistoryEntry => entry !== null)),
        version: STORE_VERSION,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return {
          entries: [],
          version: STORE_VERSION,
        };
      }

      return {
        entries: [],
        version: STORE_VERSION,
      };
    }
  }

  private async writeThreadFile(threadId: string, entries: WorkbenchQuestionnaireHistoryEntry[]) {
    const filePath = this.createThreadFilePath(threadId);
    await fs.mkdir(this.rootDirectoryPath, { recursive: true });

    if (!entries.length) {
      await fs.rm(filePath, { force: true });
      return;
    }

    const payload: StoredCodexQuestionnaireHistoryFile = {
      entries: sortHistoryEntries(entries),
      version: STORE_VERSION,
    };
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
