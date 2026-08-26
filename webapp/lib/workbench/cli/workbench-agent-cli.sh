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

allow_unavailable_claim_hook() {
  printf '%s\n' '{}'
}

route_response() {
  local status_line header http_status
  IFS= read -r status_line || return 1
  status_line="${status_line%$'\r'}"
  if ! [[ "$status_line" =~ ^HTTP/[0-9]+(\.[0-9]+)?[[:space:]]+([0-9]{3})([[:space:]]|$) ]]; then
    return 1
  fi
  http_status="${BASH_REMATCH[2]}"

  while IFS= read -r header; do
    [[ -z "${header%$'\r'}" ]] && break
  done

  if [[ "$http_status" =~ ^2 ]]; then
    cat
    return
  fi
  cat >&2
  return 1
}

curl_args=(
  --silent
  --show-error
  --no-buffer
  --include
  --request POST
  --header 'Content-Type: application/x-www-form-urlencoded'
  --header 'Expect:'
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
  curl_args+=(--connect-timeout 2)
  curl_args+=(--data-urlencode "hookInput@-")
fi

curl "${curl_args[@]}" "$WORKBENCH_ORIGIN/orchestrator/agent-command" | route_response
pipeline_status=("${PIPESTATUS[@]}")
curl_status="${pipeline_status[0]}"
response_status="${pipeline_status[1]}"
if (( curl_status != 0 )); then
  if (( hook_mode == 1 )); then
    allow_unavailable_claim_hook
    exit 0
  fi
  exit "$curl_status"
fi

if (( response_status != 0 && hook_mode == 1 )); then
  allow_unavailable_claim_hook
  exit 0
fi
exit "$response_status"
