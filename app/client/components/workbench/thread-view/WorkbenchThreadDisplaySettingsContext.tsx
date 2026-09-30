/*
 * Exports:
 * - WorkbenchThreadDisplaySettingsContext: owning pane's resolved code-detail preference.
 */
"use client";

import { createContext } from "react";

export const WorkbenchThreadDisplaySettingsContext = createContext<boolean | null>(null);
