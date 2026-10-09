/*
 * Exports:
 * - ComposerReferenceSchema/ComposerReference: one piece of context a user hands an agent alongside a message (todo, feedback report, or failed update issue).
 * - ComposerReferenceKind: the reference kinds.
 * - COMPOSER_REFERENCE_TEXT_MAX_LENGTH: longest accepted reference body.
 * - composerReferenceKey: stable identity of one reference within a message or draft.
 * - composerReferenceBlock: the agent-facing tag block for one reference; also what a pill tooltip shows.
 * - createComposerReferenceMessage: lead a message with its reference blocks.
 * - readComposerReferenceMessage: split a message led by reference blocks back into references and the user's own text.
 */
import { z } from "zod";
import { WorkbenchFeedbackCategorySchema } from "../stats/workbench-stats-feedback-contract.ts";
import { defineTagWrapper } from "./tag-wrapper.ts";

export const COMPOSER_REFERENCE_TEXT_MAX_LENGTH = 8_000;

const body = z.string().trim().min(1).max(COMPOSER_REFERENCE_TEXT_MAX_LENGTH);
const id = z.number().int().nonnegative();
const time = z.number().int().nonnegative();

export const ComposerReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("todo"), id, required: z.boolean(), createdAt: time, text: body }).strict(),
  z.object({
    kind: z.literal("feedback"), id,
    /** The daemon storing the report; ids are only unique per daemon. Absent when read back from message text. */
    daemonId: z.string().min(1).nullable(),
    category: WorkbenchFeedbackCategorySchema,
    title: z.string().trim().min(1).max(120),
    author: z.string().trim().min(1).max(260),
    thread: z.string().trim().min(1).max(400),
    createdAt: time,
    report: body,
  }).strict(),
  z.object({ kind: z.literal("updateIssue"), text: body }).strict(),
]);
export type ComposerReference = z.infer<typeof ComposerReferenceSchema>;
export type ComposerReferenceKind = ComposerReference["kind"];

const TODO = defineTagWrapper("wb:todo", { attributes: ["id", "required", "created"] });
const FEEDBACK = defineTagWrapper("wb:feedback", { attributes: ["id", "category", "title", "author", "thread", "created"] });
const UPDATE_ISSUE = defineTagWrapper("wb:update-issue", { attributes: [] });
const OPENING = /^<(wb:todo|wb:feedback|wb:update-issue)[ >]/u;

const seconds = (ms: number) => String(Math.floor(ms / 1000));

/** A body line identical to the closing tag would end its block early; a leading space keeps it literal. */
function guardBody(text: string, tagName: string) {
  const closing = `</${tagName}>`;
  return text.trim().split("\n").map(line => line === closing ? ` ${line}` : line).join("\n");
}

export function composerReferenceKey(reference: ComposerReference) {
  return reference.kind === "todo" ? `todo:${reference.id}`
    : reference.kind === "feedback" ? `feedback:${reference.daemonId ?? ""}:${reference.id}`
      : `updateIssue:${reference.text}`;
}

export function composerReferenceBlock(reference: ComposerReference) {
  switch (reference.kind) {
    case "todo":
      return TODO.wrap(guardBody(reference.text, TODO.tagName), {
        id: String(reference.id), required: String(reference.required), created: seconds(reference.createdAt),
      });
    case "feedback":
      return FEEDBACK.wrap(guardBody(reference.report, FEEDBACK.tagName), {
        id: String(reference.id), category: reference.category, title: reference.title,
        author: reference.author, thread: reference.thread, created: seconds(reference.createdAt),
      });
    case "updateIssue":
      return UPDATE_ISSUE.wrap(guardBody(reference.text, UPDATE_ISSUE.tagName), {});
  }
}

export function createComposerReferenceMessage(references: readonly ComposerReference[], message: string) {
  const text = message.trim();
  if (!references.length) return text;
  const blocks = references.map(composerReferenceBlock).join("\n\n");
  return text ? `${blocks}\n\n${text}` : blocks;
}

function integer(value: string) {
  return /^\d+$/u.test(value) ? Number(value) : null;
}

function parseBlock(tagName: string, block: string): ComposerReference | null {
  if (tagName === TODO.tagName) {
    const value = TODO.read(block);
    const todoId = value && integer(value.attributes.id);
    const created = value && integer(value.attributes.created);
    if (!value || todoId === null || created === null) return null;
    return ComposerReferenceSchema.safeParse({
      kind: "todo", id: todoId, required: value.attributes.required === "true", createdAt: created * 1000, text: value.body,
    }).data ?? null;
  }
  if (tagName === FEEDBACK.tagName) {
    const value = FEEDBACK.read(block);
    const feedbackId = value && integer(value.attributes.id);
    const created = value && integer(value.attributes.created);
    if (!value || feedbackId === null || created === null) return null;
    return ComposerReferenceSchema.safeParse({
      kind: "feedback", id: feedbackId, daemonId: null, category: value.attributes.category, title: value.attributes.title,
      author: value.attributes.author, thread: value.attributes.thread, createdAt: created * 1000, report: value.body,
    }).data ?? null;
  }
  const value = UPDATE_ISSUE.read(block);
  return value ? ComposerReferenceSchema.safeParse({ kind: "updateIssue", text: value.body }).data ?? null : null;
}

/** Only blocks leading the message count; anything else, including a malformed block, leaves the message plain. */
export function readComposerReferenceMessage(text: string): { references: ComposerReference[]; message: string } | null {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const references: ComposerReference[] = [];
  let index = 0;
  for (;;) {
    while (index < lines.length && !lines[index]!.trim()) index += 1;
    const tagName = OPENING.exec(lines[index] ?? "")?.[1];
    if (!tagName) break;
    const closing = lines.indexOf(`</${tagName}>`, index + 1);
    if (closing < 0) return null;
    const reference = parseBlock(tagName, lines.slice(index, closing + 1).join("\n"));
    if (!reference) return null;
    references.push(reference);
    index = closing + 1;
  }
  return references.length ? { references, message: lines.slice(index).join("\n").trim() } : null;
}
