/*
 * Exports:
 * - DaemonRequestRoute: where the app sends one daemon request; `app` marks requests the app server owns rather than relays as workspace commands.
 * - DaemonRequestContract/defineDaemonRequest: one daemon request: its params and result types, the response schema clients validate,
 *   and its workspace route.
 */
import type { z } from "zod";

export type DaemonRequestRoute = "thread" | "folder" | "installation" | "session" | "threadCwd" | "app";

export interface DaemonRequestContract<Params, Result, Route extends DaemonRequestRoute> {
  readonly route: Route;
  /** Every response is validated against this before the caller sees it. */
  readonly result: z.ZodType;
  /** The client returns the parsed result, so schema defaults apply, instead of the raw response. */
  readonly parsed?: true;
  /** Types only; never present at runtime. */
  readonly types?: { params: Params; result: Result };
}

/** `defineDaemonRequest<Params, Result>()({ route, result })` keeps the route literal while naming both types explicitly. */
export function defineDaemonRequest<Params, Result>() {
  return <const Route extends DaemonRequestRoute>(contract: { route: Route; result: z.ZodType; parsed?: true }) =>
    contract as DaemonRequestContract<Params, Result, Route>;
}
