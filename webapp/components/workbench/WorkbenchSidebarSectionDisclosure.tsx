/*
 * Exports:
 * - default WorkbenchSidebarSectionDisclosure: render the canonical icon, title, action, and chevron summary for every top-level Workbench sidebar section. Keywords: sidebar, section, disclosure, chevron, icon.
 */
"use client";

import type { ComponentProps, ComponentType, ReactNode } from "react";

import ThreadDisclosure from "./thread-view/ThreadDisclosure";

type WorkbenchSidebarSectionDisclosureProps = Omit<ComponentProps<typeof ThreadDisclosure>, "leading" | "summary"> & {
  actions?: ReactNode;
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
};

export default function WorkbenchSidebarSectionDisclosure({
  actions,
  icon: Icon,
  summaryClassName,
  title,
  ...props
}: WorkbenchSidebarSectionDisclosureProps) {
  return (
    <ThreadDisclosure
      leading={<Icon className="size-4" />}
      summary={(
        <div className="group/entry-row flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-base font-semibold leading-tight text-text">{title}</span>
          {actions}
        </div>
      )}
      summaryClassName={`h-11 text-muted md:h-8${summaryClassName ? ` ${summaryClassName}` : ""}`}
      {...props}
    />
  );
}
