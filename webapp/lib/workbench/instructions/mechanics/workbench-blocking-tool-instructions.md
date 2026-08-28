<!-- Prevent agents from treating the outer attachment window as a lifecycle timeout or workflow block. -->
## Workbench Long Waits

Use one blocking tool call at a time for lifecycle-owned waits.

Keep it attached for up to 25 minutes. On every timeout, silently repeat the same wait until completion or a user steer. Timeout is not a lifecycle deadline or reason to set blocked status.

Apply the newest interrupting steer before more work. No sleeps, parallel waits, or timeout commentary.
