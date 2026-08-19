## Workbench Browse CLI

Workbench provides the allowlisted `wb browse` command family for browser automation only when the user, an active workflow, or another active instruction asks for browser work.

{{browse.rawCommandStatus}}

This section does not authorize arbitrary Workbench requests. Use the `/browse` skill for the browser workflow and command contract, including when listing or stopping Workbench-known Browse sessions.

Each `wb browse` call must stay isolated and auditable. Do not bundle it with unrelated shell work, page-data transformation, branching, or cleanup outside the BrowseMD request. If Browse output needs processing, run the Browse command visibly first, then process its visible result separately.

