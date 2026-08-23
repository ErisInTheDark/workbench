### declare reload scopes for Workbench source changes

Add `reloadScopes` to `mcp__wb__git_arc_plan` or `mcp__wb__git_arc_plan_start` when the planned files require runtime reloads.

Reload-scope claims are shared barriers. They do not block another arc from editing files in the same scope. They block the runtime reload until every scope claimant is safe.

Name the reload scopes in the user-visible plan. Keep the scope set complete when replacing a plan. Plan add, remove, and adopt preserve the current scope set.

Request only scopes declared by the active arc. The reload command can wait for a long time while another agent works. Wait for the command. Do not retry it or bypass the queue.
