#!/usr/bin/env bash
# Deploy/update the canvas Azure environment (canvas-ycu, mirrors ADP's infra/azure/deploy.sh).
# Resource group, ACR, VNet, private Postgres, Key Vault + managed identity, Container Apps
# environment, API app (which also serves the web app, canvas-r3y), migration job, and a Storage
# static website that now only redirects the old address.
#
# Usage: ENTRA_CLIENT_ID=<id> [ENTRA_TENANT_ID=<id>] [ENTRA_CLIENT_SECRET=<secret>] \
#        [CANVAS_AI_PROVIDER=mock|anthropic|openai] [CANVAS_ANTHROPIC_API_KEY=<key>] \
#        [CANVAS_OPENAI_API_KEY=<key>] [CANVAS_ALLOW_PUBLIC=1] [CANVAS_AUTH_MODE=entra|local] \
#        [CANVAS_GITHUB_APP_ID=<id> CANVAS_GITHUB_APP_PRIVATE_KEY_FILE=<path to .pem>] \
#        ./deploy.sh [--what-if-only | --yes] [location]
#
# canvas-cng: the API ingress and the web Storage account only accept the networks listed in
# infra/azure/.secrets/allowed-ips (gitignored): one "CIDR description..." per line, '#' comments
# allowed -- Entra sign-in still applies on top (docs/ip-allowlist-security-plan.md, option A).
# If the file is missing but canvas-api exists, it's recreated from the live rules; with neither,
# the script refuses to deploy a public environment unless CANVAS_ALLOW_PUBLIC=1. The machine
# running this script must itself be on the list (it uploads the web app to Storage).
#
# canvas-7zw: by default the script shows the what-if and asks before applying. Two flags make it
# usable without a terminal to answer that prompt (e.g. Claude Code driven from a phone):
#   --what-if-only  run everything read-only up to and including the what-if, then exit -- no Key
#                   Vault writes, no image build, no deployment.
#   --yes           skip the confirmation prompt and apply. Meant for after a --what-if-only run
#                   has been reviewed, as a separate, explicit command.
#
# canvas-haz: ENTRA_CLIENT_ID (required) and ENTRA_CLIENT_SECRET (required on first run only --
# cached afterward in infra/azure/.secrets/oidc-client-secret) come from the "canvas-azure" Entra
# app registration -- see RUNBOOK.md's "Entra ID SSO" section for the one-time setup steps that
# produce them. ENTRA_TENANT_ID defaults to the deploying subscription's own tenant.
#
# canvas-ez1.1: CANVAS_AUTH_MODE picks the sign-in model (cached in .secrets/auth-mode, default
# entra). 'local' is option B of docs/ip-allowlist-security-plan.md: Canvas-managed email +
# password accounts, no Entra app registration needed (ENTRA_CLIENT_ID/SECRET become optional).
# Local mode always requires a non-empty IP allow-list -- CANVAS_ALLOW_PUBLIC=1 doesn't override it.
# canvas-ez1.3: local mode also needs CANVAS_ADMIN_EMAIL on its first run (cached in
# .secrets/admin-email): the first admin, created by the canvas-bootstrap-admin job with a one-time
# password generated into .secrets/bootstrap-admin-password. No demo seed accounts exist there.
#
# All secret VALUES (Postgres admin password, the assembled DATABASE_URL, SESSION_SECRET,
# ANTHROPIC_API_KEY/OPENAI_API_KEY) are written into Key Vault BEFORE the main deployment runs,
# not after -- the API container app deployed in the same template reads them via Key Vault
# secret references at provisioning time, so if they don't exist yet that deployment fails. This
# only works because Key Vault already exists from a prior run of this script; a genuine
# from-scratch rebuild needs two passes -- run once to create Key Vault (the API app module will
# fail that first time), then again once these secrets exist. Same two-pass shape ADP's own
# deploy.sh documents for the identical reason.
#
# Password-type secrets are cached locally in infra/azure/.secrets/ (gitignored, chmod 600) so
# re-running this script doesn't change them out from under an already-running server.
#
# The API image is tagged with the current git short SHA rather than a floating `:latest` --
# reusing the same tag string is a no-op in Container Apps' revision diffing (it won't re-pull
# even though the digest changed), a real gotcha ADP hit the hard way.

set -euo pipefail

# centralus (2026-10-08): eastus2 hit repeated Postgres SkuNotAvailable for Standard_B1ms; moved
# here (matching ADP) rather than paying for a bigger SKU.
WHAT_IF_ONLY=false
ASSUME_YES=false
LOCATION="centralus"
for arg in "$@"; do
  case "$arg" in
    --what-if-only) WHAT_IF_ONLY=true ;;
    --yes) ASSUME_YES=true ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) LOCATION="$arg" ;;
  esac
done
if [[ "$WHAT_IF_ONLY" == true && "$ASSUME_YES" == true ]]; then
  echo "--what-if-only and --yes can't be combined." >&2
  exit 2
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SECRETS_DIR="$SCRIPT_DIR/.secrets"
PG_PASSWORD_FILE="$SECRETS_DIR/postgres-admin-password"
SESSION_SECRET_FILE="$SECRETS_DIR/session-secret"
OIDC_CLIENT_SECRET_FILE="$SECRETS_DIR/oidc-client-secret"
RESOURCE_GROUP="canvas-rg"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

if [[ ! -f "$PG_PASSWORD_FILE" ]]; then
  echo "Generating Postgres admin password (first run) -> $PG_PASSWORD_FILE"
  # Alphanumeric-only, not raw base64: this password gets embedded directly in the DATABASE_URL
  # connection string canvas-migrate/canvas-api build (postgres://user:PASSWORD@host/db) -- a
  # real deploy hit this the hard way: pg-connection-string's parser uses a strict WHATWG URL(),
  # and base64's own +/= (and occasionally /) characters are not valid unescaped there, so a
  # generated password containing one silently broke every DB connection with "TypeError: Invalid
  # URL" until this was diagnosed. Filtering to [A-Za-z0-9] avoids the whole class of "needs
  # percent-encoding" bugs rather than adding escaping logic; 24 alphanumeric characters is still
  # ~140 bits of entropy, comfortably above Azure Postgres Flexible Server's own complexity floor
  # (needs 3 of upper/lower/digit/special -- alphanumeric alone already covers upper+lower+digit).
  openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 24 > "$PG_PASSWORD_FILE"
  chmod 600 "$PG_PASSWORD_FILE"
