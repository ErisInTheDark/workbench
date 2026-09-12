/*
 * Exports:
 * - workbenchOptionSelectedClassName/workbenchOptionHoverClassName: shared option surface states.
 * - workbenchOptionRowClassName: compact option surface for navigation and explorer rows.
 * - workbenchNewEntryButtonClassName: reveal compact create-entry controls within entry rows.
 * - workbenchThreadListButtonClassName: full-width thread list button layout and interaction styling.
 * - workbenchThreadListLabelClassName: truncated thread label styling for sidebar rows.
 * - workbenchFloatingToolbarClassName: floating editor toolbar shell layout and responsive behaviour.
 * - workbenchFloatingToolbarGroupClassName: group layout for toolbar button clusters.
 * - workbenchDiffGutterClassName: editor diff gutter container styling.
 * - workbenchRevisionHoverToolbarClassName: revision hover toolbar shell with kind-specific backgrounds.
 * - workbenchRevisionActionButtonClassName: text actions in revision hover toolbars.
 */

export const workbenchRevisionActionButtonClassName = "pointer-events-auto enabled:cursor-pointer min-w-8 rounded-full px-3 py-1 text-sm transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none";

export const workbenchOptionSelectedClassName = "border-[color-mix(in_srgb,var(--text)_22%,transparent)] bg-[color-mix(in_srgb,var(--text)_5%,transparent)] [--option-card-bg:color-mix(in_srgb,var(--text)_5%,var(--fg-bg,var(--bg)))]";
export const workbenchOptionHoverClassName = "hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]";
export const workbenchOptionRowClassName = "inline-flex enabled:cursor-pointer min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition [&:not(:disabled)]:hover:border-[color-mix(in_srgb,var(--text)_22%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-default disabled:opacity-60 md:py-0.5";

export const workbenchNewEntryButtonClassName = "enabled:cursor-pointer md:opacity-0 md:transition-opacity md:duration-150 md:group-hover/entry-row:opacity-100 md:group-has-[:focus-visible]/entry-row:opacity-100";

export const workbenchThreadListButtonClassName = "flex enabled:cursor-pointer w-full min-w-0 items-center rounded-lg px-2 py-1.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:py-1";

export const workbenchThreadListLabelClassName = "block max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";

export const workbenchFloatingToolbarClassName = "pointer-events-none fixed left-0 top-0 z-30 flex max-w-[calc(100vw-1.5rem)] w-max flex-wrap items-start justify-center gap-1 rounded-[1.4rem] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] [--fg-bg:color-mix(in_srgb,var(--bg)_88%,var(--app-bg-solid))] p-1 shadow-float backdrop-blur-xl max-md:w-auto max-md:flex-col max-md:items-center";

export const workbenchFloatingToolbarGroupClassName = "flex min-w-0 flex-wrap items-center justify-center gap-1";

export const workbenchDiffGutterClassName = "pointer-events-none relative select-none opacity-50";

export const workbenchRevisionHoverToolbarClassName = "pointer-events-none fixed left-0 top-0 z-30 flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] [--fg-bg:color-mix(in_srgb,var(--bg)_88%,var(--app-bg-solid))] p-1 shadow-float backdrop-blur-xl data-[revision-kind=ins]:bg-[color-mix(in_srgb,var(--success)_12%,var(--bg)_88%)] data-[revision-kind=ins]:[--fg-bg:color-mix(in_srgb,var(--success)_12%,var(--bg)_88%)] data-[revision-kind=del]:bg-[color-mix(in_srgb,var(--danger)_12%,var(--bg)_88%)] data-[revision-kind=del]:[--fg-bg:color-mix(in_srgb,var(--danger)_12%,var(--bg)_88%)] data-[revision-kind=comment]:bg-[color-mix(in_srgb,var(--text)_8%,var(--bg)_92%)] data-[revision-kind=comment]:[--fg-bg:color-mix(in_srgb,var(--text)_8%,var(--bg)_92%)]";
