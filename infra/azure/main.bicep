// canvas Azure deployment -- entry point (canvas-ycu + canvas-haz, mirrors ADP's infra/azure/
// main.bicep).
//
// Subscription-scope: creates the resource group everything else deploys into, then hands off to
// per-resource modules scoped to it. The whole environment builds from this one file and tears
// down as one resource group (destroy.sh) -- see infra/azure/README.md for the full operational
// picture (deploy/pause/resume/destroy).
//
// canvas-haz: authenticates against Microsoft Entra ID (a real, always-public IdP), replacing a
// self-hosted Keycloak Container App this environment used to deploy alongside the API (its own
// internal-ingress container, a canvas-api /idp/* reverse proxy, a dedicated Postgres database,
// and a user-provisioning job) -- see RUNBOOK.md's "Entra ID SSO" section for the one-time app
// registration setup this replaced it with, and docs/solution-architecture-document.md's Decision
// Log for the full rationale.

targetScope = 'subscription'

@description('Azure region for all resources. Kept fully parameterized, not hardcoded -- this environment has hit real compute-quota restrictions in some regions (docs/azure-deployment.md), eastus2/westus2/centralus/westus3 are known to work.')
param location string = 'centralus'

@description('Name of the resource group canvas is deployed into.')
param resourceGroupName string = 'canvas-rg'

@description('Name of the Azure Container Registry. Must be globally unique, alphanumeric only, 5-50 chars.')
param acrName string = 'canvasacr${uniqueString(subscription().id)}'

@description('ACR SKU -- Basic is cheapest and sufficient for a single-environment deployment.')
@allowed(['Basic', 'Standard', 'Premium'])
param acrSku string = 'Basic'

@description('Postgres Flexible Server admin password. Supplied at deploy time via deploy.sh -- never hardcoded/committed.')
@secure()
param postgresAdminPassword string

@description('Object ID of the principal running this deployment (az ad signed-in-user show), granted Key Vault Secrets Officer.')
param deployerPrincipalId string

@description('Tag of the API image (repo-root Dockerfile), already built+pushed to ACR by deploy.sh before this runs. No default -- deploy.sh always supplies a unique tag (git short SHA) so a rebuild reliably produces a new revision, unlike a floating :latest tag (a real gotcha ADP hit: Container Apps revision diffing treats a same-tag image as a no-op even when the digest changed).')
param apiImageTag string

@description('Public URL the frontend is served from (WEB_ORIGINS). Empty on a from-scratch first deploy -- deploy.sh patches the real Storage static website URL in as a second pass once storage.bicep has actually created the account and static website hosting has been enabled on it (see storage.bicep\'s own comment for why this can\'t be known ahead of time the way the API\'s own public URL below can).')
param webOrigin string = ''

@description('canvas-vp1: forwarded to modules/keyvault.bicep\'s own grantAcrPull -- see that file\'s header comment. deploy.sh sets this to false once it has confirmed the shared identity already holds AcrPull, since this whole template (and therefore that module) redeploys on every run regardless of which image tag actually changed.')
param grantAcrPull bool = true

@description('canvas-haz: Entra ID tenant ID this app authenticates against. Defaults to the deploying subscription\'s own tenant -- override only if the app registration lives in a different tenant.')
param entraTenantId string = tenant().tenantId

@description('canvas-haz: the "canvas-azure" Entra app registration\'s Application (client) ID -- see RUNBOOK.md\'s "Entra ID SSO" section for the one-time setup steps that produce this value. No default: a missing client ID should fail the deployment loudly, not silently produce a broken OIDC_ISSUER_URL/OIDC_CLIENT_ID.')
param entraClientId string

@description('canvas-brq: forwarded to modules/apiapp.bicep\'s AI_PROVIDER -- "mock" (default, no real API calls) or "anthropic"/"openai". deploy.sh sets this from AI_PROVIDER and refuses a real provider while its Key Vault API key is still the "unset" placeholder.')
@allowed(['mock', 'anthropic', 'openai'])
param aiProvider string = 'mock'

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: resourceGroupName
  location: location
}

module acr 'modules/acr.bicep' = {
  name: 'acrDeploy'
  scope: rg
  params: {
    location: location
    acrName: acrName
    acrSku: acrSku
  }
}

