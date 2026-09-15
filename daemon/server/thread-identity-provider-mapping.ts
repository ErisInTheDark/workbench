/*
 * Exports:
 * - WorkbenchProviderIdentityOwners/WorkbenchProviderIdentityAdmissionOwners: committed identity ports.
 * - WorkbenchNativeTurnIdentity: retained native turn destination.
 * - admitProviderThreadItems/mapProviderThreadItem: compatibility entry points for native items.
 * - mapProviderTurn/mapProviderThread: compatibility entry points for native responses.
 * - mapProviderNotification: compatibility entry point for native notifications.
 * - admitProviderThreads/admitProviderNotifications: compatibility entry points for native admission.
 */
export {
  admitProviderThreadItems, mapProviderThreadItem, mapProviderTurn, mapProviderThread,
  mapProviderNotification, admitProviderThreads, admitProviderNotifications,
  type WorkbenchProviderIdentityOwners, type WorkbenchProviderIdentityAdmissionOwners,
  type WorkbenchNativeTurnIdentity,
} from "./CodexProviderIdentity";
