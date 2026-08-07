#!/usr/bin/env bash
# Pause the canvas Azure environment (canvas-ycu, mirrors ADP's infra/azure/pause.sh) -- a
# cheaper middle ground between fully torn down (destroy.sh) and running 24/7: stops the compute
# you pay for while KEEPING all data/config, so a later resume.sh brings everything back exactly
# as it was (no rebuild, no re-migration).
#
# What this pauses (stops costing money):
#   - canvas-postgres compute (`az postgres flexible-server stop`) -- Azure auto-restarts a
#     stopped Flexible Server after 7 days if not resumed manually, so this is meant for short
#     gaps (overnight, a few days), not indefinite storage.
#   - canvas-api container app compute (min=0/max=1 -- Container Apps rejects max-replicas=0
#     outright, so "paused" means "eligible to scale to zero", not a hard-forced zero). It's
#     already min=0/max=1 normally (apiapp.bicep) and scales down on its own when idle, so this
#     script is mostly a no-op for it today -- kept here anyway so this stays the one command to
#     run regardless of which apps this environment ends up running (e.g. once canvas-mi9's
#     Keycloak container app lands, which -- like ADP's own Keycloak -- will likely stay warm at
#     min=1/max=1 normally and need an actual drop to min=0 here).
#
# What STILL costs money while paused (small, but non-zero):
#   - Postgres storage (the 32GB volume itself, ~$4/month) and backups.
#   - ACR image storage (Basic SKU, ~$5/month regardless of activity).
#   - Key Vault (~$0.03/10k operations -- negligible at rest).
#   - Storage account (the frontend static website) -- effectively free at rest, no compute to
#     pause; blob storage + bandwidth are the only costs and both are near-zero when idle.
#   - Log Analytics workspace (pay-per-GB ingested; near-zero once apps are quiet).
#
# Usage: ./pause.sh [resource-group]

set -euo pipefail

RESOURCE_GROUP="${1:-canvas-rg}"

echo "== Making canvas-api eligible to scale to zero =="
az containerapp update --name canvas-api --resource-group "$RESOURCE_GROUP" \
  --min-replicas 0 --max-replicas 1 --output none
echo "  Set to min=0/max=1. Actual replica count drops to 0 after the environment's cooldown"
echo "  period (~5 min) once traffic stops -- not instant. Confirm with:"
echo "    az containerapp replica list --name canvas-api --resource-group $RESOURCE_GROUP"

echo "== Stopping canvas-postgres (compute only -- storage/data retained) =="
az postgres flexible-server stop --resource-group "$RESOURCE_GROUP" --name canvas-postgres --output none
echo "  Postgres stop requested."

echo
echo "== Paused. Run resume.sh to bring the environment back. =="
echo "Reminder: Azure auto-restarts a stopped Postgres Flexible Server after 7 days -- if you're"
echo "pausing longer than that, re-run pause.sh to stop it again."
