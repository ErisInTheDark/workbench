/*
 * Exports:
 * - default ThreadTextPresentationContext: provide the shared text owner to chrome-free transcript leaves.
 */
"use client";

import { createContext } from "react";
import type ThreadTextPresentationController from "../../workbench/thread/ThreadTextPresentationController";

const ThreadTextPresentationContext = createContext<ThreadTextPresentationController | null>(null);
export default ThreadTextPresentationContext;
