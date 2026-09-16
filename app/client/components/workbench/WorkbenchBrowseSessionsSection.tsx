"use client";

/*
 * Exports:
 * - default WorkbenchBrowseSessionsSection: subscribed Browse-session sidebar presentation and intents.
 */

import { useCallback, useSyncExternalStore } from "react";

import type { WorkbenchBrowseSessionSummary } from "workbench-shared/types";
import { writeTextToClipboard } from "../../workbench/dom/clipboard";
import type WorkbenchBrowseSessionController from "../../workbench/browse/WorkbenchBrowseSessionController";
import { BrowseSessionsList } from "./workbench-explorer";
import {
  ArchiveIcon,
  BrowserSessionIcon,
  CopyIcon,
  StopIcon,
} from "./workbench-icons";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";
import WorkbenchSidebarSectionDisclosure from "./WorkbenchSidebarSectionDisclosure";

export default function WorkbenchBrowseSessionsSection({
  controller,
}: {
  controller: WorkbenchBrowseSessionController;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const getSessionContextMenu = useCallback((
    session: WorkbenchBrowseSessionSummary,
  ): WorkbenchContextMenuDefinition => ({
    id: `browse-session:${session.name}`,
    items: [
      {
        icon: <CopyIcon size={16} />,
        id: "copy-session",
        label: "Copy session name",
        onSelect: () => {
          void writeTextToClipboard(session.name);
        },
      },
      {
        icon: <StopIcon size={16} />,
        id: "stop-session",
        label: "Stop session",
        onSelect: () => {
          void controller.update(session, "stop");
        },
      },
      {
        icon: <StopIcon size={16} />,
        id: "force-stop-session",
        label: "Force stop session",
        onSelect: () => {
          void controller.update(session, "stop", { force: true });
        },
        tone: "danger",
      },
      {
        icon: <ArchiveIcon size={16} />,
        id: "forget-session",
        label: "Forget record",
        onSelect: () => {
          void controller.update(session, "forget");
        },
      },
    ],
    label: `Browse session actions for ${session.name}`,
  }), [controller]);

  if (!snapshot.sessions.length) return null;

  return (
    <section className="shrink-0 pb-5">
      <WorkbenchSidebarSectionDisclosure
        contentClassName="space-y-2"
        icon={BrowserSessionIcon}
        preferenceKey="browseSessionsOpen"
        title="Browse sessions"
      >
        <BrowseSessionsList
          getSessionContextMenu={getSessionContextMenu}
          isLoading={snapshot.isLoading}
          sessions={[...snapshot.sessions]}
        />
        {snapshot.error ? (
          <p className="m-0 pr-2 text-[0.84rem] leading-6 text-danger">
            {snapshot.error}
          </p>
        ) : null}
      </WorkbenchSidebarSectionDisclosure>
    </section>
  );
}