fi
PG_ADMIN_PASSWORD="$(cat "$PG_PASSWORD_FILE")"

if [[ ! -f "$SESSION_SECRET_FILE" ]]; then
  echo "Generating SESSION_SECRET (first run) -> $SESSION_SECRET_FILE"
  openssl rand -base64 32 > "$SESSION_SECRET_FILE"
  chmod 600 "$SESSION_SECRET_FILE"
fi
SESSION_SECRET="$(cat "$SESSION_SECRET_FILE")"

# canvas-ez1.5: the AES-256 key encrypting stored two-step-verification secrets. Generated once and
# kept: replacing it makes every enrolled authenticator unreadable (each user would need Reset MFA).
MFA_KEY_FILE="$SECRETS_DIR/mfa-encryption-key"
if [[ ! -f "$MFA_KEY_FILE" ]]; then
  openssl rand -base64 32 | tr -d '\n' > "$MFA_KEY_FILE"
  chmod 600 "$MFA_KEY_FILE"
fi
MFA_ENCRYPTION_KEY="$(cat "$MFA_KEY_FILE")"

# canvas-haz: unlike the self-hosted Keycloak this replaced (whose client secret this script could
# freely generate itself, since it also owned reconciling that value into Keycloak's own running
# config), Entra ID generates the "canvas-azure" app registration's client secret itself -- there
# is no local-generate-and-push-to-the-IdP step possible here, only "the operator copies the real
# value out of the Entra portal/`az ad app credential reset` once" (RUNBOOK.md's "Entra ID SSO"
# section has the one-time setup steps). ENTRA_CLIENT_SECRET, if set, is cached to this same file
# exactly like the other secrets above so it only needs to be supplied once; if neither is present
# this is a hard error, not a silently-generated-and-therefore-useless placeholder.
# canvas-ez1.1: the sign-in model, cached like the AI provider below so a routine re-run without
# CANVAS_AUTH_MODE never flips a live environment's sign-in model.
AUTH_MODE_FILE="$SECRETS_DIR/auth-mode"
if [[ -n "${CANVAS_AUTH_MODE:-}" ]]; then
  printf '%s' "$CANVAS_AUTH_MODE" > "$AUTH_MODE_FILE"
  chmod 600 "$AUTH_MODE_FILE"
fi
AUTH_MODE="$(cat "$AUTH_MODE_FILE" 2>/dev/null || echo entra)"
case "$AUTH_MODE" in
  entra|local) ;;
  *) echo "ERROR: CANVAS_AUTH_MODE must be entra or local (got: $AUTH_MODE)." >&2; exit 1 ;;
esac

# canvas-1bty.6: which moved route groups canvas-api forwards to the Python service. Unset = all of them;
# CANVAS_PYTHON_ROUTE_GROUPS=none sends everything back to the TypeScript routes (kept one release as the
# fallback), or name the groups to keep on Python (apps/api/src/python/route-groups.ts). Not remembered
# between runs: set it on each deploy while you need it.
PYTHON_ROUTE_GROUPS="${CANVAS_PYTHON_ROUTE_GROUPS:-}"

# canvas-haz.9: CANVAS_OIDC_CLIENT_AUTH=managed-identity signs in to Entra with the API's managed
# identity through a federated credential on the app registration -- no client secret at all.
# Cached like the auth mode. The deploy prints the one-time 'az ad app federated-credential create'.
OIDC_CLIENT_AUTH_FILE="$SECRETS_DIR/oidc-client-auth"
if [[ -n "${CANVAS_OIDC_CLIENT_AUTH:-}" ]]; then
  printf '%s' "$CANVAS_OIDC_CLIENT_AUTH" > "$OIDC_CLIENT_AUTH_FILE"
  chmod 600 "$OIDC_CLIENT_AUTH_FILE"
fi
OIDC_CLIENT_AUTH="$(cat "$OIDC_CLIENT_AUTH_FILE" 2>/dev/null || echo secret)"
case "$OIDC_CLIENT_AUTH" in
  secret|managed-identity) ;;
  *) echo "ERROR: CANVAS_OIDC_CLIENT_AUTH must be secret or managed-identity (got: $OIDC_CLIENT_AUTH)." >&2; exit 1 ;;
esac

if [[ -n "${ENTRA_CLIENT_SECRET:-}" ]]; then
  printf '%s' "$ENTRA_CLIENT_SECRET" > "$OIDC_CLIENT_SECRET_FILE"
  chmod 600 "$OIDC_CLIENT_SECRET_FILE"
elif [[ "$AUTH_MODE" == local || "$OIDC_CLIENT_AUTH" == managed-identity ]]; then
  # No Entra in local mode; the Key Vault secret still has to exist for the app's secret reference.
  [[ -f "$OIDC_CLIENT_SECRET_FILE" ]] || { printf 'unset' > "$OIDC_CLIENT_SECRET_FILE"; chmod 600 "$OIDC_CLIENT_SECRET_FILE"; }
elif [[ ! -f "$OIDC_CLIENT_SECRET_FILE" ]]; then
  echo "ERROR: no Entra client secret found." >&2
  echo "Set ENTRA_CLIENT_SECRET to the 'canvas-azure' app registration's client secret value" >&2
  echo "(generated once in the Entra portal or via 'az ad app credential reset' -- this script" >&2
  echo "cannot generate it the way it could for the self-hosted Keycloak this replaced), or place" >&2
  echo "it directly in $OIDC_CLIENT_SECRET_FILE." >&2
  exit 1
fi
OIDC_CLIENT_SECRET="$(cat "$OIDC_CLIENT_SECRET_FILE")"

