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
  --data-urlencode "workbenchOrigin=$WORKBENCH_ORIGIN"
)
for argument in "$@"; do
  curl_args+=(--data-urlencode "arg=$argument")
done

curl "${curl_args[@]}" "$WORKBENCH_ORIGIN/orchestrator/agent-command" | route_response
pipeline_status=("${PIPESTATUS[@]}")
curl_status="${pipeline_status[0]}"
if (( curl_status != 0 )); then
  exit "$curl_status"
fi
exit "${pipeline_status[1]}"
