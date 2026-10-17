/*
 * Exports:
 * - workbenchOptionSelectedClassName/workbenchOptionHoverClassName: shared option surface states.
 * - workbenchOptionRowClassName: compact option surface for navigation and explorer rows.
 * - workbenchNewEntryButtonClassName: reveal compact create-entry controls within entry rows.
 * - workbenchThreadListButtonClassName: full-width thread list button layout and interaction styling.
 * - workbenchThreadListLabelClassName: truncated thread label styling for sidebar rows.
 * - workbenchDiffGutterClassName: editor diff gutter container styling.
 * - workbenchRevisionHoverToolbarClassName: floating revision toolbar shell; the controller tints it per revision kind.
 * - workbenchRevisionActionButtonClassName: text actions in revision hover toolbars.
 */

export const workbenchRevisionActionButtonClassName = "pointer-events-auto enabled:cursor-pointer min-w-8 rounded-full px-3 py-1 text-sm transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none";

export const workbenchOptionSelectedClassName = "border-fg-alpha/22 bg-fg/5";
export const workbenchOptionHoverClassName = "hover:bg-fg/3";
export const workbenchOptionRowClassName = "inline-flex enabled:cursor-pointer min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition [&:not(:disabled)]:hover:border-fg-alpha/22 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-default disabled:opacity-60 md:py-0.5";

export const workbenchNewEntryButtonClassName = "enabled:cursor-pointer md:opacity-0 md:transition-opacity md:duration-150 md:group-hover/entry-row:opacity-100 md:group-has-[:focus-visible]/entry-row:opacity-100";

export const workbenchThreadListButtonClassName = "flex enabled:cursor-pointer w-full min-w-0 items-center rounded-lg px-2 py-1.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:py-1";

export const workbenchThreadListLabelClassName = "block max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";

export const workbenchDiffGutterClassName = "pointer-events-none relative select-none opacity-50";

export const workbenchRevisionHoverToolbarClassName = "pointer-events-none fixed left-0 top-0 z-30 flex items-center gap-1 rounded-full p-1 backdrop-blur-xl";