# canvas-brq: AI provider + keys. Previously AI_PROVIDER was hardwired to mock (main.bicep never
# forwarded apiapp.bicep's aiProvider param) and the keys were read from a repo-root .env that
# doesn't exist in this repo (the real dev key lives in apps/api/.env), so Key Vault only ever got
# the "unset" placeholder. Same caching shape as ENTRA_CLIENT_SECRET above: an env var, if set, is
# written to .secrets/ so it only has to be supplied once; the provider choice is cached too, so a
# routine re-run without CANVAS_AI_PROVIDER doesn't silently flip a live environment back to mock.
AI_PROVIDER_FILE="$SECRETS_DIR/ai-provider"
ANTHROPIC_KEY_FILE="$SECRETS_DIR/anthropic-api-key"
OPENAI_KEY_FILE="$SECRETS_DIR/openai-api-key"
# CANVAS_-prefixed on purpose: the unprefixed ANTHROPIC_API_KEY is commonly already exported in a
# developer's shell for other tools, and an earlier version of this block silently cached THAT key
# over the one placed in .secrets/ (a different, invalid key ended up in production).
for pair in "CANVAS_AI_PROVIDER:$AI_PROVIDER_FILE" "CANVAS_ANTHROPIC_API_KEY:$ANTHROPIC_KEY_FILE" "CANVAS_OPENAI_API_KEY:$OPENAI_KEY_FILE"; do
  var="${pair%%:*}"; file="${pair#*:}"
  if [[ -n "${!var:-}" ]]; then
    printf '%s' "${!var}" > "$file"
    chmod 600 "$file"
  fi
done
AI_PROVIDER="$(cat "$AI_PROVIDER_FILE" 2>/dev/null || echo mock)"
ANTHROPIC_KEY="$(cat "$ANTHROPIC_KEY_FILE" 2>/dev/null || true)"
OPENAI_KEY="$(cat "$OPENAI_KEY_FILE" 2>/dev/null || true)"
case "$AI_PROVIDER" in
  mock) ;;
  anthropic)
    [[ -n "$ANTHROPIC_KEY" ]] || { echo "ERROR: AI_PROVIDER=anthropic but no Anthropic key -- set CANVAS_ANTHROPIC_API_KEY (cached to $ANTHROPIC_KEY_FILE)." >&2; exit 1; }
    # A placeholder (e.g. a dev .env's dummy value) deploys "successfully" and then fails every
    # chat with a 401 from Anthropic -- happened on canvas-brq's first deploy.
    [[ "$ANTHROPIC_KEY" == sk-ant-* ]] || echo "WARNING: the Anthropic key doesn't start with 'sk-ant-' -- likely a placeholder; AI chat will fail." >&2
    ;;
  openai) [[ -n "$OPENAI_KEY" ]] || { echo "ERROR: AI_PROVIDER=openai but no OpenAI key -- set CANVAS_OPENAI_API_KEY (cached to $OPENAI_KEY_FILE)." >&2; exit 1; } ;;
  *) echo "ERROR: AI_PROVIDER must be mock, anthropic or openai (got: $AI_PROVIDER)." >&2; exit 1 ;;
esac

# canvas-3s5.1: the GitHub App diagrams are submitted for approval with (docs/admin-guide/github.md).
# Optional: without both values the integration stays off. Cached in .secrets/ like the AI keys, so
# they only have to be supplied once; the private key is stored base64-encoded (one line).
GITHUB_APP_ID_FILE="$SECRETS_DIR/github-app-id"
GITHUB_KEY_FILE="$SECRETS_DIR/github-app-private-key"
if [[ -n "${CANVAS_GITHUB_APP_ID:-}" ]]; then
  [[ "$CANVAS_GITHUB_APP_ID" =~ ^[0-9]+$ ]] || { echo "ERROR: CANVAS_GITHUB_APP_ID must be the App's numeric id (got: $CANVAS_GITHUB_APP_ID)." >&2; exit 1; }
  printf '%s' "$CANVAS_GITHUB_APP_ID" > "$GITHUB_APP_ID_FILE"
  chmod 600 "$GITHUB_APP_ID_FILE"
fi
if [[ -n "${CANVAS_GITHUB_APP_PRIVATE_KEY_FILE:-}" ]]; then
  grep -q -- '-----BEGIN .*PRIVATE KEY-----' "$CANVAS_GITHUB_APP_PRIVATE_KEY_FILE" 2>/dev/null \
    || { echo "ERROR: $CANVAS_GITHUB_APP_PRIVATE_KEY_FILE is not a PEM private key (download one from the GitHub App's settings)." >&2; exit 1; }
  base64 < "$CANVAS_GITHUB_APP_PRIVATE_KEY_FILE" | tr -d '\n' > "$GITHUB_KEY_FILE"
  chmod 600 "$GITHUB_KEY_FILE"
fi
GITHUB_APP_ID="$(cat "$GITHUB_APP_ID_FILE" 2>/dev/null || echo unset)"
GITHUB_KEY="$(cat "$GITHUB_KEY_FILE" 2>/dev/null || true)"
if [[ "$GITHUB_APP_ID" != unset && -z "$GITHUB_KEY" ]]; then
  echo "ERROR: a GitHub App id is set but no private key -- set CANVAS_GITHUB_APP_PRIVATE_KEY_FILE (cached to $GITHUB_KEY_FILE)." >&2
  exit 1
fi

# Defaults to the deploying subscription's own tenant, matching main.bicep's own entraTenantId
# default -- override only if the app registration lives in a different tenant.
ENTRA_TENANT_ID="${ENTRA_TENANT_ID:-$(az account show --query tenantId -o tsv)}"

if [[ -z "${ENTRA_CLIENT_ID:-}" && "$AUTH_MODE" == entra ]]; then
  echo "ERROR: ENTRA_CLIENT_ID is required -- the 'canvas-azure' Entra app registration's" >&2
  echo "Application (client) ID. See RUNBOOK.md's 'Entra ID SSO' section for the one-time setup" >&2
  echo "steps that produce this value." >&2
  exit 1
fi
ENTRA_CLIENT_ID="${ENTRA_CLIENT_ID:-}"
echo "== Sign-in: $AUTH_MODE =="

