/*
 * Exports:
 * - WorkbenchBrowseTranscriptRecorderPorts: transcript, asset, and notification owners the recorder writes through.
 * - default WorkbenchBrowseTranscriptRecorder: record one Browse result, with its screenshot asset, into the canonical transcript for any provider.
 */
import type { WorkbenchBrowseResultEntry, WorkbenchHarness } from "workbench-shared/types";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import { parseTranscriptAssetAddress } from "workbench-shared/workbench/transcript/transcript-asset-address";
import type WorkbenchDatabaseController from "../../../database/WorkbenchDatabaseController";
import type { DaemonTranscriptRegistration } from "../../../daemon-runtime-objects";

export interface WorkbenchBrowseTranscriptRecorderPorts {
  assets: Pick<WorkbenchDatabaseController, "readTranscriptAsset">;
  transcript: Pick<DaemonTranscriptRegistration, "record">;
  notify(harness: WorkbenchHarness, notification: { method: "browse/result/recorded"; params: { threadId: string; turnId: string } }): void;
}

export default class WorkbenchBrowseTranscriptRecorder {
  constructor(private readonly ports: WorkbenchBrowseTranscriptRecorderPorts) {}

  /** The entry carries Workbench thread and turn identities; the provider only names the live harness. */
  async record(entry: WorkbenchBrowseResultEntry, harness: WorkbenchHarness) {
    const threadId = WorkbenchThreadIdSchema.parse(entry.threadId);
    const turnId = WorkbenchTurnIdSchema.parse(entry.turnId);
    const asset = await this.readAsset(threadId, entry.assetUrl);
    await this.ports.transcript.record(
      [{ kind: "browse", entry: { ...entry, threadId, turnId }, ...(asset ? { asset } : {}) }],
      { source: "workbench" },
    );
    this.ports.notify(harness, { method: "browse/result/recorded", params: { threadId, turnId } });
  }

  private async readAsset(threadId: string, assetUrl: string | null) {
    if (!assetUrl) return undefined;
    const address = parseTranscriptAssetAddress(assetUrl);
    if (!address || address.surface !== "api") throw new Error("Browse asset URL is not a Workbench transcript asset.");
    const asset = await this.ports.assets.readTranscriptAsset({
      threadId: address.threadId, assetName: address.assetName, ownerThreadId: threadId,
    });
    if (!asset) throw new Error("Browse asset was not found in its thread's transcript storage.");
    return { byteLength: asset.byteLength, digest: asset.digest, mimeType: asset.mimeType, storageKey: assetUrl };
  }
}
