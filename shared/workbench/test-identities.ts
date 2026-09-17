/*
 * testProjectIds: Shared admitted project identities for tests, distinct from legacy address fixtures.
 */
import { ProjectIdSchema } from "./identity";

export const testProjectIds = {
  project: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000001"),
  other: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000002"),
  foreign: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000003"),
  first: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000004"),
  second: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000005"),
  otherProject: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000006"),
  repo: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000007"),
  fixture: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000008"),
  independent: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000009"),
  workbench: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000010"),
} as const;