module network 'modules/network.bicep' = {
  name: 'networkDeploy'
  scope: rg
  params: {
    location: location
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgresDeploy'
  scope: rg
  params: {
    location: location
    adminPassword: postgresAdminPassword
    delegatedSubnetId: network.outputs.postgresSubnetId
    privateDnsZoneId: network.outputs.privateDnsZoneId
  }
}

module keyVault 'modules/keyvault.bicep' = {
  name: 'keyVaultDeploy'
  scope: rg
  params: {
    location: location
    deployerPrincipalId: deployerPrincipalId
    acrId: acr.outputs.acrId
    grantAcrPull: grantAcrPull
  }
}

module containerAppsEnv 'modules/containerappsenv.bicep' = {
  name: 'containerAppsEnvDeploy'
  scope: rg
  params: {
    location: location
    infrastructureSubnetId: network.outputs.containerAppsSubnetId
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storageDeploy'
  scope: rg
  params: {
    location: location
    deployerPrincipalId: deployerPrincipalId
  }
}

// canvas-api's own public URL, known before it deploys (Container Apps environments give every
// app a predictable FQDN of <app-name>.<environmentDefaultDomain>) -- this is what oidcRedirectUri
// is built from, and what deploy.sh prints as the exact Entra redirect URI to register.
var apiPublicBaseUrl = 'https://canvas-api.${containerAppsEnv.outputs.environmentDefaultDomain}'
var oidcRedirectUri = '${apiPublicBaseUrl}/auth/callback'

module apiApp 'modules/apiapp.bicep' = {
  name: 'apiAppDeploy'
  scope: rg
  params: {
    location: location
    environmentId: containerAppsEnv.outputs.environmentId
    identityId: keyVault.outputs.identityId
    acrLoginServer: acr.outputs.loginServer
    apiImageTag: apiImageTag
    keyVaultUri: keyVault.outputs.keyVaultUri
    webOrigin: webOrigin
    entraTenantId: entraTenantId
    entraClientId: entraClientId
    oidcRedirectUri: oidcRedirectUri
    aiProvider: aiProvider
  }
}

module migrationJob 'modules/migrationjob.bicep' = {
  name: 'migrationJobDeploy'
  scope: rg
  params: {
    location: location
    environmentId: containerAppsEnv.outputs.environmentId
    identityId: keyVault.outputs.identityId
    acrLoginServer: acr.outputs.loginServer
    apiImageTag: apiImageTag
    keyVaultUri: keyVault.outputs.keyVaultUri
  }
}

module seedJob 'modules/seedjob.bicep' = {
  name: 'seedJobDeploy'
  scope: rg
  params: {
    location: location
    environmentId: containerAppsEnv.outputs.environmentId
    identityId: keyVault.outputs.identityId
    acrLoginServer: acr.outputs.loginServer
    apiImageTag: apiImageTag
    keyVaultUri: keyVault.outputs.keyVaultUri
  }
}

module catalogSeedJob 'modules/catalogseedjob.bicep' = {
  name: 'catalogSeedJobDeploy'
  scope: rg
  params: {
    location: location
    environmentId: containerAppsEnv.outputs.environmentId
    identityId: keyVault.outputs.identityId
    acrLoginServer: acr.outputs.loginServer
    apiImageTag: apiImageTag
    keyVaultUri: keyVault.outputs.keyVaultUri
  }
}

output resourceGroupName string = rg.name
output acrName string = acr.outputs.acrName
output acrLoginServer string = acr.outputs.loginServer
output postgresServerName string = postgres.outputs.serverName
output postgresServerFqdn string = postgres.outputs.serverFqdn
output postgresDatabaseName string = postgres.outputs.databaseName
output keyVaultName string = keyVault.outputs.keyVaultName
output keyVaultUri string = keyVault.outputs.keyVaultUri
output identityId string = keyVault.outputs.identityId
output identityClientId string = keyVault.outputs.identityClientId
output containerAppsEnvironmentId string = containerAppsEnv.outputs.environmentId
output containerAppsEnvironmentName string = containerAppsEnv.outputs.environmentName
output storageAccountName string = storage.outputs.storageAccountName
output apiFqdn string = apiApp.outputs.fqdn
output oidcRedirectUri string = oidcRedirectUri
output migrationJobName string = migrationJob.outputs.jobName
output seedJobName string = seedJob.outputs.jobName
output catalogSeedJobName string = catalogSeedJob.outputs.jobName
