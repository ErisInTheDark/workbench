/*
 * Exports:
 * - TabVariant: `header` (bold app-shell tabs with a hover fill and solid underline) or `inline` (faded tabs with an optional dotted underline).
 * - TabUnderline: dotted underline colour for a selected `inline` tab.
 * - Tab: one link (`as="a"`) or button (`as="button"`) tab owning selected styling, aria-current and the focus ring.
 * - default Tabs: labelled horizontal tab row.
 */
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";

export type TabVariant = "header" | "inline";

export interface TabUnderline {
  className: string;
  style?: CSSProperties & { [property: `--${string}`]: string | number | undefined };
}

const VARIANTS: Record<TabVariant, { base: string; selected: string; idle: string }> = {
  header: {
    base: `
      relative shrink-0 rounded-lg px-2.5 py-1 text-base font-semibold leading-tight transition-colors
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
      after:(absolute inset-x-2.5 -bottom-1 h-0.5 rounded-full bg-current transition-opacity content-[''])
    `,
    selected: "text-text after:opacity-100",
    idle: "text-fg/muted after:opacity-0 hover:bg-fg/6 hover:text-text",
  },
  inline: {
    base: `
      relative inline-flex min-h-9 items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-[0.95rem] font-medium leading-none
      transition-[color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
    `,
    selected: "text-text",
    idle: "text-fg/muted opacity-60 hover:opacity-80 hover:text-text",
  },
};

interface TabOwnProps {
  children: ReactNode;
  className?: string;
  selected?: boolean;
  /** Dotted underline shown while an `inline` tab is selected; `header` tabs always use their own. */
  underline?: TabUnderline;
  variant: TabVariant;
}

type TabProps =
  | ({ as: "a" } & TabOwnProps & Omit<ComponentPropsWithoutRef<"a">, keyof TabOwnProps>)
  | ({ as: "button" } & TabOwnProps & Omit<ComponentPropsWithoutRef<"button">, keyof TabOwnProps | "type">);

function tabClassName({ className, selected, variant }: Pick<TabOwnProps, "className" | "selected" | "variant">) {
  const styles = VARIANTS[variant];
  return [styles.base, selected ? styles.selected : styles.idle, className].filter(Boolean).join(" ");
}

function TabContent({ children, selected, underline, variant }: Pick<TabOwnProps, "children" | "selected" | "underline" | "variant">) {
  return (
    <>
      {children}
      {variant === "inline" && selected && underline ? (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-1 bottom-0 border-t border-dotted ${underline.className}`}
          style={underline.style}
        />
      ) : null}
    </>
  );
}

export function Tab(props: TabProps) {
  if (props.as === "a") {
    const { as: _as, children, className, selected = false, underline, variant, ...anchor } = props;
    return (
      <a aria-current={selected ? "page" : undefined} {...anchor} className={tabClassName({ className, selected, variant })}>
        <TabContent selected={selected} underline={underline} variant={variant}>{children}</TabContent>
      </a>
    );
  }
  const { as: _as, children, className, selected = false, underline, variant, ...button } = props;
  return (
    <button aria-current={selected ? "page" : undefined} {...button} className={tabClassName({ className, selected, variant })} type="button">
      <TabContent selected={selected} underline={underline} variant={variant}>{children}</TabContent>
    </button>
  );
}

export default function Tabs({ children, className = "", label }: { children: ReactNode; className?: string; label: string }) {
  return <nav aria-label={label} className={className}>{children}</nav>;
}
