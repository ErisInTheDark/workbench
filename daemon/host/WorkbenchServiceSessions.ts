/*
 * Exports:
 * - WorkbenchServiceSessions (default): owns app target registration by live control session.
 */
import { WorkbenchServiceRegistrationSchema, type WorkbenchServiceRegistration } from "../../shared/http/workbench-service.ts";
import type { z } from "zod";

export default class WorkbenchServiceSessions {
  private owner: { registration: WorkbenchServiceRegistration | null; closed: boolean } | null = null;
  constructor(private readonly onChange: () => void) {}

  get current() {
    return this.owner?.registration ? structuredClone(this.owner.registration) : null;
  }

  open() {
    const session: NonNullable<WorkbenchServiceSessions["owner"]> = { registration: null, closed: false };
    return {
      register: (registration: z.input<typeof WorkbenchServiceRegistrationSchema>) => {
        if (session.closed) throw new Error("App registration session is closed.");
        if (session.registration && this.owner !== session) throw new Error("App registration session was superseded.");
        session.registration = WorkbenchServiceRegistrationSchema.parse(registration);
        this.owner = session;
        this.onChange();
      },
      close: () => {
        if (session.closed) return false;
        session.closed = true;
        if (this.owner === session) {
          this.owner = null;
          this.onChange();
          return true;
        }
        return false;
      },
    };
  }
}
