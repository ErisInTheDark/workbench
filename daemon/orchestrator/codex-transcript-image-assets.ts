/*
 * Exports:
 * - CodexTranscriptImageAssetContext: recorder-independent destination or retained migration destination.
 * - CodexTranscriptImageAssetExternalization: immutable image externalisation result.
 * - default externalizeCodexTranscriptInlineImages: persist content-addressed image bytes and replace inline URLs.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";

const DATA_IMAGE_URL_PATTERN = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=\s]+)$/iu;
const IMAGE_FIELDS: Readonly<Record<string, string>> = {
  image: "url",
  inputImage: "imageUrl",
  input_image: "image_url",
};

interface AssetDestination {
  encodedThreadId: string;
  threadDirectoryPath: string;
}
export type CodexTranscriptImageAssetContext = AssetDestination | { storageRoot: string; threadId: string };

export interface CodexTranscriptImageAssetExternalization<TValue> {
  assetCount: number;
  changed: boolean;
  value: TValue;
}

function extensionForImageMimeType(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return null;
  }
}

async function writeImageAsset(context: AssetDestination, dataUrl: string) {
  const match = DATA_IMAGE_URL_PATTERN.exec(dataUrl);
  if (!match) {
    return null;
  }

  const [, mimeType, base64Payload] = match;
  const extension = extensionForImageMimeType(mimeType);
  if (!extension) {
    return null;
  }

  const bytes = Buffer.from(base64Payload.replace(/\s+/gu, ""), "base64");
  if (!bytes.length) {
    return null;
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  const fileName = `${digest}.${extension}`;
  const assetsDirectoryPath = path.join(context.threadDirectoryPath, "assets");
  const assetPath = path.join(assetsDirectoryPath, fileName);
  await fs.mkdir(assetsDirectoryPath, { recursive: true });
  await fs.writeFile(assetPath, bytes, { flag: "wx" }).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      throw error;
    }
  });

  return `/api/transcript-assets/codex/${encodeURIComponent(context.encodedThreadId)}/${encodeURIComponent(fileName)}`;
}

async function externalizeValue(
  value: unknown,
  context: AssetDestination,
): Promise<CodexTranscriptImageAssetExternalization<unknown>> {
  if (!value || typeof value !== "object") {
    return {
      assetCount: 0,
      changed: false,
      value,
    };
  }

  if (Array.isArray(value)) {
    let changed = false;
    let assetCount = 0;
    const nextItems: unknown[] = [];
    for (const item of value) {
      const result = await externalizeValue(item, context);
      changed ||= result.changed;
      assetCount += result.assetCount;
      nextItems.push(result.value);
    }
    return {
      assetCount,
      changed,
      value: changed ? nextItems : value,
    };
  }

  const record = value as Record<string, unknown>;
  let changed = false;
  let assetCount = 0;
  const nextRecord: Record<string, unknown> = {};
  const imageField = typeof record.type === "string" ? IMAGE_FIELDS[record.type] : undefined;

  for (const [key, nestedValue] of Object.entries(record)) {
    if (key === imageField && typeof nestedValue === "string") {
      const assetUrl = await writeImageAsset(context, nestedValue);
      if (assetUrl) {
        nextRecord[key] = assetUrl;
        changed = true;
        assetCount += 1;
        continue;
      }
    }

    const result = await externalizeValue(nestedValue, context);
    nextRecord[key] = result.value;
    changed ||= result.changed;
    assetCount += result.assetCount;
  }

  return {
    assetCount,
    changed,
    value: changed ? nextRecord : value,
  };
}

export default async function externalizeCodexTranscriptInlineImages<TValue>(
  value: TValue,
  context: CodexTranscriptImageAssetContext,
): Promise<CodexTranscriptImageAssetExternalization<TValue>> {
  const destination = "storageRoot" in context ? {
    encodedThreadId: encodeTranscriptPathSegment(context.threadId),
    threadDirectoryPath: path.join(context.storageRoot, ".workbench", "transcripts", "codex", "threads", encodeTranscriptPathSegment(context.threadId)),
  } : context;
  const result = await externalizeValue(value, destination);
  return {
    assetCount: result.assetCount,
    changed: result.changed,
    value: result.value as TValue,
  };
}
