// canvas Azure deployment -- entry point (canvas-ycu, mirrors ADP's infra/azure/main.bicep).
//
// Subscription-scope: creates the resource group everything else deploys into, then hands off to
// per-resource modules scoped to it. The whole environment builds from this one file and tears
// down as one resource group (destroy.sh) -- see infra/azure/README.md for the full operational
// picture (deploy/pause/resume/destroy).
//
// Deliberately does NOT include a Keycloak module -- canvas-mi9 (Keycloak/MFA integration) is
// separate, follow-on work. If/when it lands, it should add its own module here (mirroring
// ADP's modules/keycloak.bicep + the /auth reverse-proxy pattern) rather than standing up a
// second, disconnected resource group.

targetScope = 'subscription'

@description('Azure region for all resources. Kept fully parameterized, not hardcoded -- this environment has hit real compute-quota restrictions in some regions (docs/azure-deployment.md), eastus2/westus2/centralus/westus3 are known to work.')
param location string = 'eastus2'

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

@description('Public URL the frontend is served from (WEB_ORIGINS). Empty on a from-scratch first deploy -- deploy.sh patches the real Storage static website URL in as a second pass once storage.bicep has actually created the account and static website hosting has been enabled on it (see storage.bicep\'s own comment for why this can\'t be known ahead of time the way ADP\'s Keycloak public URL is).')
param webOrigin string = ''

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

module apiApp 'modules/apiapp.bicep' = {
  name: 'apiAppDeploy'
  scope: rg
  params: {
    location: location
    environmentId: containerAppsEnv.outputs.environmentId
    identityId: keyVault.outputs.identityId
    acrId: acr.outputs.acrId
    acrLoginServer: acr.outputs.loginServer
    apiImageTag: apiImageTag
    keyVaultUri: keyVault.outputs.keyVaultUri
    webOrigin: webOrigin
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
output migrationJobName string = migrationJob.outputs.jobName
output seedJobName string = seedJob.outputs.jobName
