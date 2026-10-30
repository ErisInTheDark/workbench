/*
 * Exports:
 * - useNetworkReach: the daemons this tab's app reaches, and the hostname each is known by, for networked-thread checks.
 */
import { useMemo, useSyncExternalStore } from "react";
import type { DaemonId } from "workbench-shared/workbench/identity";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import { useWorkbenchClientController } from "../../components/workbench/workbench-client-context";

const NO_SUBSCRIPTION = () => () => undefined;

export function useNetworkReach() {
  const facts = useWorkbenchClientController().mounted?.projectFacts ?? null;
  const sources = useSyncExternalStore(facts?.subscribe ?? NO_SUBSCRIPTION,
    () => facts?.getData()?.sources ?? null, () => facts?.getData()?.sources ?? null);
  return useMemo(() => {
    const hostnames = new Map<DaemonId, string>();
    for (const source of sources ?? []) hostnames.set(DaemonIdSchema.parse(source.daemonId), source.hostname);
    const reach = new Set((sources ?? []).filter(source => source.connection !== "revoked").map(source => DaemonIdSchema.parse(source.daemonId)));
    return { reach, hostname: (daemonId: DaemonId) => hostnames.get(daemonId) ?? daemonId };
  }, [sources]);
}
