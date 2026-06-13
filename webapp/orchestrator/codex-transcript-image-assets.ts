/*
 * Exports:
 * - CodexTranscriptImageAssetContext: thread-local destination for externalized transcript image assets. Keywords: codex, transcript, image assets.
 * - CodexTranscriptImageAssetExternalization: result of replacing inline transcript data URLs with local asset URLs. Keywords: codex, transcript, image assets.
 * - externalizeCodexTranscriptInlineImages: persist inline image data URLs as hashed files and rewrite transcript JSON. Keywords: codex, transcript, image assets.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const DATA_IMAGE_URL_PATTERN = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=\s]+)$/iu;

export interface CodexTranscriptImageAssetContext {
  encodedThreadId: string;
  threadDirectoryPath: string;
}

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

async function writeImageAsset(context: CodexTranscriptImageAssetContext, dataUrl: string) {
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

function shouldExternalizeUserImageRecord(record: Record<string, unknown>) {
  return record.type === "image" && typeof record.url === "string";
}

function shouldExternalizeInputImageRecord(record: Record<string, unknown>) {
  return record.type === "inputImage" && typeof record.imageUrl === "string";
}

async function externalizeValue(
  value: unknown,
  context: CodexTranscriptImageAssetContext,
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

  for (const [key, nestedValue] of Object.entries(record)) {
    if (key === "url" && shouldExternalizeUserImageRecord(record)) {
      const assetUrl = await writeImageAsset(context, nestedValue as string);
      if (assetUrl) {
        nextRecord[key] = assetUrl;
        changed = true;
        assetCount += 1;
        continue;
      }
    }

    if (key === "imageUrl" && shouldExternalizeInputImageRecord(record)) {
      const assetUrl = await writeImageAsset(context, nestedValue as string);
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
  const result = await externalizeValue(value, context);
  return {
    assetCount: result.assetCount,
    changed: result.changed,
    value: result.value as TValue,
  };
}
