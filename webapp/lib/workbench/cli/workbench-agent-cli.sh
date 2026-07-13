#!/usr/bin/env bash
# Workbench native agent transport: forward argv to the long-lived orchestrator without starting Node.
set -u

if [[ -z "${WORKBENCH_ORIGIN:-}" ]]; then
  printf '%s\n' 'WORKBENCH_ORIGIN is unavailable. Run wb from a Workbench-managed agent process.' >&2
  exit 1
fi
case "$WORKBENCH_ORIGIN" in
  http://localhost:*|http://127.0.0.1:*|http://\[::1\]:*) ;;
  *)
    printf '%s\n' 'WORKBENCH_ORIGIN must use a loopback HTTP origin.' >&2
    exit 1
    ;;
esac

response_file="$(mktemp "${TMPDIR:-/tmp}/workbench-agent-response.XXXXXX")" || exit 1
cleanup() { rm -f -- "$response_file"; }
trap cleanup EXIT

curl_args=(
  --silent
  --show-error
  --no-buffer
  --output "$response_file"
  --write-out '%{http_code}'
  --request POST
  --header 'Content-Type: application/x-www-form-urlencoded'
  --data-urlencode "cwd=$PWD"
  --data-urlencode "callerThreadId=${WORKBENCH_THREAD_ID:-${CODEX_THREAD_ID:-}}"
  --data-urlencode "workbenchOrigin=$WORKBENCH_ORIGIN"
)
for argument in "$@"; do
  curl_args+=(--data-urlencode "arg=$argument")
done

http_status="$(curl "${curl_args[@]}" "$WORKBENCH_ORIGIN/orchestrator/agent-command")"
curl_status=$?
if (( curl_status != 0 )); then
  [[ -s "$response_file" ]] && cat "$response_file" >&2
  exit "$curl_status"
fi

if [[ "$http_status" =~ ^2 ]]; then
  cat "$response_file"
  exit 0
fi
cat "$response_file" >&2
exit 1
