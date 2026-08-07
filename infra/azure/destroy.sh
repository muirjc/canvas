#!/usr/bin/env bash
# FULL teardown of the canvas Azure environment (canvas-ycu, mirrors ADP's infra/azure/
# destroy.sh).
#
# Deletes the entire canvas-rg resource group (which cascade-deletes ACR, Postgres, VNet/DNS,
# Container Apps env + apps + jobs, Storage account, Log Analytics, managed identity, and all
# role assignments) AND then purges the soft-deleted Key Vault -- because `az group delete` does
# NOT purge a Key Vault, it only soft-deletes it, and the vault name stays reserved (blocking the
# next deploy with "A vault with the same name already exists in deleted state") until explicitly
# purged. This works because the vault is created with purge protection OFF (modules/
# keyvault.bicep) by design, precisely so this teardown can fully remove it.
#
# This is the DESTROY path (everything gone, including all data). To pause the environment
# cheaply while KEEPING data/config, use pause.sh instead.
#
# Local infra/azure/.secrets/ (the cached admin passwords) is intentionally NOT touched -- a
# later deploy.sh rebuild reuses them so the recreated Postgres keeps the same credentials.
# Delete .secrets manually if you want a truly clean slate.
#
# Usage: ./destroy.sh [resource-group] [location]

set -euo pipefail

RESOURCE_GROUP="${1:-canvas-rg}"
LOCATION="${2:-eastus2}"

echo "== Resources currently in $RESOURCE_GROUP =="
if az group exists --name "$RESOURCE_GROUP" | grep -q true; then
  az resource list --resource-group "$RESOURCE_GROUP" --query "[].{name:name, type:type}" -o table
else
  echo "  (resource group does not exist)"
fi

# Capture Key Vault name(s) WHILE the RG still exists -- after deletion they only appear in the
# subscription-wide soft-deleted list.
KEY_VAULTS=""
if az group exists --name "$RESOURCE_GROUP" | grep -q true; then
  KEY_VAULTS="$(az keyvault list --resource-group "$RESOURCE_GROUP" --query "[].name" -o tsv 2>/dev/null || true)"
fi

echo
echo "This will PERMANENTLY DELETE resource group '$RESOURCE_GROUP' and purge its Key Vault(s)."
echo "ALL DATA (the Postgres database, everything in Storage) is destroyed."
read -r -p "Type the resource group name ('$RESOURCE_GROUP') to confirm: " confirm
if [[ "$confirm" != "$RESOURCE_GROUP" ]]; then
  echo "Aborted."
  exit 1
fi

if az group exists --name "$RESOURCE_GROUP" | grep -q true; then
  # --no-wait + explicit poll rather than a blocking `az group delete --yes`: deleting this
  # stack's VNet-integrated Container Apps environment can reliably take longer than 10 minutes,
  # long enough to hit foreground command timeouts in some shells/CI runners. Polling with
  # visible progress avoids looking hung and survives being interrupted and re-run.
  echo "== Deleting resource group $RESOURCE_GROUP (can take 15+ minutes -- polling) =="
  az group delete --name "$RESOURCE_GROUP" --yes --no-wait
  elapsed=0
  while az group exists --name "$RESOURCE_GROUP" | grep -q true; do
    sleep 30
    elapsed=$((elapsed + 30))
    echo "  ... still deleting (${elapsed}s elapsed)"
  done
  echo "  Resource group deleted (${elapsed}s)."
else
  echo "== Resource group $RESOURCE_GROUP already gone -- skipping RG delete =="
fi

# Purge soft-deleted Key Vault(s). Fall back to scanning the soft-deleted list for
# canvas-kv-* names, so this also cleans up after a manual RG delete where we never captured the
# name.
echo "== Purging soft-deleted Key Vault(s) =="
PURGE_TARGETS="$KEY_VAULTS"
if [[ -z "$PURGE_TARGETS" ]]; then
  PURGE_TARGETS="$(az keyvault list-deleted --query "[?starts_with(name, 'canvas-kv-')].name" -o tsv 2>/dev/null || true)"
fi

if [[ -z "$PURGE_TARGETS" ]]; then
  echo "  No matching soft-deleted Key Vaults found."
else
  for kv in $PURGE_TARGETS; do
    if az keyvault list-deleted --query "[?name=='$kv']" -o tsv 2>/dev/null | grep -q .; then
      echo "  Purging $kv ..."
      az keyvault purge --name "$kv" --location "$LOCATION" --no-wait
    else
      echo "  $kv is not in the soft-deleted list (already purged?) -- skipping."
    fi
  done
fi

echo
echo "== Teardown complete for $RESOURCE_GROUP =="
echo "Note: the Log Analytics workspace is also soft-deleted (recoverable ~14d) but does not"
echo "block redeploy or accrue cost, so it is not force-purged."
echo "Local infra/azure/.secrets/ was left intact for a future rebuild."