# canvas-ez1.3: the first admin of a local-mode environment.
ADMIN_EMAIL_FILE="$SECRETS_DIR/admin-email"
BOOTSTRAP_PASSWORD_FILE="$SECRETS_DIR/bootstrap-admin-password"
ADMIN_EMAIL=""
if [[ "$AUTH_MODE" == local ]]; then
  if [[ -n "${CANVAS_ADMIN_EMAIL:-}" ]]; then
    printf '%s' "$CANVAS_ADMIN_EMAIL" > "$ADMIN_EMAIL_FILE"
    chmod 600 "$ADMIN_EMAIL_FILE"
  fi
  ADMIN_EMAIL="$(cat "$ADMIN_EMAIL_FILE" 2>/dev/null || true)"
  if [[ -z "$ADMIN_EMAIL" ]]; then
    echo "ERROR: AUTH_MODE=local needs the first admin's email -- set CANVAS_ADMIN_EMAIL (cached to $ADMIN_EMAIL_FILE)." >&2
    exit 1
  fi
  if [[ ! -f "$BOOTSTRAP_PASSWORD_FILE" ]]; then
    # 20 alphanumerics (~119 bits); passes the password policy (apps/api/src/auth/password-policy.ts).
    openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 20 > "$BOOTSTRAP_PASSWORD_FILE"
    chmod 600 "$BOOTSTRAP_PASSWORD_FILE"
  fi
  echo "  First admin: $ADMIN_EMAIL (one-time password in $BOOTSTRAP_PASSWORD_FILE)"
fi

DEPLOYER_PRINCIPAL_ID="$(az ad signed-in-user show --query id -o tsv)"

# canvas-cng: the IP allow-list for the API ingress and the web Storage account (see the header).
ALLOWED_IPS_FILE="$SECRETS_DIR/allowed-ips"
if [[ ! -f "$ALLOWED_IPS_FILE" ]] \
   && az containerapp show -g "$RESOURCE_GROUP" -n canvas-api --query name -o tsv >/dev/null 2>&1; then
  live_rules="$(az containerapp ingress access-restriction list -g "$RESOURCE_GROUP" -n canvas-api \
    --query "[?action=='Allow'].[ipAddressRange, description]" -o tsv 2>/dev/null | sed 's/\t/  /' || true)"
  if [[ -n "$live_rules" ]]; then
    echo "  No $ALLOWED_IPS_FILE -- recreating it from canvas-api's live allow-list."
    printf '%s\n' "$live_rules" > "$ALLOWED_IPS_FILE"
    chmod 600 "$ALLOWED_IPS_FILE"
  fi
fi
ALLOWED_IPS_JSON='[]'
if [[ -f "$ALLOWED_IPS_FILE" ]]; then
  # Validated here so a typo fails before anything deploys. IPv6 and /31 are rejected: the
  # Storage firewall can't take them (single addresses are written as /32).
  ALLOWED_IPS_JSON="$(python3 - "$ALLOWED_IPS_FILE" <<'PY'
import ipaddress, json, sys
ranges = []
for number, raw in enumerate(open(sys.argv[1]), start=1):
    line = raw.split("#", 1)[0].strip()
    if not line:
        continue
    cidr, _, desc = line.partition(" ")
    try:
        network = ipaddress.ip_network(cidr, strict=False)
    except ValueError as error:
        sys.exit(f"allowed-ips line {number}: {error}")
    if network.version != 4:
        sys.exit(f"allowed-ips line {number}: {cidr} -- only IPv4 ranges are supported")
    if network.prefixlen == 31:
        sys.exit(f"allowed-ips line {number}: {cidr} -- write a /31 as two /32 lines (the Storage firewall rejects /31)")
    ranges.append({"cidr": str(network), "description": desc.strip() or "allowed"})
print(json.dumps(ranges))
PY
)"
fi
if [[ "$ALLOWED_IPS_JSON" == "[]" && "$AUTH_MODE" == local ]]; then
  # Option B's passwords are the only per-user control, so the network list is mandatory.
  echo "AUTH_MODE=local needs an IP allow-list (CANVAS_ALLOW_PUBLIC=1 doesn't apply):" >&2
  echo "add one 'CIDR description' per line to $ALLOWED_IPS_FILE." >&2
  exit 1
fi
if [[ "$ALLOWED_IPS_JSON" == "[]" && "${CANVAS_ALLOW_PUBLIC:-}" != "1" ]]; then
  echo "No IP allow-list: the API and the web app would be reachable from anywhere." >&2
  echo "Add one 'CIDR description' per line to $ALLOWED_IPS_FILE," >&2
  echo "or re-run with CANVAS_ALLOW_PUBLIC=1 to deploy it public on purpose." >&2
  exit 1
fi
echo "== IP allow-list: $(python3 -c "import json,sys; print(', '.join(r['cidr'] for r in json.loads(sys.argv[1])) or 'NONE (public)')" "$ALLOWED_IPS_JSON") =="
# This machine uploads the web app (and pause.sh/resume.sh swap pages) through the Storage data
# plane, which the firewall would refuse -- so it has to be covered by the list itself.
if [[ "$ALLOWED_IPS_JSON" != "[]" ]]; then
  MY_IP="$(curl -s --max-time 10 https://api.ipify.org || true)"
  if [[ -z "$MY_IP" ]]; then
    echo "  WARNING: couldn't determine this machine's public IP to check it against the list."
  elif ! python3 -c "import ipaddress,json,sys; ip=ipaddress.ip_address(sys.argv[1]); sys.exit(0 if any(ip in ipaddress.ip_network(r['cidr']) for r in json.loads(sys.argv[2])) else 1)" "$MY_IP" "$ALLOWED_IPS_JSON"; then
    echo "This machine's public IP ($MY_IP) isn't in $ALLOWED_IPS_FILE -- the web app upload would be" >&2
    echo "refused by the Storage firewall. Add it (e.g. \"$MY_IP/32  <who/where>\") and re-run." >&2
    exit 1
  fi
fi

API_IMAGE_TAG="$(cd "$REPO_ROOT" && git rev-parse --short HEAD)"
if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null || ! git -C "$REPO_ROOT" diff --cached --quiet 2>/dev/null; then
  API_IMAGE_TAG="${API_IMAGE_TAG}-dirty-$(date +%s)"
fi

