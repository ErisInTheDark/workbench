/*
 * Exports:
 * - default WorkbenchFileView: resolve document identity at the view boundary, independent of sidebar readiness.
 */
import { useContext, useSyncExternalStore, type ComponentProps } from "react";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import WorkbenchClientContext from "../workbench-client-context";
import WorkbenchFilePanel from "./WorkbenchFilePanel";

const noSubscription = () => () => {};
const noRevision = () => 0;

export default function WorkbenchFileView({
  route, location, ...display
}: Omit<ComponentProps<typeof WorkbenchFilePanel>, "location"> & {
  route: WorkbenchRoute;
  location?: ComponentProps<typeof WorkbenchFilePanel>["location"];
}) {
  const navigator = useContext(WorkbenchClientContext)?.mounted?.projectNavigator;
  useSyncExternalStore(navigator?.subscribe ?? noSubscription, navigator?.getRevision ?? noRevision, noRevision);
  const target = location ?? navigator?.fileLocationFor(route) ?? null;
  return <WorkbenchFilePanel {...display} location={target} />;
}
