/*
 * Exports:
 * - default WorkbenchFileView: resolve document identity at the view boundary, independent of sidebar readiness, and
 *   show the folder index when the main pane's file tab asks for it.
 */
import { useContext, useSyncExternalStore, type ComponentProps } from "react";
import WorkbenchClientContext from "../workbench-client-context";
import WorkbenchFilePanel from "./WorkbenchFilePanel";
import WorkbenchFolderIndex from "./WorkbenchFolderIndex";

const noSubscription = () => () => {};
const noRevision = () => 0;

export default function WorkbenchFileView({
  route, ...display
}: Omit<ComponentProps<typeof WorkbenchFilePanel>, "location">) {
  const navigator = useContext(WorkbenchClientContext)?.mounted?.projectNavigator;
  useSyncExternalStore(navigator?.subscribe ?? noSubscription, navigator?.getRevision ?? noRevision, noRevision);
  const target = navigator?.fileLocationFor(route) ?? null;
  if (route.fileIndex) return <WorkbenchFolderIndex location={target} route={route} />;
  return <WorkbenchFilePanel {...display} location={target} route={route} />;
}
