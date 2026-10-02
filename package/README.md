# @inthedark/wb

## Loading `.env` with store references

```js
import { config } from "@inthedark/wb";

await config(); // same options as dotenv: path, encoding, override, processEnv; plus signal
```

Values may contain `${store:key}` references:

```dotenv
WB_STORES=wb: wb store get {key}; vault: vault kv get -field=value "secret/{key}"
API_KEY=${vault:service-key}
AUTHORIZATION=Bearer ${wb:service-token}
```

- `WB_STORES` names each store and its command, separated by `;`. Without it, only `wb: wb store get {key}` is defined.
- Commands run directly, never through a shell, so Windows `.cmd`/`.bat` wrappers are unsupported. Spaces separate arguments; double quotes group them (`\"` and `\\` escape inside quotes). `{key}` is replaced inside arguments only.
- A successful command's stdout becomes the value, minus one trailing newline. Results are not expanded again.
- References to unknown stores, failed commands, and missing keys stay exactly as written. Failures print a warning without command output.
- Inside Workbench-managed agent processes, no store commands run.

A `.env` file with `WB_STORES` is executable configuration: only load files you trust.
