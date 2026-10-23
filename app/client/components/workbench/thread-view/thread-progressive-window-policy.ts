/*
 * Exports:
 * - THREAD_WINDOW_CHUNK_SIZE: item count in one committed DOM window chunk.
 * - ROUTINE_THREAD_WINDOW_CHUNKS/URGENT_THREAD_WINDOW_CHUNKS: reveal lookahead.
 * - INITIAL_TRANSCRIPT_ITEM_CREDIT/HISTORY_TRANSCRIPT_ITEM_CREDIT: browser transcript demand, in visible rows.
 */
export const THREAD_WINDOW_CHUNK_SIZE = 6;
export const ROUTINE_THREAD_WINDOW_CHUNKS = 4;
export const URGENT_THREAD_WINDOW_CHUNKS = 16;
/**
 * Visible rows, not raw items (named for the wire): a run of agent work is one row however many items it folds, so a
 * window fills the screen without shipping hundreds of folded steps.
 */
export const INITIAL_TRANSCRIPT_ITEM_CREDIT = 20;
export const HISTORY_TRANSCRIPT_ITEM_CREDIT = 20;
