# shellcheck shell=bash
# Shared helpers for pause.sh / resume.sh (canvas-myh). Source it; don't run it.

# retry <description> <command...>: runs an az command up to 5 times, 20s apart. Right after a
# resume/pause/deploy, Azure can still be busy with the previous operation on the same resource
# and reject a change with a conflict ("another operation is in progress") -- that clears up on
# its own, so a later attempt succeeds.
retry() {
  local what="$1"
  shift
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$@"; then
      return 0
    fi
    if [[ "$attempt" == 5 ]]; then
      echo "  $what failed after 5 attempts." >&2
      return 1
    fi
    echo "  $what failed (attempt $attempt; Azure may still be busy) -- retrying in 20s..."
    sleep 20
  done
}

# wait_for_postgres <resource-group> <server>: waits (up to 15 min) until the server is no longer
# mid-transition (Starting, Stopping, Updating, ...) and prints its settled state: Ready or Stopped.
wait_for_postgres() {
  local rg="$1" server="$2" state waited=0
  while true; do
    state="$(az postgres flexible-server show --resource-group "$rg" --name "$server" --query state -o tsv 2>/dev/null || true)"
    case "$state" in
      Ready | Stopped)
        echo "$state"
        return 0
        ;;
    esac
    if ((waited >= 900)); then
      echo "  $server is still '${state:-unknown}' after 15 minutes -- giving up." >&2
      return 1
    fi
    echo "  $server is '${state:-unknown}' -- waiting for it to settle..." >&2
    sleep 15
    waited=$((waited + 15))
  done
}
