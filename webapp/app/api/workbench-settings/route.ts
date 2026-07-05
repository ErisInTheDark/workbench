/*
 * Exports:
 * - runtime/dynamic: force local capability settings onto the Node.js runtime without static caching. Keywords: settings, local capabilities, node runtime.
 * - GET: read server-backed Workbench local capability settings. Keywords: settings, capabilities, browse.
 * - PUT: update server-backed Workbench local capability settings. Keywords: settings, capabilities, browse, update.
 */
import { NextRequest, NextResponse } from "next/server";

import type {
  WorkbenchLocalCapabilitySettingsResponse,
  WorkbenchLocalCapabilitySettingsUpdateRequest,
} from "../../../lib/types";
import WorkbenchServerSettings from "../../../lib/workbench/settings/WorkbenchServerSettings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readLocalCapabilityUpdate(value: unknown): WorkbenchLocalCapabilitySettingsUpdateRequest | null {
  if (!isRecord(value) || !isRecord(value.localCapabilities)) {
    return null;
  }

  const update: WorkbenchLocalCapabilitySettingsUpdateRequest = {
    localCapabilities: {},
  };
  if (typeof value.localCapabilities.browseRawCommandsEnabled === "boolean") {
    update.localCapabilities.browseRawCommandsEnabled = value.localCapabilities.browseRawCommandsEnabled;
  }

  return update;
}

function settingsResponse(localCapabilities: WorkbenchLocalCapabilitySettingsResponse["localCapabilities"]) {
  return NextResponse.json({
    localCapabilities,
  } satisfies WorkbenchLocalCapabilitySettingsResponse, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function GET() {
  try {
    const settings = new WorkbenchServerSettings();
    return settingsResponse(await settings.readLocalCapabilities());
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to read Workbench settings.",
    }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const update = readLocalCapabilityUpdate(await request.json().catch(() => null));
    if (!update) {
      return NextResponse.json({ error: "A valid Workbench settings update is required." }, { status: 400 });
    }

    const settings = new WorkbenchServerSettings();
    const localCapabilities = await settings.updateLocalCapabilities((current) => ({
      ...current,
      ...(typeof update.localCapabilities.browseRawCommandsEnabled === "boolean"
        ? { browseRawCommandsEnabled: update.localCapabilities.browseRawCommandsEnabled }
        : {}),
    }));
    return settingsResponse(localCapabilities);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to update Workbench settings.",
    }, { status: 400 });
  }
}