# canvas-7zw: what-if and the deployment both fail with ServerStoppedError against a paused
# Postgres, buried in Azure's multi-error output -- say so up front instead.
POSTGRES_STATE="$(az postgres flexible-server show --resource-group "$RESOURCE_GROUP" --name canvas-postgres \
  --query state -o tsv 2>/dev/null || true)"
if [[ "$POSTGRES_STATE" == "Stopped" || "$POSTGRES_STATE" == "Stopping" ]]; then
  echo "canvas-postgres is $POSTGRES_STATE (environment paused) -- run ./resume.sh first." >&2
  exit 1
fi

EXISTING_KEY_VAULT="$(az keyvault list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null || true)"
EXISTING_ACR="$(az acr list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null || true)"

# canvas-vp1: modules/keyvault.bicep's acrPullAssignment (originally declared in the now-deleted
# modules/keycloak.bicep, moved here by canvas-haz -- see that module's own header comment) was
# being re-declared (and therefore re-PUT by ARM) on literally every run, since main.bicep
# redeploys every module every time regardless of which image tag changed -- and a role-assignment
# PUT with unchanged properties is not reliably a safe no-op (reproduced live: "RoleAssignmentExists",
# 4 times in a row, including immediately after deleting and letting a redeploy recreate it fresh).
# Rather than trying to make a second PUT of an already-existing assignment land safely, skip it
# entirely once it's already there: look up the shared identity (canvas-identity, created by
# modules/keyvault.bicep) and check for an existing AcrPull grant AT THE RESOURCE GROUP --
# acrPullAssignment declares `scope: resourceGroup()`, not the ACR resource itself (broader than
# strictly needed, but that's what's actually declared and re-PUT each run, so this must check the
# same scope or it will never find what it's looking for -- confirmed live: an early version of
# this check queried the
# ACR's own resource ID and always came back empty even with the grant present one level up).
GRANT_ACR_PULL="true"
EXISTING_IDENTITY_PRINCIPAL_ID="$(az identity show --resource-group "$RESOURCE_GROUP" --name canvas-identity \
  --query principalId -o tsv 2>/dev/null || true)"
if [[ -n "$EXISTING_IDENTITY_PRINCIPAL_ID" ]]; then
  EXISTING_ACR_PULL_ASSIGNMENT="$(az role assignment list --assignee "$EXISTING_IDENTITY_PRINCIPAL_ID" \
    --resource-group "$RESOURCE_GROUP" --role AcrPull --query "[0].id" -o tsv 2>/dev/null || true)"
  if [[ -n "$EXISTING_ACR_PULL_ASSIGNMENT" ]]; then
    GRANT_ACR_PULL="false"
    echo "== Identity already holds AcrPull on $RESOURCE_GROUP -- skipping role assignment this run =="
  fi
fi
# canvas-r3y: canvas-api serves the web app itself, so the public URL is the API's own and
# main.bicep computes it (empty here = that default).
WEB_ORIGIN=""

# canvas-28j: Container Apps caches a Key Vault secret reference's VALUE at the app/job level
# (refreshed only every ~30 min) and a new revision does NOT refetch it -- found live 2026-10-08:
# a real Anthropic key written to KV at 21:08 was still the old placeholder in the 21:14 revision
# ('invalid x-api-key'). So every secret whose value this run actually changes is recorded here and
# force-refreshed after the deployment (refresh_kv_secret_refs, below). The list lives in .secrets/
# rather than a shell variable so a run that dies between writing KV and refreshing the apps still
# gets refreshed on the next run, even though KV will already hold the new value by then.
PENDING_REFRESH_FILE="$SECRETS_DIR/pending-secret-refresh"

# Writes a KV secret only if its value differs (no needless new secret versions), recording the
# name for refresh when it does.
kv_set_tracked() {
  local name="$1" value="$2" current
  current="$(az keyvault secret show --vault-name "$EXISTING_KEY_VAULT" --name "$name" \
    --query value -o tsv 2>/dev/null || true)"
  if [[ "$current" == "$value" ]]; then
    return 0
  fi
  az keyvault secret set --vault-name "$EXISTING_KEY_VAULT" --name "$name" --value "$value" --output none
  echo "$name" >> "$PENDING_REFRESH_FILE"
  chmod 600 "$PENDING_REFRESH_FILE"
  echo "  $name changed."
}

if [[ "$WHAT_IF_ONLY" == true ]]; then
  echo "== --what-if-only: skipping Key Vault secret writes and the image build =="
elif [[ -n "$EXISTING_KEY_VAULT" ]]; then
  echo "== Pre-seeding secrets into existing Key Vault ($EXISTING_KEY_VAULT) =="
  kv_set_tracked "postgres-admin-password" "$PG_ADMIN_PASSWORD"
  kv_set_tracked "session-secret" "$SESSION_SECRET"
  kv_set_tracked "mfa-encryption-key" "$MFA_ENCRYPTION_KEY"
  kv_set_tracked "oidc-client-secret" "$OIDC_CLIENT_SECRET"

  # The connection string needs the server's real FQDN/DB name; both are fixed/known after this
  # script's first-ever successful run, so a live lookup is safe even before this run's own
  # deployment happens.
  POSTGRES_FQDN="$(az postgres flexible-server show --resource-group "$RESOURCE_GROUP" \
    --name canvas-postgres --query "fullyQualifiedDomainName" -o tsv 2>/dev/null || true)"
  if [[ -n "$POSTGRES_FQDN" ]]; then
    DATABASE_URL="postgres://canvas_admin:${PG_ADMIN_PASSWORD}@${POSTGRES_FQDN}:5432/canvas?sslmode=require"
    kv_set_tracked "database-url" "$DATABASE_URL"
  fi

  # A provider without a real key is rejected up front (canvas-brq, above), so "unset" only ever
  # lands here for a provider that isn't in use.
  kv_set_tracked "anthropic-api-key" "${ANTHROPIC_KEY:-unset}"
  kv_set_tracked "openai-api-key" "${OPENAI_KEY:-unset}"
  kv_set_tracked "github-app-private-key" "${GITHUB_KEY:-unset}"
  if [[ "$AUTH_MODE" == local ]]; then
    kv_set_tracked "bootstrap-admin-password" "$(cat "$BOOTSTRAP_PASSWORD_FILE")"
  fi
  echo "  Secrets up to date (AI_PROVIDER=$AI_PROVIDER, GitHub App: $([[ "$GITHUB_APP_ID" == unset ]] && echo off || echo "$GITHUB_APP_ID"))."
