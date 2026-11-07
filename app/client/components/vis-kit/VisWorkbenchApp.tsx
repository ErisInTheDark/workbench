/*
 * Exports:
 * - default VisWorkbenchApp: boot the real Workbench browser app inside a vis page on a fake app server answering from a
 *   VisWorld, opened at one route, with a strip listing whatever the world could not answer.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import WorkbenchBrowserApp from "../../WorkbenchBrowserApp";
import WorkbenchAppBootstrap from "../../workbench/app/WorkbenchAppBootstrap";
import WorkbenchAppRpcClient from "../../workbench/app/WorkbenchAppRpcClient";
import { WorkspaceTestSocket } from "../../workbench/app/workspace-client-fixture";
import { installBrowserNavigationEvents } from "../../workbench/navigation/browser-navigation";
import VisAppServer from "./vis-app-server";
import type VisWorld from "./vis-world";

const NONE: readonly string[] = [];
let navigationInstalled = false;

function boot(world: VisWorld) {
  let server: VisAppServer | null = null;
  const servers = new Set<() => void>();
  const rpc = new WorkbenchAppRpcClient({
    origin: "http://127.0.0.1:4000",
    socket: url => {
      const socket = new WorkspaceTestSocket(url);
      server?.dispose();
      server = new VisAppServer(socket, world);
      for (const listener of servers) listener();
      // The transport attaches its listeners after creating the socket.
      setTimeout(() => socket.open(), 0);
      return socket as unknown as WebSocket;
    },
  });
  return {
    app: new WorkbenchAppBootstrap({ loadedFrontendGeneration: null, rpc }),
    server: () => server,
    onServer(listener: () => void) { servers.add(listener); return () => { servers.delete(listener); }; },
    dispose() { server?.dispose(); },
  };
}

function Unhandled({ booted }: { booted: ReturnType<typeof boot> }) {
  const subscribe = (listener: () => void) => {
    let stop = booted.server()?.subscribe(listener) ?? (() => {});
    const stopServer = booted.onServer(() => { stop(); stop = booted.server()?.subscribe(listener) ?? (() => {}); listener(); });
    return () => { stop(); stopServer(); };
  };
  const unhandled = useSyncExternalStore(subscribe, () => booted.server()?.getUnhandled() ?? NONE);
  if (!unhandled.length) return null;
  return <div role="status" className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[0.74rem] text-amber-700 dark:text-amber-300">
    Not modelled by this vis world: {unhandled.join(", ")}
  </div>;
}

/** The shell sizes itself to the viewport, so a fixed frame keeps the vis page from growing with it. */
export default function VisWorkbenchApp({ world, href, height = 640 }: { world: VisWorld; href: string; height?: number }) {
  const [booted, setBooted] = useState<ReturnType<typeof boot> | null>(null);
  useEffect(() => {
    if (!navigationInstalled) { installBrowserNavigationEvents(); navigationInstalled = true; }
    window.history.replaceState(window.history.state, "", href);
    document.documentElement.dataset.workbenchTheme = "default";
    const next = boot(world);
    setBooted(next);
    next.app.start();
    return () => { next.app.dispose(); next.dispose(); };
  }, [world, href]);
  if (!booted) return null;
  return <>
    <Unhandled booted={booted} />
    <div className="relative overflow-hidden" style={{ height }}>
      <WorkbenchBrowserApp controller={booted.app.state} runtime={booted.app.runtime} rpc={booted.app.rpc} workspace={booted.app.workspace} />
    </div>
  </>;
}
