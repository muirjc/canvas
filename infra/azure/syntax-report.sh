#!/usr/bin/env bash
# Mermaid syntax dry run against the Azure database (canvas-dfam). The database is private to the VNet, so the report
# (apps/api-py/src/canvas_api/jobs/syntax_report.py) runs as the canvas-syntax-report Container Apps job. Run it with
# the NEW build before releasing a change to the Mermaid syntax Canvas reads or writes, and before deploy.sh updates
# the app (docs/admin-guide/operations.md, "Moving to a newer Mermaid version", step 5). Read-only: it changes no data.
#
# Usage:
#   ./syntax-report.sh --build [resource-group]      build this checkout's API image (tagged as deploy.sh tags it)
#                                                    and report with it
#   ./syntax-report.sh --image <tag> [resource-group] report with an image already in the registry
#   ./syntax-report.sh [resource-group]               report with the job's current image (the app's, as deployed)
#
# Prints the report and exits 1 when the build can't open some saved diagram ("Can't be opened ... : N" above 0).
# Pointing the job at another image needs Microsoft.App/jobs/write (deployers have it); the next deploy.sh puts the
# job back on the app's image.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/lib.sh"
JOB=canvas-syntax-report

MODE=current
IMAGE_TAG=""
case "${1:-}" in
  --build) MODE=build; shift ;;
  --image) MODE=image; IMAGE_TAG="${2:?--image needs a tag}"; shift 2 ;;
  -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
esac
RESOURCE_GROUP="${1:-canvas-rg}"

if ! az containerapp job show --name "$JOB" --resource-group "$RESOURCE_GROUP" --query name -o tsv >/dev/null 2>&1; then
  echo "ERROR: no $JOB job in $RESOURCE_GROUP -- run deploy.sh once to create it." >&2
  exit 1
fi
if [[ "$(az postgres flexible-server show --resource-group "$RESOURCE_GROUP" --name canvas-postgres \
  --query state -o tsv 2>/dev/null)" != "Ready" ]]; then
  echo "ERROR: canvas-postgres isn't running -- run ./resume.sh first." >&2
  exit 1
fi
ACR="$(az acr list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv)"
ACR_SERVER="$(az acr show --name "$ACR" --query loginServer -o tsv)"

if [[ "$MODE" == build ]]; then
  # The same tag deploy.sh gives this checkout, so a deploy right after reuses the name.
  IMAGE_TAG="$(cd "$REPO_ROOT" && git rev-parse --short HEAD)"
  # Uncommitted changes to tracked files make a "-dirty-" tag, as in deploy.sh (which then builds again).
  if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null || ! git -C "$REPO_ROOT" diff --cached --quiet 2>/dev/null; then
    IMAGE_TAG="${IMAGE_TAG}-dirty-$(date +%s)"
  fi
  echo "== Building the API image (apps/api-py/Dockerfile) to $ACR, tag $IMAGE_TAG =="
  az acr build --registry "$ACR" --image "canvas-api-py:${IMAGE_TAG}" --file "$REPO_ROOT/apps/api-py/Dockerfile" \
    "$REPO_ROOT" --output none
fi
if [[ -n "$IMAGE_TAG" ]]; then
  echo "== Pointing $JOB at canvas-api-py:$IMAGE_TAG =="
  retry "Updating $JOB" az containerapp job update --name "$JOB" --resource-group "$RESOURCE_GROUP" \
    --image "${ACR_SERVER}/canvas-api-py:${IMAGE_TAG}" --output none
fi
IMAGE="$(az containerapp job show --name "$JOB" --resource-group "$RESOURCE_GROUP" \
  --query "properties.template.containers[0].image" -o tsv)"

# Override-free start (canvas-a8mr): the job's settings were changed with `job update` above.
EXECUTION="$(az containerapp job start --name "$JOB" --resource-group "$RESOURCE_GROUP" --query name -o tsv)"
echo "== Running the dry run with ${IMAGE##*/} (execution $EXECUTION) =="
while true; do
  STATUS="$(az containerapp job execution show --name "$JOB" --job-execution-name "$EXECUTION" \
    --resource-group "$RESOURCE_GROUP" --query properties.status -o tsv 2>/dev/null || true)"
  case "$STATUS" in
    Succeeded | Failed) break ;;
    *) sleep 10 ;;
  esac
done
echo "  Finished: $STATUS."

# The report's lines reach Log Analytics a minute or two later, one record each and not always in order: the job
# numbers them (--numbered) and ends with END OF REPORT, so wait for that line, then sort and strip the numbers.
WORKSPACE="$(az monitor log-analytics workspace show --resource-group "$RESOURCE_GROUP" --name canvas-logs \
  --query customerId -o tsv)"
QUERY="ContainerAppConsoleLogs_CL | where ContainerJobName_s == '$JOB' and ContainerGroupName_s startswith '$EXECUTION'
  | where Log_s matches regex @'^[0-9]{6} ' | project Log_s"
echo "== Fetching the report from Log Analytics (can take a few minutes) =="
REPORT=""
for _ in $(seq 1 40); do
  REPORT="$(az monitor log-analytics query --workspace "$WORKSPACE" --analytics-query "$QUERY" \
    --query "[].Log_s" -o tsv 2>/dev/null | sort | uniq || true)"
  if grep -q '^[0-9]\{6\} END OF REPORT$' <<<"$REPORT"; then
    break
  fi
  sleep 15
done
if ! grep -q '^[0-9]\{6\} END OF REPORT$' <<<"$REPORT"; then
  echo "ERROR: the report didn't reach Log Analytics within 10 minutes (the job $STATUS). Look at:" >&2
  echo "  az containerapp job logs show --name $JOB --resource-group $RESOURCE_GROUP --container syntax-report --execution $EXECUTION" >&2
  exit 1
fi
echo
grep -v ' END OF REPORT$' <<<"$REPORT" | cut -c8-
echo

UNREADABLE="$(grep -o "Can't be opened by this build: [0-9]*" <<<"$REPORT" | grep -o '[0-9]*$')"
if [[ "$UNREADABLE" != 0 ]]; then
  echo "== $UNREADABLE saved diagram(s) can't be opened by ${IMAGE##*/}: fix that before releasing it. ==" >&2
  exit 1
fi
echo "== Every saved diagram opens with ${IMAGE##*/}. =="
