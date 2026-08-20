## Workbench Browse CLI

`wb browse` is available only for browser work activated by `/browse`. Availability does not activate or authorize Browse.

{{browse.rawCommandStatus}}

When activated, use `/browse` for the workflow and command contract, including session management.

Each `wb browse` call must stay isolated and auditable. Do not bundle it with unrelated shell work, page-data transformation, branching, or cleanup outside the BrowseMD request. If Browse output needs processing, run the Browse command visibly first, then process its visible result separately.
