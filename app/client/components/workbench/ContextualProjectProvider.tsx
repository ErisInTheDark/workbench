/*
 * Exports:
 * - default ContextualProjectProvider: set the project its descendants belong to. Facts it passes override the enclosing
 *   provider's, so a nested provider can narrow just `cwd`; one ContextualProject exists per fact content.
 */
"use client";

import { useContext, useMemo, type ReactNode } from "react";

import ContextualProject, { type ContextualProjectFacts } from "../../workbench/project/ContextualProject";
import { ContextualProjectContext } from "./use-projects";

export default function ContextualProjectProvider({ children, ...facts }: Partial<ContextualProjectFacts> & { children: ReactNode }) {
  const parent = useContext(ContextualProjectContext);
  const given = Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)) as Partial<ContextualProjectFacts>;
  const candidate = parent ? parent.with(given) : new ContextualProject({ id: null, ...given });
  // Equal content keeps the same instance, so descendants never see a new project for unchanged facts.
  const project = useMemo(() => candidate, [candidate.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <ContextualProjectContext.Provider value={project}>{children}</ContextualProjectContext.Provider>;
}
