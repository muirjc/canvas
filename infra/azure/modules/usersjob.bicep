// Real Keycloak user-provisioning Container Apps Job (canvas-ycu.1's decided
// user-provisioning approach -- mirrors ADP's own dedicated `adp-keycloak-admin` job, which
// runs its keycloak_create_users.py the same way: manually triggered, VNet-internal, overriding
// --command on the shared API image rather than a bespoke ops image).
//
// Runs infra/keycloak/create-users.mjs (baked into the same canvas-api image via the repo-root
// Dockerfile's own COPY -- a small, static ops script, not worth a second image) against
// Keycloak's INTERNAL FQDN directly -- this job runs inside the Container Apps environment's own
// VNet alongside Keycloak, so unlike a real browser it doesn't need the /idp reverse-proxy at
// all, just Keycloak's own --http-relative-path=/idp prefix on the internal address.
//
// KC_USERS (the actual username/email/password/role list) is deliberately NOT a template param
// or a static Key Vault secret -- it's real user data, supplied per-invocation via
// `az containerapp job start --env-vars KC_USERS='...'` (see infra/azure/README.md), the same
// way ADP's own script takes it, so no real account's password/email is baked into this template
// or state file.
@description('Azure region.')
param location string

@description('Container Apps environment resource ID.')
param environmentId string

@description('User-assigned managed identity resource ID.')
param identityId string

@description('ACR login server.')
param acrLoginServer string

@description('Tag of the API image -- the same image the API app runs; only the command differs (mirrors migrationjob.bicep/seedjob.bicep).')
param apiImageTag string

@description('Key Vault URI.')
param keyVaultUri string

@description('Keycloak container app FQDN (internal-only) from modules/keycloak.bicep.')
param keycloakFqdn string

@description('Keycloak realm name -- must match infra/keycloak/CanvasRealm-realm.json.')
param keycloakRealm string = 'CanvasRealm'

resource usersJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'canvas-keycloak-users'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 300
      replicaRetryLimit: 0
      manualTriggerConfig: {
        replicaCompletionCount: 1
        parallelism: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'keycloak-admin-password'
          keyVaultUrl: '${keyVaultUri}secrets/keycloak-admin-password'
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'keycloak-users'
          image: '${acrLoginServer}/canvas-api:${apiImageTag}'
          command: ['node']
          args: ['infra/keycloak/create-users.mjs']
          env: [
            { name: 'KEYCLOAK_URL', value: 'https://${keycloakFqdn}/idp' }
            { name: 'KEYCLOAK_REALM', value: keycloakRealm }
            { name: 'KEYCLOAK_ADMIN_USERNAME', value: 'admin' }
            { name: 'KEYCLOAK_ADMIN_PASSWORD', secretRef: 'keycloak-admin-password' }
            // KC_USERS intentionally absent -- see header comment; supplied per-invocation by
            // `az containerapp job start --env-vars KC_USERS='...'`.
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}

output jobName string = usersJob.name
