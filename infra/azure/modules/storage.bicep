// Storage account for the frontend static website (canvas-ycu). No ADP equivalent -- ADP builds
// its frontend into the SAME container as the API and serves it via FastAPI's StaticFiles mount
// (see its root Dockerfile), a same-origin architecture with no CORS/cookie complexity at all.
// canvas deliberately keeps its EXISTING split-origin topology instead (frontend and API on
// different hosts) -- docs/azure-deployment.md's COOKIE_SECURE/COOKIE_SAME_SITE=none path
// already implements and documents exactly this, tested and working; merging the two into one
// container would be a much larger, riskier change than this bead's own scope (see canvas-ycu's
// design notes on this trade-off).
//
// Static website hosting itself (the `$web` container + index/error document config) has no
// first-class ARM/Bicep resource -- it's a data-plane setting, not a control-plane one. This
// module provisions the storage account only; deploy.sh runs
// `az storage blob service-properties update --static-website` afterward, the same gap Key
// Vault secret VALUES have (provisioned by Bicep, populated by the script) for the same reason.

@description('Azure region.')
param location string

@description('Storage account name. Must be globally unique, lowercase alphanumeric only, 3-24 chars.')
param storageAccountName string = 'canvasweb${uniqueString(resourceGroup().id)}'

@description('Object ID of the principal running the deployment -- granted Storage Blob Data Contributor so deploy.sh\'s `az storage blob service-properties update --auth-mode login` and `upload-batch` calls actually work without falling back to an access-key. Same "deployer gets write access, mirrors keyvault.bicep\'s deployerSecretsOfficer pattern" shape -- docs/azure-deployment.md\'s own older manual path documents hitting exactly this permission gap and falling back to --auth-mode key, which this closes properly instead of carrying forward.')
param deployerPrincipalId string

var storageBlobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

resource storageAccount 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    allowBlobPublicAccess: true
    minimumTlsVersion: 'TLS1_2'
  }
}

resource deployerBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, deployerPrincipalId, 'StorageBlobDataContributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: deployerPrincipalId
    principalType: 'User'
  }
}

output storageAccountName string = storageAccount.name
// Deliberately NOT outputting the static website endpoint here (unlike ADP's
// keycloakPublicBaseUrl, which IS predictable ahead of time from the Container Apps
// environment's own stable default domain): a Storage static website's real hostname
// (https://<account>.z##.web.core.windows.net) includes an internal cluster-assignment segment
// Azure only allocates once static website hosting is actually enabled on the account (a
// data-plane operation, not this control-plane resource) -- it cannot be computed from the
// account name alone. deploy.sh looks it up via `az storage account show --query
// primaryEndpoints.web` AFTER enabling static website hosting and patches the API container
// app's WEB_ORIGINS with the real value as a second pass, the same two-pass shape
// keyvault.bicep's secret pre-seeding already needs for a different reason.
