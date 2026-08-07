// Key Vault + user-assigned managed identity (canvas-ycu, mirrors ADP's infra/azure/modules/
// keyvault.bicep).
//
// RBAC-authorized (not legacy access policies) -- the identity gets the built-in "Key Vault
// Secrets User" role (read-only), and the deploying principal gets "Key Vault Secrets Officer" so
// this same deployment/script can write the actual secret values afterward. Purge protection is
// deliberately left off so destroy.sh can fully delete the vault immediately rather than leaving
// it in a soft-deleted, billable-adjacent state for the retention period -- acceptable for a
// non-prod/single environment where "easy to tear down" matters more than purge resistance.
//
// This module creates the vault + identity + role assignments only; the actual secret VALUES
// (DATABASE_URL, SESSION_SECRET, ANTHROPIC_API_KEY/OPENAI_API_KEY) are set imperatively by
// deploy.sh via `az keyvault secret set` after this deploys, so no secret value ever appears in
// a Bicep template or ARM deployment parameter.

@description('Azure region.')
param location string

@description('Key Vault name. Must be globally unique, 3-24 chars, alphanumeric + hyphens.')
param keyVaultName string = 'canvas-kv-${uniqueString(resourceGroup().id)}'

@description('User-assigned managed identity name -- attached to the API container app for Key Vault secret references and ACR pull.')
param identityName string = 'canvas-identity'

@description('Object ID of the principal running this deployment, granted Key Vault Secrets Officer so it can write secret values immediately after this deploys.')
param deployerPrincipalId string

var keyVaultSecretsUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var keyVaultSecretsOfficerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: identityName
  location: location
}

resource keyVault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    // enablePurgeProtection intentionally omitted (not set to false): Azure rejects an explicit
    // `false` since enabling it is a one-way switch -- omitting it leaves purge protection off,
    // letting destroy.sh fully delete the vault immediately.
    enableSoftDelete: true
  }
}

resource identitySecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, 'KeyVaultSecretsUser')
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource deployerSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, deployerPrincipalId, 'KeyVaultSecretsOfficer')
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsOfficerRoleId
    principalId: deployerPrincipalId
    principalType: 'User'
  }
}

output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output identityId string = identity.id
output identityPrincipalId string = identity.properties.principalId
output identityClientId string = identity.properties.clientId
