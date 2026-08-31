<available:browse>
## Browser Use

Browser use, ie diagnostics or validation, requires **Feature Activation**. 

When activated, load the `/browse` skill (follow normal skill precedence rules) for the workflow and command contract, including session management.

Even if browser use is activated, default to using normal web/search tools for internet research.

<available:browse-raw>
Workbench's Browser Use is a wrapper over Browserbase's `browse` package. In this repository, and only when necessary, the wb browse CLI provides a passthrough command to the raw browse CLI. Be very careful when using the raw browse CLI — it is not sandboxed. It being enabled does NOT give you permission to use it as a workaround for sandbox restrictions.
</available:browse-raw>

</available:browse>
