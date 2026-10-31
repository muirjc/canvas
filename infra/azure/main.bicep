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

@description('canvas-r3y: the web app is served by canvas-api itself, so the public URL is the API\'s own (computed below). Kept as a parameter only to override it (e.g. a custom domain); empty = the API\'s URL.')
param webOrigin string = ''

@description('canvas-vp1: forwarded to modules/keyvault.bicep\'s own grantAcrPull -- see that file\'s header comment. deploy.sh sets this to false once it has confirmed the shared identity already holds AcrPull, since this whole template (and therefore that module) redeploys on every run regardless of which image tag actually changed.')
param grantAcrPull bool = true

@description('canvas-haz: Entra ID tenant ID this app authenticates against. Defaults to the deploying subscription\'s own tenant -- override only if the app registration lives in a different tenant.')
param entraTenantId string = tenant().tenantId

@description('canvas-haz: the "canvas-azure" Entra app registration\'s Application (client) ID -- see RUNBOOK.md\'s "Entra ID SSO" section for the one-time setup steps that produce this value. Empty only with authMode "local" (canvas-ez1.1), where it is unused; deploy.sh requires it in entra mode.')
param entraClientId string = ''

@description('canvas-ez1.1: forwarded to modules/apiapp.bicep\'s AUTH_MODE -- "entra" (default) or "local".')
@allowed(['entra', 'local'])
param authMode string = 'entra'

@description('canvas-ez1.3: the first admin\'s email in local mode (bootstrap-admin job). Unused in entra mode.')
param adminEmail string = ''

@description('canvas-brq: forwarded to modules/apiapp.bicep\'s AI_PROVIDER -- "mock" (default, no real API calls) or "anthropic"/"openai". deploy.sh sets this from AI_PROVIDER and refuses a real provider while its Key Vault API key is still the "unset" placeholder.')
@allowed(['mock', 'anthropic', 'openai'])
param aiProvider string = 'mock'

@description('canvas-cng: IP allow-list ([{ cidr, description }]) for the API ingress and the web Storage account. Empty = public (deploy.sh only allows that with CANVAS_ALLOW_PUBLIC=1).')
param allowedIpRanges array = []

@description('canvas-3s5.1: the GitHub App diagrams are submitted for approval with (docs/admin-guide/github.md). "unset" = the integration is off. Its private key is the Key Vault secret github-app-private-key (deploy.sh).')
param githubAppId string = 'unset'

@description('canvas-3s5.1: GitHub REST API base URL (github.com by default).')
param githubApiUrl string = 'https://api.github.com'

@description('canvas-haz.9: "secret" or "managed-identity" (federated credential, no client secret).')
@allowed(['secret', 'managed-identity'])
param oidcClientAuth string = 'secret'

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
    allowedIpRanges: allowedIpRanges
  }
}

// canvas-api's own public URL, known before it deploys (Container Apps environments give every
// app a predictable FQDN of <app-name>.<environmentDefaultDomain>) -- this is what oidcRedirectUri
// is built from, and what deploy.sh prints as the exact Entra redirect URI to register.
var apiPublicBaseUrl = 'https://canvas-api.${containerAppsEnv.outputs.environmentDefaultDomain}'
var oidcRedirectUri = '${apiPublicBaseUrl}/auth/callback'

// canvas-6upe: Application Insights, the performance workbook and the p95 alert.
module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoringDeploy'
  scope: rg
  params: {
    location: location
    logAnalyticsWorkspaceId: containerAppsEnv.outputs.logAnalyticsWorkspaceId
    alertEmail: adminEmail
  }
}

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
    webOrigin: empty(webOrigin) ? apiPublicBaseUrl : webOrigin
    entraTenantId: entraTenantId
    entraClientId: entraClientId
    oidcRedirectUri: oidcRedirectUri
    aiProvider: aiProvider
    allowedIpRanges: allowedIpRanges
    authMode: authMode
    githubAppId: githubAppId
    githubApiUrl: githubApiUrl
    appInsightsConnectionString: monitoring.outputs.connectionString
    oidcClientAuth: oidcClientAuth
    identityClientId: keyVault.outputs.identityClientId
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

// canvas-ez1.3: the demo seed (published passwords) doesn't exist in a local-mode environment.
module seedJob 'modules/seedjob.bicep' = if (authMode != 'local') {
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

module bootstrapAdminJob 'modules/bootstrapadminjob.bicep' = if (authMode == 'local') {
  name: 'bootstrapAdminJobDeploy'
  scope: rg
  params: {
    location: location
    environmentId: containerAppsEnv.outputs.environmentId
    identityId: keyVault.outputs.identityId
    acrLoginServer: acr.outputs.loginServer
    apiImageTag: apiImageTag
    keyVaultUri: keyVault.outputs.keyVaultUri
    adminEmail: adminEmail
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

// canvas-ne2y: the nightly housekeeping purge (expired deletions, abandoned drafts).
module purgeJob 'modules/purgejob.bicep' = {
  name: 'purgeJobDeploy'
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

// canvas-3s5.2: only when a GitHub App is configured.
module githubSyncJob 'modules/githubsyncjob.bicep' = if (githubAppId != 'unset') {
  name: 'githubSyncJobDeploy'
  scope: rg
  params: {
    location: location
    environmentId: containerAppsEnv.outputs.environmentId
    identityId: keyVault.outputs.identityId
    acrLoginServer: acr.outputs.loginServer
    apiImageTag: apiImageTag
    keyVaultUri: keyVault.outputs.keyVaultUri
    githubAppId: githubAppId
    githubApiUrl: githubApiUrl
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
output seedJobName string = authMode == 'local' ? '' : seedJob!.outputs.jobName
output bootstrapAdminJobName string = authMode == 'local' ? bootstrapAdminJob!.outputs.jobName : ''
output catalogSeedJobName string = catalogSeedJob.outputs.jobName
output githubSyncJobName string = githubAppId != 'unset' ? githubSyncJob!.outputs.jobName : ''