else
  echo "== No existing Key Vault found -- skipping secret pre-seed (first-ever run) =="
fi

if [[ "$WHAT_IF_ONLY" == true ]]; then
  :
elif [[ -n "$EXISTING_ACR" ]]; then
  echo "== Building API image (repo root Dockerfile) to $EXISTING_ACR, tag $API_IMAGE_TAG =="
  az acr build --registry "$EXISTING_ACR" --image "canvas-api:${API_IMAGE_TAG}" "$REPO_ROOT" --output none
  # canvas-1bty.3: the Python backend (internal container), same tag.
  echo "== Building Python API image (apps/api-py/Dockerfile) to $EXISTING_ACR, tag $API_IMAGE_TAG =="
  az acr build --registry "$EXISTING_ACR" --image "canvas-api-py:${API_IMAGE_TAG}" --file "$REPO_ROOT/apps/api-py/Dockerfile" "$REPO_ROOT" --output none
  # canvas-1bty.4: the diagram-core bridge, the Python service's sidecar, same tag.
  echo "== Building diagram-core bridge image (packages/diagram-bridge/Dockerfile) to $EXISTING_ACR, tag $API_IMAGE_TAG =="
  az acr build --registry "$EXISTING_ACR" --image "canvas-diagram-bridge:${API_IMAGE_TAG}" --file "$REPO_ROOT/packages/diagram-bridge/Dockerfile" "$REPO_ROOT" --output none
else
  echo "== No existing ACR found -- skipping image build (first-ever run) =="
fi

echo "== What-if (dry run) =="
az deployment sub what-if \
  --name "canvas-foundation" \
  --location "$LOCATION" \
  --template-file "$SCRIPT_DIR/main.bicep" \
  --parameters location="$LOCATION" postgresAdminPassword="$PG_ADMIN_PASSWORD" \
    deployerPrincipalId="$DEPLOYER_PRINCIPAL_ID" apiImageTag="$API_IMAGE_TAG" \
    webOrigin="$WEB_ORIGIN" grantAcrPull="$GRANT_ACR_PULL" \
    entraTenantId="$ENTRA_TENANT_ID" entraClientId="$ENTRA_CLIENT_ID" aiProvider="$AI_PROVIDER" \
    allowedIpRanges="$ALLOWED_IPS_JSON" authMode="$AUTH_MODE" adminEmail="$ADMIN_EMAIL" oidcClientAuth="$OIDC_CLIENT_AUTH" \
    githubAppId="$GITHUB_APP_ID" pythonRouteGroups="$PYTHON_ROUTE_GROUPS"

echo
if [[ "$WHAT_IF_ONLY" == true ]]; then
  echo "== --what-if-only: stopping before the deployment (image tag would be $API_IMAGE_TAG) =="
  exit 0
fi
if [[ "$ASSUME_YES" == true ]]; then
  echo "== --yes: proceeding without the confirmation prompt =="
else
  read -r -p "Proceed with deployment? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "== Deploying =="
az deployment sub create \
  --name "canvas-foundation" \
  --location "$LOCATION" \
  --template-file "$SCRIPT_DIR/main.bicep" \
  --parameters location="$LOCATION" postgresAdminPassword="$PG_ADMIN_PASSWORD" \
    deployerPrincipalId="$DEPLOYER_PRINCIPAL_ID" apiImageTag="$API_IMAGE_TAG" \
    webOrigin="$WEB_ORIGIN" grantAcrPull="$GRANT_ACR_PULL" \
    entraTenantId="$ENTRA_TENANT_ID" entraClientId="$ENTRA_CLIENT_ID" aiProvider="$AI_PROVIDER" \
    allowedIpRanges="$ALLOWED_IPS_JSON" authMode="$AUTH_MODE" adminEmail="$ADMIN_EMAIL" oidcClientAuth="$OIDC_CLIENT_AUTH" \
    githubAppId="$GITHUB_APP_ID" pythonRouteGroups="$PYTHON_ROUTE_GROUPS" \
  --output table

STORAGE_ACCOUNT="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.storageAccountName.value" -o tsv)"
KEY_VAULT_NAME="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.keyVaultName.value" -o tsv)"
API_FQDN="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.apiFqdn.value" -o tsv)"
MIGRATION_JOB="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.migrationJobName.value" -o tsv)"
OIDC_REDIRECT_URI="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.oidcRedirectUri.value" -o tsv)"
# canvas-r3y: Canvas's address is canvas-api's own (it serves the web app).
REAL_WEB_ORIGIN="https://${API_FQDN}"

echo "== Enabling static website hosting on $STORAGE_ACCOUNT (data-plane -- no Bicep resource for this, see modules/storage.bicep) =="
# storage.bicep's Storage Blob Data Contributor role assignment for the deployer may have been
# created moments ago in the deployment just above -- Azure RBAC propagation is eventually
# consistent, typically seconds but occasionally a couple of minutes, so a --auth-mode login call
# immediately after can genuinely fail with an authorization error even though the assignment is
# correct and will succeed on retry. Not an issue on a re-run of this script (the role already
# existed), only ever bites the very first deploy.
for attempt in 1 2 3 4 5; do
  if az storage blob service-properties update \
    --account-name "$STORAGE_ACCOUNT" --auth-mode login \
    --static-website --index-document index.html --404-document index.html --output none 2>/tmp/canvas-deploy-blob-err; then
    break
  fi
  if [[ "$attempt" == 5 ]]; then
    echo "  Failed after 5 attempts -- likely a real permissions problem, not just RBAC propagation delay:"
    cat /tmp/canvas-deploy-blob-err >&2
    exit 1
  fi
  echo "  Attempt $attempt failed (likely RBAC propagation delay) -- retrying in 20s..."
  sleep 20
done
rm -f /tmp/canvas-deploy-blob-err

SEED_JOB="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.seedJobName.value" -o tsv)"
CATALOG_SEED_JOB="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.catalogSeedJobName.value" -o tsv)"
BOOTSTRAP_JOB="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.bootstrapAdminJobName.value" -o tsv)"
GITHUB_SYNC_JOB="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.githubSyncJobName.value" -o tsv 2>/dev/null || true)"

