/*
 * Exports:
 * - default ThreadExpandedContext: whether every step and card starts open; only fixture previews shown to agents set it,
 *   so their screenshots show bodies nobody can click open.
 */
import { createContext } from "react";

const ThreadExpandedContext = createContext(false);

export default ThreadExpandedContext;
