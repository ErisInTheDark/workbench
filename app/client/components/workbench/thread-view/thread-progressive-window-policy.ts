/*
 * Exports:
 * - THREAD_WINDOW_CHUNK_SIZE: item count in one committed DOM window chunk.
 * - ROUTINE_THREAD_WINDOW_CHUNKS/URGENT_THREAD_WINDOW_CHUNKS: reveal lookahead.
 * - INITIAL_TRANSCRIPT_ITEM_CREDIT/HISTORY_TRANSCRIPT_ITEM_CREDIT: browser transcript item demand.
 */
export const THREAD_WINDOW_CHUNK_SIZE = 6;
export const ROUTINE_THREAD_WINDOW_CHUNKS = 4;
export const URGENT_THREAD_WINDOW_CHUNKS = 16;
export const INITIAL_TRANSCRIPT_ITEM_CREDIT = THREAD_WINDOW_CHUNK_SIZE * URGENT_THREAD_WINDOW_CHUNKS;
/**
 * Raw items, not render entries: one coordination or command group can fold hundreds of items into a single row, so
 * history pages are sized for visible progress per request rather than for one DOM chunk.
 */
export const HISTORY_TRANSCRIPT_ITEM_CREDIT = 256;
