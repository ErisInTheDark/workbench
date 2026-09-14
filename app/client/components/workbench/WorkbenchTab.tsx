/*
 * Keywords: tabs, selection, navigation, underline.
 * Exports:
 * - default WorkbenchTab: shared selected-tab presentation for navigation links and local choices.
 */
import type { MouseEvent, ReactNode } from "react";

type TabProps = {
  children: ReactNode;
  selected: boolean;
} & ({
  href: string;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
} | {
  href?: never;
  onClick: () => void;
});

export default function WorkbenchTab(props: TabProps) {
  const className = `
    inline-flex max-w-full items-center border-b-2 pb-1 font-semibold transition
    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
    ${props.selected ? "border-text text-text" : "border-transparent text-fg/muted hover:text-text"}
  `;
  const content = <span className="truncate">{props.children}</span>;
  return props.href !== undefined
    ? <a aria-selected={props.selected} className={className} href={props.href} onClick={props.onClick} role="tab">{content}</a>
    : <button aria-selected={props.selected} className={className} onClick={props.onClick} role="tab" type="button">{content}</button>;
}
