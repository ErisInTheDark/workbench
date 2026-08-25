#!/usr/bin/env bash
# Workbench native agent transport: forward argv to the long-lived orchestrator without starting Node.
set -u

if [[ "${WORKBENCH_CWD_REDIRECTED:-}" != "1" ]]; then
  for cwd_workbench in "$PWD/webapp/node_modules/.bin/wb" "$PWD/node_modules/.bin/wb"; do
    if [[ -f "$cwd_workbench" ]] && ! [[ "$cwd_workbench" -ef "$0" ]]; then
      WORKBENCH_CWD_REDIRECTED=1 exec bash "$cwd_workbench" "$@"
    fi
  done
fi
unset WORKBENCH_CWD_REDIRECTED

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
allow_unavailable_claim_hook() {
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
}

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
  --data-urlencode "callerHarness=${WORKBENCH_HARNESS:-codex}"
  --data-urlencode "workbenchOrigin=$WORKBENCH_ORIGIN"
)
hook_mode=0
if [[ "$#" -eq 0 && "${WORKBENCH_APPLY_PATCH_CLAIM_HOOK:-}" == "1" ]]; then
  hook_mode=1
  curl_args+=(--data-urlencode "arg=__hook" --data-urlencode "arg=apply-patch-claim")
elif [[ "${1:-}" == "__hook" && "${2:-}" == "apply-patch-claim" && "$#" -eq 2 ]]; then
  hook_mode=1
fi
for argument in "$@"; do
  curl_args+=(--data-urlencode "arg=$argument")
done
if (( hook_mode == 1 )); then
  curl_args+=(--connect-timeout 2 --max-time 10)
  curl_args+=(--data-urlencode "hookInput@-")
fi

http_status="$(curl "${curl_args[@]}" "$WORKBENCH_ORIGIN/orchestrator/agent-command")"
curl_status=$?
if (( curl_status != 0 )); then
  [[ -s "$response_file" ]] && cat "$response_file" >&2
  if (( hook_mode == 1 )); then
    allow_unavailable_claim_hook
    exit 0
  fi
  exit "$curl_status"
fi

if [[ "$http_status" =~ ^2 ]]; then
  cat "$response_file"
  exit 0
fi
cat "$response_file" >&2
if (( hook_mode == 1 )); then
  allow_unavailable_claim_hook
  exit 0
fi
exit 1
