## Workbench Long Waits

Use one blocking tool call for lifecycle-owned waits.

Keep the outer tool execution attached for up to 25 minutes. Do not poll with sleeps, repeated tool calls, or parallel waits.

A user steer interrupts a Workbench Long Wait. After interruption, apply the newest steer before another wait or more work.
