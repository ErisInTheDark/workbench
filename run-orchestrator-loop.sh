#!/usr/bin/env bash
# Owner: supervise the restart loop, rotation, pause state, launcher diagnostics, inactivity recovery, and one runner stderr capture without owning child-process logging internals.
# Functions: build_timestamped_line formats bounded direct evidence; emit_direct writes one timestamped line; emit_logged mirrors launcher lines to stdout and the active log; cleanup_runner_stderr removes only the active hidden capture; runner_is_active reads Bash job ownership; stop_active_runner terminates the current runner; cleanup_on_exit cleans up runner state; handle_interruption reports signals without replacing a completed runner failure; prune_log_files enforces retention; create_log_file creates a rotation target; wait_while_paused owns pause polling; select_log_file chooses or rotates the active log.
set -u

restart_delay_seconds="${RESTART_DELAY_SECONDS:-3}"
max_log_lines="${MAX_LOG_LINES:-1000}"
max_log_files="${MAX_LOG_FILES:-5}"
log_idle_timeout_seconds="${LOG_IDLE_TIMEOUT_SECONDS:-120}"
dry_run=0
runner_stderr_file=""
runner_pid=""

build_timestamped_line() {
  local message="$1"
  local timestamp

  message="${message//$'\r'/\\r}"
  message="${message//$'\n'/\\n}"
  message="${message:0:512}"
  timestamp="$(date '+%H:%M:%S.%3N' 2>/dev/null || true)"
  if [[ ! "$timestamp" =~ ^[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$ ]]; then
    timestamp="00:00:00.000"
  fi
  timestamped_line="[$timestamp] $message"
}

emit_direct() {
  build_timestamped_line "$1"
  printf '%s\n' "$timestamped_line"
}

emit_logged() {
  local log_file="$1"
  local message="$2"

  build_timestamped_line "$message"
  if ! printf '%s\n' "$timestamped_line"; then
    emit_direct "Unable to write orchestrator launcher output to stdout." >&2
    return 1
  fi
  if ! printf '%s\n' "$timestamped_line" 2>/dev/null >>"$log_file"; then
    emit_direct "Unable to append orchestrator launcher output to: $log_file" >&2
    return 1
  fi
}

cleanup_runner_stderr() {
  local capture_file="$runner_stderr_file"

  runner_stderr_file=""
  if [[ -z "$capture_file" || ! -e "$capture_file" ]]; then
    return 0
  fi
  if ! rm -f -- "$capture_file" 2>/dev/null; then
    emit_direct "Unable to remove orchestrator runner stderr capture: $capture_file" >&2
    return 1
  fi
}

runner_is_active() {
  local active_pid

  if [[ -z "$runner_pid" ]]; then
    return 1
  fi

  while IFS= read -r active_pid; do
    if [[ "$active_pid" == "$runner_pid" ]]; then
      return 0
    fi
  done < <(jobs -pr)

  return 1
}

stop_active_runner() {
  local pid="$runner_pid"
  local remaining_seconds=5

  if [[ -z "$pid" ]] || ! runner_is_active; then
    return 0
  fi

  if ! kill -TERM "$pid" 2>/dev/null; then
    if runner_is_active; then
      emit_direct "Unable to terminate orchestrator runner process: $pid" >&2
      return 1
    fi
    return 0
  fi

  while ((remaining_seconds > 0)) && runner_is_active; do
    sleep 1 || break
    remaining_seconds=$((remaining_seconds - 1))
  done

  if runner_is_active; then
    if ! kill -KILL "$pid" 2>/dev/null; then
      emit_direct "Unable to kill unresponsive orchestrator runner process: $pid" >&2
      return 1
    fi
  fi
}

cleanup_on_exit() {
  local exit_status=$?

  trap - EXIT HUP INT TERM
  stop_active_runner || true

  if [[ -n "$runner_pid" ]]; then
    wait "$runner_pid" 2>/dev/null || true
    runner_pid=""
  fi

  cleanup_runner_stderr || true
  exit "$exit_status"
}

handle_interruption() {
  local signal_name="$1"
  local exit_status="$2"

  if [[ -n "$runner_pid" ]] && ! runner_is_active; then
    return 0
  fi

  emit_direct "Orchestrator restart loop interrupted by $signal_name." >&2
  trap - HUP INT TERM
  exit "$exit_status"
}

trap cleanup_on_exit EXIT
trap 'handle_interruption HUP 129' HUP
trap 'handle_interruption INT 130' INT
trap 'handle_interruption TERM 143' TERM

if (($# > 1)); then
  emit_direct "Usage: $0 [--dry-run]" >&2
  exit 1
fi

case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *)
    emit_direct "Usage: $0 [--dry-run]" >&2
    exit 1
    ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
webapp_dir="$script_dir/webapp"
env_file="$webapp_dir/.env.local"
log_dir="$script_dir/.workbench/logs"
log_prefix="workbench-orchestrator"
pause_sentinel="$script_dir/.workbench/orchestrator-loop.pause"
log_formatter="$webapp_dir/scripts/orchestrator/format-orchestrator-log-stream.mjs"
command_runner="$webapp_dir/scripts/orchestrator/run-orchestrator-command.mjs"

if [[ ! -d "$webapp_dir" ]]; then
  emit_direct "Expected webapp directory at $webapp_dir" >&2
  exit 1
fi

if [[ ! -f "$log_formatter" ]]; then
  emit_direct "Expected log formatter at $log_formatter" >&2
  exit 1
fi

if [[ ! -f "$command_runner" ]]; then
  emit_direct "Expected orchestrator command runner at $command_runner" >&2
  exit 1
fi

if [[ ! "$max_log_lines" =~ ^[0-9]+$ ]] || ((max_log_lines < 1)); then
  emit_direct "MAX_LOG_LINES must be a positive integer" >&2
  exit 1
fi

if [[ ! "$max_log_files" =~ ^[0-9]+$ ]] || ((max_log_files < 1)); then
  emit_direct "MAX_LOG_FILES must be a positive integer" >&2
  exit 1
fi

if [[ ! "$log_idle_timeout_seconds" =~ ^[0-9]+$ ]] || ((log_idle_timeout_seconds < 1)); then
  emit_direct "LOG_IDLE_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 1
fi

for command_name in node pnpm kill-by-port wc date sleep; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    emit_direct "Required command not found: $command_name" >&2
    exit 1
  fi
done
if ! owned_ports_output="$(
  cd "$webapp_dir" || exit 1
  node --input-type=module --eval '
    import { loadWorkbenchRuntimeTopology } from "./scripts/orchestrator/runtime-topology.mjs";
    const topology = await loadWorkbenchRuntimeTopology(".env.local", { environment: process.env });
    for (const { port } of topology.listeners) console.log(port);
  ' 2>&1
)"; then
  emit_direct "Runtime topology discovery failed: $owned_ports_output" >&2
  exit 1
fi

mapfile -t owned_ports <<<"$owned_ports_output"

if ((dry_run == 1)); then
  emit_direct "Dry run: Workbench would kill listeners on configured ports: ${owned_ports[*]}"
  exit 0
fi

if ! mkdir -p -- "$log_dir" 2>/dev/null; then
  emit_direct "Unable to create orchestrator log directory: $log_dir" >&2
  exit 1
fi

shopt -s nullglob

prune_log_files() {
  local log_files=("$log_dir"/"$log_prefix"-*.log)
  local excess_count
  local index

  excess_count=$((${#log_files[@]} - max_log_files))

  for ((index = 0; index < excess_count; index++)); do
    if ! rm -f -- "${log_files[$index]}" 2>/dev/null; then
      emit_direct "Unable to prune orchestrator log file: ${log_files[$index]}" >&2
      return 1
    fi
  done
}

create_log_file() {
  local restart_number="$1"
  local timestamp
  local log_file

  if ! timestamp="$(date '+%Y%m%d-%H%M%S' 2>/dev/null)"; then
    emit_direct "Unable to create an orchestrator log filename timestamp." >&2
    return 1
  fi

  log_file="$log_dir/$log_prefix-$timestamp-$$-$(printf '%04d' "$restart_number").log"

  if ! : 2>/dev/null >"$log_file"; then
    emit_direct "Unable to create orchestrator log file: $log_file" >&2
    return 1
  fi

  printf '%s\n' "$log_file"
}

wait_while_paused() {
  local log_file="$1"
  local pause_announced=0

  while [[ -e "$pause_sentinel" ]]; do
    if ((pause_announced == 0)); then
      emit_logged "$log_file" "Orchestrator restart loop paused by sentinel: $pause_sentinel" || return 1
      pause_announced=1
    fi

    if ! sleep "$restart_delay_seconds"; then
      emit_direct "Orchestrator pause sleep failed." >&2
      return 1
    fi
  done

  if ((pause_announced == 1)); then
    emit_logged "$log_file" "Orchestrator restart loop pause released." || return 1
  fi
}

select_log_file() {
  local restart_number="$1"
  local log_files=("$log_dir"/"$log_prefix"-*.log)
  local latest_log
  local line_count

  if ((${#log_files[@]} == 0)); then
    create_log_file "$restart_number"
    return
  fi

  latest_log="${log_files[${#log_files[@]} - 1]}"

  if ! line_count="$(wc -l 2>/dev/null <"$latest_log")"; then
    emit_direct "Unable to count orchestrator log lines: $latest_log" >&2
    return 1
  fi

  if ((line_count > max_log_lines)); then
    create_log_file "$restart_number"
  else
    printf '%s\n' "$latest_log"
  fi
}

if ! prune_log_files; then
  exit 1
fi

restart_number=0

while true; do
  if ! log_file="$(select_log_file "$restart_number")"; then
    exit 1
  fi

  if ! prune_log_files; then
    exit 1
  fi

  if ! wait_while_paused "$log_file"; then
    exit 1
  fi

  if ((restart_number == 0)); then
    emit_logged "$log_file" "Starting Workbench orchestrator restart loop." || exit 1
    emit_logged "$log_file" "Command: WORKBENCH_ORCHESTRATOR_LOOP=1 pnpm dev:orchestrator" || exit 1
    emit_logged "$log_file" "Working directory: $webapp_dir" || exit 1
    emit_logged "$log_file" "Owned ports: ${owned_ports[*]}" || exit 1
    emit_logged "$log_file" "Log directory: $log_dir" || exit 1
    emit_logged "$log_file" "Log rotation: more than $max_log_lines lines" || exit 1
    emit_logged "$log_file" "Log retention: $max_log_files files" || exit 1
    emit_logged "$log_file" "Restart delay: ${restart_delay_seconds} seconds" || exit 1
    emit_logged "$log_file" "Inactivity restart: ${log_idle_timeout_seconds} seconds without new log output" || exit 1
    emit_logged "$log_file" "Pause sentinel: $pause_sentinel" || exit 1
    emit_logged "$log_file" "Press Ctrl+C to stop." || exit 1
  fi

  emit_logged "$log_file" "Logging complete orchestrator output to: $log_file" || exit 1

  for port in "${owned_ports[@]}"; do
    kill_output="$(kill-by-port "$port" 2>&1)"
    kill_status=$?

    if [[ -n "$kill_output" ]]; then
      while IFS= read -r kill_line || [[ -n "$kill_line" ]]; do
        emit_logged "$log_file" "$kill_line" || exit 1
      done <<<"$kill_output"
    fi

    if ((kill_status != 0)); then
      emit_direct "kill-by-port failed for port $port with status $kill_status." >&2
      exit 1
    fi
  done

  runner_stderr_file="$log_dir/.orchestrator-runner-stderr-$$-$restart_number.log"

  if ! : 2>/dev/null >"$runner_stderr_file"; then
    emit_direct "Unable to create orchestrator runner stderr capture: $runner_stderr_file" >&2
    exit 1
  fi

  (
    if ! cd "$webapp_dir" 2>/dev/null; then
      printf 'Unable to enter orchestrator working directory: %s\n' "$webapp_dir" >&2
      exit 70
    fi

    export WORKBENCH_ORCHESTRATOR_LOOP=1
    exec node "$command_runner" \
      --log-file "$log_file" \
      --restart-delay-seconds "$restart_delay_seconds" \
      -- pnpm dev:orchestrator
  ) 2>"$runner_stderr_file" &

  runner_pid=$!
  runner_timed_out=0
  runner_stderr_bytes_before_timeout=0
  last_log_activity_seconds=$SECONDS

  if ! last_log_size="$(wc -c 2>/dev/null <"$log_file")"; then
    emit_direct "Unable to inspect orchestrator log size: $log_file" >&2
    exit 1
  fi

  while runner_is_active; do
    if ! sleep 1; then
      if ! runner_is_active; then
        break
      fi
      emit_direct "Orchestrator inactivity watchdog sleep failed." >&2
      exit 1
    fi

    if ! current_log_size="$(wc -c 2>/dev/null <"$log_file")"; then
      emit_direct "Unable to inspect orchestrator log size: $log_file" >&2
      exit 1
    fi

    if [[ "$current_log_size" != "$last_log_size" ]]; then
      last_log_size="$current_log_size"
      last_log_activity_seconds=$SECONDS
    elif ((SECONDS - last_log_activity_seconds >= log_idle_timeout_seconds)); then
      runner_timed_out=1

      # Preserve the original failure policy for stderr already emitted before
      # the watchdog timeout. Only shutdown stderr emitted after this point is
      # tolerated for the automatic restart.
      if ! runner_stderr_bytes_before_timeout="$(wc -c 2>/dev/null <"$runner_stderr_file")"; then
        emit_direct "Unable to inspect orchestrator runner stderr capture: $runner_stderr_file" >&2
        exit 1
      fi

      emit_logged \
        "$log_file" \
        "No orchestrator output was logged for ${log_idle_timeout_seconds} seconds; terminating the runner for restart." \
        || exit 1

      stop_active_runner || exit 1
      break
    fi
  done

  wait "$runner_pid"
  runner_status=$?
  runner_pid=""

  runner_failed=0
  while IFS= read -r runner_line || [[ -n "$runner_line" ]]; do
    runner_failed=1

    if [[ "$runner_line" =~ ^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}\][[:space:]] ]]; then
      printf '%s\n' "$runner_line" >&2
    else
      emit_direct "$runner_line" >&2
    fi
  done <"$runner_stderr_file"

  if ! cleanup_runner_stderr; then
    exit 1
  fi

  if ((runner_failed == 1)); then
    if ((runner_timed_out == 0 || runner_stderr_bytes_before_timeout > 0)); then
      if ((runner_status == 74)); then
        exit 74
      fi
      exit 70
    fi
  fi

  if ((runner_status == 70)); then
    exit 70
  fi

  if ((runner_status == 74)); then
    exit 74
  fi

  restart_number=$((restart_number + 1))

  emit_logged "$log_file" "Restarting Workbench orchestrator in ${restart_delay_seconds} seconds after child status ${runner_status}." || exit 1

  if ! sleep "$restart_delay_seconds"; then
    emit_direct "Orchestrator restart sleep failed." >&2
    exit 1
  fi
done