# canvas-28j: force canvas-api and the jobs to refetch any KV secret this (or an earlier,
# interrupted) run changed -- see PENDING_REFRESH_FILE above. Re-setting a secret with its same
# keyvaultref makes Container Apps re-read it from Key Vault; canvas-api's running replicas then
# need a revision restart to see it (a secret change creates no new revision), while a job's next
# execution simply starts with the new value. Each app's own secret list is read live so this
# never touches a secret an app doesn't reference. Runs after the WEB_ORIGINS patch (which creates
# a new revision -- one that would otherwise still carry the cached values) and before the
# migration job (which needs a rotated database-url).
refresh_kv_secret_refs() {
  [[ -s "$PENDING_REFRESH_FILE" ]] || return 0
  local changed identity_id kv_uri target kind name args revision secret
  changed="$(sort -u "$PENDING_REFRESH_FILE")"
  echo "== Refreshing rotated Key Vault secret references: ${changed//$'\n'/ } =="
  identity_id="$(az identity show --resource-group "$RESOURCE_GROUP" --name canvas-identity --query id -o tsv)"
  kv_uri="$(az keyvault show --name "$KEY_VAULT_NAME" --query properties.vaultUri -o tsv)"
  for target in "app:canvas-api" "job:$MIGRATION_JOB" "job:$SEED_JOB" "job:$CATALOG_SEED_JOB" "job:$BOOTSTRAP_JOB" "job:$GITHUB_SYNC_JOB"; do
    kind="${target%%:*}"; name="${target#*:}"
    [[ -n "$name" ]] || continue  # a job this auth mode doesn't deploy (canvas-ez1.3)
    local -a cmd=(az containerapp)
    [[ "$kind" == job ]] && cmd+=(job)
    args=()
    while read -r secret; do
      grep -qxF "$secret" <<<"$changed" && args+=("${secret}=keyvaultref:${kv_uri}secrets/${secret},identityref:${identity_id}")
    done < <("${cmd[@]}" show --name "$name" --resource-group "$RESOURCE_GROUP" \
      --query "properties.configuration.secrets[].name" -o tsv)
    [[ ${#args[@]} -gt 0 ]] || continue
    "${cmd[@]}" secret set --name "$name" --resource-group "$RESOURCE_GROUP" --secrets "${args[@]}" --output none
    echo "  $name: refreshed ${#args[@]} secret(s)."
    if [[ "$kind" == app ]]; then
      for revision in $(az containerapp revision list --name "$name" --resource-group "$RESOURCE_GROUP" \
        --query "[?properties.active].name" -o tsv); do
        az containerapp revision restart --name "$name" --resource-group "$RESOURCE_GROUP" \
          --revision "$revision" --output none
        echo "  $name: restarted revision $revision."
      done
    fi
  done
  rm -f "$PENDING_REFRESH_FILE"
}
refresh_kv_secret_refs

# canvas-r3y: the web app is built into the canvas-api image and served from its URL. The old
# Storage static website now only holds a page that sends old bookmarks (deep links included) to
# the new address, and the licence files.
echo "== Pointing the old web address ($STORAGE_ACCOUNT) at https://${API_FQDN} =="
REDIRECT_PAGE="$(mktemp)"
cat > "$REDIRECT_PAGE" <<HTML
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Canvas has moved</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>location.replace("https://${API_FQDN}/" + location.search + location.hash);</script>
<meta http-equiv="refresh" content="0; url=https://${API_FQDN}/">
</head><body><p>Canvas has moved to <a href="https://${API_FQDN}/">https://${API_FQDN}/</a>. Please update your bookmark.</p></body></html>
HTML
az storage blob upload \
  --account-name "$STORAGE_ACCOUNT" --container-name '$web' --name index.html \
  --file "$REDIRECT_PAGE" --content-type "text/html; charset=utf-8" \
  --content-cache-control "no-cache" --auth-mode login --overwrite --output none
rm -f "$REDIRECT_PAGE"
# The old app's bundles and the paused-page swap copies are no longer needed there.
az storage blob delete-batch --account-name "$STORAGE_ACCOUNT" --source '$web' --pattern 'assets/*' \
  --auth-mode login --output none 2>/dev/null || true
az storage blob delete --account-name "$STORAGE_ACCOUNT" --container-name '$web' --name index.live.html \
  --auth-mode login --output none 2>/dev/null || true

# Polls a Container Apps Job execution until it reaches a terminal state, failing the whole
# deploy (set -e) if the job itself fails -- a clean build with a failed migration or an empty
# DiagramType catalog is not actually a working environment, so this script shouldn't report
# success and hand that back to the caller silently.
wait_for_job_execution() {
  local job_name="$1" execution_name="$2" label="$3" status=""
  echo "  Waiting for $label (execution $execution_name)..."
  while true; do
    status="$(az containerapp job execution show --name "$job_name" --job-execution-name "$execution_name" \
      --resource-group "$RESOURCE_GROUP" --query "properties.status" -o tsv 2>/dev/null || true)"
    case "$status" in
      Succeeded)
        echo "  $label succeeded."
        return 0
        ;;
      Failed)
        echo "  $label FAILED -- inspect its logs, then re-run this script once fixed:" >&2
        echo "    az containerapp job execution list --name $job_name --resource-group $RESOURCE_GROUP -o table" >&2
        return 1
        ;;
      *)
        sleep 5
        ;;
    esac
  done
}

# canvas-a8mr: every job start in these scripts is a plain `az containerapp job start --name ...`
# with no --image/--command/--args/--env-vars/--cpu/--memory/--yaml. Since Microsoft's 2026-10
# change, a start WITH container overrides also needs Microsoft.App/jobs/write; keep starts
# override-free and change a job's settings with `az containerapp job update` instead (as
# reset-admin.sh does).
echo
echo "== Running database migrations (canvas-migrate job) =="
MIGRATION_EXECUTION="$(az containerapp job start --name "$MIGRATION_JOB" --resource-group "$RESOURCE_GROUP" --query name -o tsv)"
wait_for_job_execution "$MIGRATION_JOB" "$MIGRATION_EXECUTION" "Migration job"

