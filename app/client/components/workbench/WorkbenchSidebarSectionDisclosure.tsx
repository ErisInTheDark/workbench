/*
 * Exports:
 * - default WorkbenchSidebarSectionDisclosure: render the canonical icon, title, action, and chevron summary for every top-level Workbench sidebar section.
 */
"use client";

import type { ComponentProps, ComponentType, ReactNode } from "react";

import Disclosure from "../ui/Disclosure";
import type { IconProps } from "./workbench-icons";
import {
  useWorkbenchSidebarPreferences,
  type WorkbenchSidebarDisclosurePreferenceKey,
} from "./workbench-sidebar-preferences-context";

type WorkbenchSidebarSectionDisclosureProps = Omit<
  ComponentProps<typeof Disclosure>,
  "defaultOpen" | "initialOpen" | "leading" | "onToggle" | "open" | "summary"
> & {
  actions?: ReactNode;
  icon: ComponentType<IconProps>;
  onOpenChange?: (open: boolean) => void;
  preferenceKey: WorkbenchSidebarDisclosurePreferenceKey;
  title: ReactNode;
};

export default function WorkbenchSidebarSectionDisclosure({
  actions,
  className,
  icon: Icon,
  onOpenChange,
  preferenceKey,
  summaryClassName,
  title,
  ...props
}: WorkbenchSidebarSectionDisclosureProps) {
  const { preferences, setDisclosureOpen } = useWorkbenchSidebarPreferences();
  const disclosureClassName = ["pl-3", className].filter(Boolean).join(" ");
  const disclosureSummaryClassName = ["-ml-3", "h-11 text-fg/muted md:h-8", summaryClassName].filter(Boolean).join(" ");
  return (
    <Disclosure
      className={disclosureClassName}
      compactSummary
      leading={<Icon size={16} />}
      onToggle={(event) => {
        setDisclosureOpen(preferenceKey, event.currentTarget.open);
        onOpenChange?.(event.currentTarget.open);
      }}
      open={preferences[preferenceKey]}
      summary={(
        <div className="group/entry-row flex min-w-0 items-center justify-between gap-1">
          <span className="min-w-0 truncate text-base font-semibold leading-tight text-text">{title}</span>
          {actions}
        </div>
      )}
      summaryClassName={disclosureSummaryClassName}
      {...props}
    />
  );
}
