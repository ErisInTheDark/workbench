#!/usr/bin/env bash
set -u

restart_delay_seconds="${RESTART_DELAY_SECONDS:-3}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
webapp_dir="$script_dir/webapp"

if [[ ! -d "$webapp_dir" ]]; then
  echo "Expected webapp directory at $webapp_dir" >&2
  exit 1
fi

echo "Starting webapp orchestrator restart loop."
echo "Command: pnpm dev"
echo "Working directory: $webapp_dir"
echo "Restart delay: ${restart_delay_seconds} seconds"
echo "Press Ctrl+C to stop."

while true; do
  (
    cd "$webapp_dir" || exit 1
    kill-by-port 3002
    pnpm dev
  )
  exit_code=$?
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$timestamp] Orchestrator exited with code $exit_code. Restarting in ${restart_delay_seconds} seconds..."
  sleep "$restart_delay_seconds"
done