echo
echo "== Seeding reference/lookup data (canvas-seed-catalog job: DiagramTypes, icon/shape" \
     "libraries, AiPersonas) =="
echo "  Runs unconditionally, unlike canvas-seed below -- this is idempotent catalog data a" \
     "fresh environment needs to be usable at all, not demo content."
CATALOG_SEED_EXECUTION="$(az containerapp job start --name "$CATALOG_SEED_JOB" --resource-group "$RESOURCE_GROUP" --query name -o tsv)"
wait_for_job_execution "$CATALOG_SEED_JOB" "$CATALOG_SEED_EXECUTION" "Catalog seed job"

if [[ "$AUTH_MODE" == local ]]; then
  # The demo seed job isn't deployed in local mode, but an environment switched from entra keeps
  # the old one (incremental deploys never delete) -- and it would create the published-password
  # demo accounts if anyone started it. Remove it.
  if az containerapp job show --name canvas-seed --resource-group "$RESOURCE_GROUP" --query name -o tsv >/dev/null 2>&1; then
    echo
    echo "== Removing the leftover canvas-seed demo job (published-password accounts; not for local mode) =="
    az containerapp job delete --name canvas-seed --resource-group "$RESOURCE_GROUP" --yes --output none
  fi

  echo
  echo "== First admin (canvas-bootstrap-admin job) =="
  echo "  Creates $ADMIN_EMAIL if it doesn't exist yet; an existing account is left unchanged."
  BOOTSTRAP_EXECUTION="$(az containerapp job start --name "$BOOTSTRAP_JOB" --resource-group "$RESOURCE_GROUP" --query name -o tsv)"
  wait_for_job_execution "$BOOTSTRAP_JOB" "$BOOTSTRAP_EXECUTION" "Bootstrap admin job"
fi

echo
echo "== Done =="
echo "  API:      https://${API_FQDN}"
echo "  Canvas:   ${REAL_WEB_ORIGIN}  (the old Storage address redirects here)"
echo "  Key Vault: $KEY_VAULT_NAME"
echo
if [[ "$AUTH_MODE" == local ]]; then
  echo "== Sign-in: local accounts (AUTH_MODE=local) =="
  echo "No Entra app registration is used. People sign in with Canvas-managed email + password"
  echo "accounts, only from the networks in $ALLOWED_IPS_FILE (RUNBOOK.md's 'Local accounts' section)."
  echo "First admin: $ADMIN_EMAIL -- sign in with the one-time password in"
  echo "  $BOOTSTRAP_PASSWORD_FILE"
  echo "and choose a new one; then add everyone else on Admin -> Users. (Once changed, that file no"
  echo "longer signs anyone in. A lone admin who can't sign in: ./reset-admin.sh.)"
  exit 0
fi
echo "The DiagramType catalog, bundled icon/shape libraries, and default AiPersonas are already"
echo "seeded (canvas-seed-catalog, above) -- the environment is usable as-is. To additionally seed"
echo "throwaway dev/demo content (one default project, one admin login) on top of that, run:"
echo "  az containerapp job start --name $SEED_JOB --resource-group $RESOURCE_GROUP"
echo "NOT run automatically -- it creates a demo admin account with a published local password"
echo "(apps/api/src/seed/run.ts), appropriate for a throwaway/demo environment, not unprompted"
echo "on every deploy of something meant to hold real data."
echo
echo "== Entra app registration -- action required =="
echo "ALLOW_LOCAL_AUTH defaults to false for this deployment (apiapp.bicep) -- Entra ID sign-in is"
echo "the only way in until you register this environment's real addresses on the 'canvas-azure'"
echo "app registration's Authentication blade (Web platform). Unlike the self-hosted Keycloak this"
echo "replaced, there is no admin REST API this script can PATCH on your behalf -- Graph API"
echo "write access for app registrations is a broader permission than this script should assume it"
echo "has, so this is a manual one-time step per environment (RUNBOOK.md's 'Entra ID SSO' section"
echo "has the full walkthrough). Entra has one Redirect URIs list per app registration serving"
echo "both sign-in and post-logout redirects -- add BOTH of these to it:"
echo "  Sign-in callback:   ${OIDC_REDIRECT_URI}"
echo "  Post-logout target: ${REAL_WEB_ORIGIN}"
echo
echo "Ready-to-paste (replaces the app registration's ENTIRE redirect URI list -- include any"
echo "other environments' URIs you still need, e.g. the 'canvas-dev' localhost ones, in the same"
echo "command if so):"
echo "  az ad app update --id \"$ENTRA_CLIENT_ID\" --web-redirect-uris \"${OIDC_REDIRECT_URI}\" \"${REAL_WEB_ORIGIN}\""
echo
if [[ "$OIDC_CLIENT_AUTH" == managed-identity ]]; then
  # canvas-haz.9: no client secret -- Entra trusts canvas-identity through a federated credential.
  MI_PRINCIPAL_ID="$(az identity show --resource-group "$RESOURCE_GROUP" --name canvas-identity --query principalId -o tsv)"
  TENANT_FOR_FIC="$(az account show --query tenantId -o tsv)"
  echo "Sign-in uses the managed identity, not a client secret (CANVAS_OIDC_CLIENT_AUTH=managed-identity)."
  echo "One-time, on the app registration (re-run only if canvas-identity is recreated):"
  echo "  az ad app federated-credential create --id \"$ENTRA_CLIENT_ID\" --parameters '{\"name\":\"canvas-api-managed-identity\",\"issuer\":\"https://login.microsoftonline.com/${TENANT_FOR_FIC}/v2.0\",\"subject\":\"${MI_PRINCIPAL_ID}\",\"audiences\":[\"api://AzureADTokenExchange\"]}'"
  echo "Then delete the app registration's old client secret(s) -- nothing uses them any more."
  echo
fi
echo "App roles (admin/architect/viewer -- apps/api/src/auth/types.ts's UserRole) and user/group"
echo "assignment are also managed entirely in the Entra portal; see RUNBOOK.md for the full"
echo "one-time app-registration setup this environment depends on."
