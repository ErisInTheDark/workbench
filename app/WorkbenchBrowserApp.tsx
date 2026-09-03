/*
 * Default export:
 * - WorkbenchBrowserApp: select the ordinary Workbench SPA or a chrome-free thread rendering surface from browser location. Keywords: React, route, app shell.
 */
import AgentThreadViewer from "./components/workbench/thread-view/AgentThreadViewer.tsx";
import ThreadRenderLab from "./components/workbench/thread-view/ThreadRenderLab.tsx";
import Workbench from "./components/workbench.tsx";
import WorkbenchClientStateProvider from "./components/workbench/WorkbenchClientStateProvider.tsx";
import WorkbenchClientStateController from "./workbench/state/WorkbenchClientStateController.ts";
import WorkbenchAppRuntimeClient from "./workbench/app/WorkbenchAppRuntimeClient.ts";
import { usePathname } from "./workbench/navigation/browser-navigation.ts";

function threadIdFromPath(pathname: string) {
  const match = /^\/agent\/thread\/([^/]+)\/?$/u.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

export default function WorkbenchBrowserApp({
  controller,
  runtime,
}: {
  controller: WorkbenchClientStateController;
  runtime: WorkbenchAppRuntimeClient;
}) {
  const pathname = usePathname();
  let content;
  if (pathname === "/agent/thread-lab") {
    content = <ThreadRenderLab />;
  } else if (pathname === "/agent/thread" || pathname.startsWith("/agent/thread/")) {
    content = <AgentThreadViewer initialThreadId={threadIdFromPath(pathname)} />;
  } else {
    content = <Workbench appRuntime={runtime} />;
  }
  return (
    <WorkbenchClientStateProvider controller={controller}>
      {content}
    </WorkbenchClientStateProvider>
  );
}
