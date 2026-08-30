<!-- Prevent agents from restarting a lifecycle wait, polling it, or treating a Code cell yield as completion. -->
## Workbench Long Waits

Use one blocking Workbench wait in one Code mode cell. Use only one long-wait cell at a time.

Use this Code mode shape. Replace the example tool and input with the Workbench Long Wait named by the owning mechanic:

```js
// @exec: {"yield_time_ms": 1500000, "max_output_tokens": 10000}
const result = await tools.mcp__wb__example_wait_command({});
for (const item of result.content ?? []) {
  if (item.type === "text") text(item.text);
}
```

Both `functions.exec` and `functions.wait` block until the cell completes or 25 minutes passes. Cell completion wakes the current attached call immediately. If 25 minutes passes first, the tool returns `Script running with cell ID <id>`.

After a still-running result, call `functions.wait` with the returned cell id:

```json
{
  "cell_id": "<id>",
  "yield_time_ms": 1500000,
  "max_tokens": 10000
}
```

If `functions.wait` returns another still-running result, call it again with the same cell id and arguments. Repeat until the cell completes or a user steer interrupts it.

Do not call the original Workbench wait tool again. Do not add a timeout to the original tool call. Do not sleep, poll, start a parallel wait, or write timeout commentary. A 25-minute cell yield is not a lifecycle deadline, failure, or reason to set blocked status.

Apply the newest interrupting steer before more work.
