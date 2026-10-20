/*
 * Exports:
 * - ThreadRowChromeContext: where transcript rows below it sit: on their own (`row`), or as steps inside a run's command
 *   group (`step`), where dedicated renderers draw one step line instead of their standalone card.
 */
import { createContext } from "react";

export const ThreadRowChromeContext = createContext<"row" | "step">("row");
