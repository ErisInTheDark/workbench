/*
 * Exports:
 * - frameCodexAttachmentInput: name images only in the native Codex wire input.
 * - stripCodexAttachmentFrames: remove complete native attachment envelopes before canonical admission.
 */
import { z } from "zod";
import { conformToZodSchema } from "../workbench/zod-schema-conformer.ts";
import type { UserInput } from "./generated/app-server/v2/UserInput.ts";

const partHeader = z.object({ type: z.string(), text: z.string().optional() });
const openFrame = /^<wb:attachment id="attach:[1-9]\d*">$/u;
const closeFrame = "</wb:attachment>";

function header(part: unknown) {
  return conformToZodSchema(partHeader, part, { type: "" }).data;
}

function isImage(part: unknown) {
  const { type } = header(part);
  return type === "image" || type === "localImage";
}

export function frameCodexAttachmentInput<Part>(input: readonly Part[]): Array<Part | Extract<UserInput, { type: "text" }>> {
  let number = 0;
  return input.flatMap((part): Array<Part | Extract<UserInput, { type: "text" }>> => isImage(part) ? [
    { type: "text", text: `<wb:attachment id="attach:${++number}">`, text_elements: [] },
    part,
    { type: "text", text: closeFrame, text_elements: [] },
  ] : [part]);
}

export function stripCodexAttachmentFrames<Part>(input: readonly Part[]): Part[] {
  const result: Part[] = [];
  for (let index = 0; index < input.length; index++) {
    const opening = header(input[index]);
    const closing = header(input[index + 2]);
    if (opening.type === "text" && openFrame.test(opening.text ?? "") && isImage(input[index + 1])
      && closing.type === "text" && closing.text === closeFrame) {
      result.push(input[index + 1]);
      index += 2;
    } else result.push(input[index]);
  }
  return result;
}
