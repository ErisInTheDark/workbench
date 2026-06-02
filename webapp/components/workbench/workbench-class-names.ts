/*
 * Exports:
 * - workbenchIconButtonClassName: shared chrome button styling for workbench controls, including invalid save state. Keywords: workbench, button, chrome.
 * - workbenchNewEntryButtonClassName: compact create-entry button styling that reveals within entry rows. Keywords: workbench, explorer, create.
 * - workbenchThreadListButtonClassName: full-width thread list button layout and interaction styling. Keywords: workbench, thread list, button.
 * - workbenchThreadListLabelClassName: truncated thread label styling for sidebar rows. Keywords: workbench, thread list, label.
 * - workbenchFloatingToolbarClassName: floating editor toolbar shell layout and responsive behavior. Keywords: workbench, toolbar, floating.
 * - workbenchFloatingToolbarGroupClassName: shared group layout for toolbar button clusters. Keywords: workbench, toolbar, group.
 * - workbenchDiffGutterClassName: editor diff gutter container styling. Keywords: workbench, editor, diff gutter.
 * - workbenchRevisionHoverToolbarClassName: revision hover toolbar shell with kind-specific background states. Keywords: workbench, revision, toolbar.
 */

export const workbenchIconButtonClassName = "inline-flex min-h-[2.65rem] min-w-[2.65rem] items-center justify-center rounded-[0.7rem] p-[0.55rem] text-inherit transition-[background-color,color,opacity] duration-150 ease-out hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none data-[invalid=true]:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] data-[invalid=true]:text-danger data-[invalid=true]:hover:bg-[color-mix(in_srgb,var(--danger)_18%,transparent)] data-[invalid=true]:focus-visible:bg-[color-mix(in_srgb,var(--danger)_18%,transparent)] [&[data-invalid=true]_.save-icon-slash]:opacity-100 [&[data-invalid=true]_.save-icon-main]:opacity-45";

export const workbenchNewEntryButtonClassName = "!min-h-0 !min-w-0 !p-1 h-full shrink-0 aspect-square md:opacity-0 md:transition-opacity md:duration-150 md:group-hover/entry-row:opacity-100 md:group-focus-within/entry-row:opacity-100";

export const workbenchThreadListButtonClassName = "flex w-full min-w-0 items-center rounded-lg px-2 py-1.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:py-1";

export const workbenchThreadListLabelClassName = "block max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";

export const workbenchFloatingToolbarClassName = "pointer-events-none fixed left-0 top-0 z-30 flex max-w-[calc(100vw-1.5rem)] w-max flex-wrap items-start justify-center gap-1 rounded-[1.4rem] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] p-1 shadow-float backdrop-blur-xl max-md:w-auto max-md:flex-col max-md:items-center";

export const workbenchFloatingToolbarGroupClassName = "flex min-w-0 flex-wrap items-center justify-center gap-1";

export const workbenchDiffGutterClassName = "pointer-events-none relative select-none opacity-50";

export const workbenchRevisionHoverToolbarClassName = "pointer-events-none fixed left-0 top-0 z-30 flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] p-1 shadow-float backdrop-blur-xl data-[revision-kind=ins]:bg-[color-mix(in_srgb,var(--success)_12%,var(--bg)_88%)] data-[revision-kind=del]:bg-[color-mix(in_srgb,var(--danger)_12%,var(--bg)_88%)] data-[revision-kind=comment]:bg-[color-mix(in_srgb,var(--text)_8%,var(--bg)_92%)]";
