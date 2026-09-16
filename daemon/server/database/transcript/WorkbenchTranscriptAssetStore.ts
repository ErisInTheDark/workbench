/*
 * Exports:
 * - TranscriptAssetWrite: validated thread reference and image upload.
 * - TranscriptAssetRead: compatibility address and optional expected thread owner.
 * - TranscriptAssetContent: immutable image metadata and bytes.
 * - default WorkbenchTranscriptAssetStore: own atomic immutable content and thread-scoped addresses.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import { encodeTranscriptPathSegment } from "../../codex-transcript-normalizers.ts";

export interface TranscriptAssetWrite {
  threadId: string;
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  expectedDigest?: string;
  compatibilityAddress?: string;
}

export interface TranscriptAssetRead {
  threadId: string;
  assetName: string;
  ownerThreadId?: string;
}

export interface TranscriptAssetContent {
  bytes: Uint8Array;
  byteLength: number;
  digest: string;
  mimeType: string;
  assetUrl: string;
}

const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as const;
const assetPattern = /^([a-f0-9]{64})\.(png|jpg|webp|gif)$/u;

export default class WorkbenchTranscriptAssetStore {
  constructor(private readonly database: Database.Database) {}

  write(input: TranscriptAssetWrite): Omit<TranscriptAssetContent, "bytes"> {
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.length) throw new Error("Transcript image bytes are empty or invalid.");
    const extension = extensions[input.mimeType];
    if (!extension) throw new Error("Unsupported transcript image type.");
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    if (input.expectedDigest !== undefined && input.expectedDigest !== digest) throw new Error("Transcript image digest does not match its bytes.");
    const assetName = `${digest}.${extension}`;
    return this.database.transaction(() => {
      const thread = new WorkbenchThreadIdentityRepository(this.database).resolve({
        threadId: ThreadReferenceSchema.parse(input.threadId), harness: "codex",
      });
      if (!thread) throw new Error("Transcript image thread has not been admitted.");
      const assetUrl = `/api/transcript-assets/codex/${encodeURIComponent(thread.threadId)}/${assetName}`;
      const existing = this.database.prepare("SELECT mime_type, byte_length FROM transcript_assets WHERE digest = ?")
        .get(digest) as { mime_type: string; byte_length: number } | undefined;
      if (existing && (existing.mime_type !== input.mimeType || existing.byte_length !== input.bytes.byteLength)) {
        throw new Error("Transcript image content-addressed metadata changed.");
      }
      this.database.prepare(`INSERT OR IGNORE INTO transcript_assets(digest, mime_type, byte_length, storage_key, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(digest, input.mimeType, input.bytes.byteLength, assetUrl, Date.now());
      const retained = this.database.prepare("SELECT bytes FROM transcript_asset_content WHERE digest = ?").get(digest) as { bytes: Uint8Array } | undefined;
      if (retained && !Buffer.from(retained.bytes).equals(input.bytes)) throw new Error("Transcript image content-addressed bytes changed.");
      this.database.prepare("INSERT OR IGNORE INTO transcript_asset_content(digest, bytes) VALUES (?, ?)").run(digest, input.bytes);
      for (const address of new Set([thread.threadId, encodeTranscriptPathSegment(input.threadId), input.compatibilityAddress].filter(value => value !== undefined))) {
        if (!/^[A-Za-z0-9_-]+$/u.test(address)) throw new Error("Invalid transcript image compatibility address.");
        this.database.prepare(`INSERT OR IGNORE INTO transcript_asset_addresses(thread_id, address, asset_name, digest)
          VALUES (?, ?, ?, ?)`).run(thread.threadId, address, assetName, digest);
      }
      return { byteLength: input.bytes.byteLength, digest, mimeType: input.mimeType, assetUrl };
    })();
  }

  read(input: TranscriptAssetRead): TranscriptAssetContent | null {
    const match = assetPattern.exec(input.assetName);
    if (!match || !/^[A-Za-z0-9_-]+$/u.test(input.threadId)) throw new Error("Invalid transcript image address.");
    return this.database.transaction(() => {
      const identities = new WorkbenchThreadIdentityRepository(this.database);
      const thread = identities.resolve({ threadId: ThreadReferenceSchema.parse(input.threadId), harness: "codex" });
      const addresses = thread
        ? this.database.prepare("SELECT DISTINCT thread_id, digest FROM transcript_asset_addresses WHERE thread_id = ? AND asset_name = ?").all(thread.threadId, input.assetName)
        : this.database.prepare("SELECT DISTINCT thread_id, digest FROM transcript_asset_addresses WHERE address = ? AND asset_name = ?").all(input.threadId, input.assetName);
      const owners = addresses as Array<{ thread_id: string; digest: string }>;
      if (owners.length > 1) throw new Error("Transcript image address has ambiguous thread ownership.");
      const owner = owners[0];
      if (!owner) return null;
      if (input.ownerThreadId !== undefined) {
        const expected = identities.resolve({ threadId: ThreadReferenceSchema.parse(input.ownerThreadId), harness: "codex" });
        if (expected?.threadId !== owner.thread_id) throw new Error("Transcript image belongs to another thread.");
      }
      const content = this.database.prepare(`SELECT c.bytes, a.mime_type, a.byte_length FROM transcript_asset_content c
        JOIN transcript_assets a ON a.digest = c.digest WHERE c.digest = ?`).get(owner.digest) as
        { bytes: Uint8Array; mime_type: string; byte_length: number } | undefined;
      if (!content) return null;
      if (owner.digest !== match[1] || content.byte_length !== content.bytes.byteLength
        || createHash("sha256").update(content.bytes).digest("hex") !== owner.digest) {
        throw new Error("Transcript image bytes do not match their stored digest.");
      }
      return {
        bytes: content.bytes, byteLength: content.byte_length, digest: owner.digest, mimeType: content.mime_type,
        assetUrl: `/api/transcript-assets/codex/${encodeURIComponent(input.threadId)}/${input.assetName}`,
      };
    })();
  }
}
