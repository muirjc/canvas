// Keycloak container app (canvas-ycu.1, mirrors ADP's infra/azure/modules/keycloak.bicep) --
// internal-only ingress, never exposed publicly. Backed by its own `keycloak` database on the
// shared Flexible Server (modules/postgres.bicep). Auto-provisions the CanvasRealm realm at
// startup via `start --import-realm` against infra/keycloak/CanvasRealm-realm.json, baked into a
// custom image (infra/keycloak/Dockerfile) built to ACR by deploy.sh.
//
// This is also the first consumer of the shared identity for ACR image pulls, so this module
// grants it the AcrPull role -- apiapp.bicep's own AcrPull grant (added when canvas-ycu shipped,
// before this module existed) is now redundant with this one but left in place rather than
// removed, since role assignments are idempotent on the identity+scope pair and removing it adds
// risk for no benefit.

@description('Azure region.')
param location string

@description('Container Apps environment resource ID from modules/containerappsenv.bicep.')
param environmentId string

@description('User-assigned managed identity resource ID from modules/keyvault.bicep.')
param identityId string

@description('ACR resource ID -- the identity is granted AcrPull on this scope.')
param acrId string

@description('ACR login server (e.g. foo.azurecr.io).')
param acrLoginServer string

@description('Tag of the custom Keycloak image (infra/keycloak/Dockerfile) already pushed to ACR.')
param keycloakImageTag string = 'latest'

@description('Key Vault URI from modules/keyvault.bicep (used to build secret references).')
param keyVaultUri string

@description('Postgres Flexible Server FQDN from modules/postgres.bicep.')
param postgresFqdn string

@description('Name of the Keycloak database on the Flexible Server.')
param keycloakDatabaseName string = 'keycloak'

@description('Postgres admin username -- Keycloak connects with the same single admin login as the app (canvas-ycu\'s own simplification, see postgres.bicep\'s comment).')
param postgresAdminUsername string = 'canvas_admin'

@description('Public base URL the browser reaches Keycloak through, e.g. https://canvas-api.<domain>/idp (canvas-ycu.1). Keycloak has internal-only ingress -- a real browser can never reach it directly, so canvas-api reverse-proxies /idp/* to it (apps/api/src/auth/idp-proxy.routes.ts). KC_HOSTNAME tells Keycloak this is its own address so it emits correct absolute URLs/issuer claims itself, rather than leaking its internal FQDN.')
param keycloakPublicBaseUrl string

resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acrId, identityId, 'AcrPull', 'keycloak')
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: reference(identityId, '2024-11-30', 'Full').properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource keycloakApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'canvas-keycloak'
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
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'postgres-admin-password'
          keyVaultUrl: '${keyVaultUri}secrets/postgres-admin-password'
          identity: identityId
        }
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
          name: 'keycloak'
          image: '${acrLoginServer}/canvas-keycloak:${keycloakImageTag}'
          args: [
            'start'
            '--http-enabled=true'
            '--hostname-strict=false'
            '--import-realm'
            // Single-replica deployment (minReplicas=maxReplicas=1 below) -- Keycloak's default
            // Infinispan/JGroups clustering (JDBC_PING discovery via the shared Postgres DB) has
            // no peer to find and otherwise loops retrying JOIN attempts against stale entries
            // from prior restarts, causing startup instability. --cache=local is Keycloak's
            // documented setting for exactly this case (the same fix a sibling project needed
            // for the identical topology).
            '--cache=local'
            // Container Apps ingress terminates TLS and forwards internally over plain HTTP with
            // X-Forwarded-Proto -- without this flag Keycloak doesn't trust that header, so it
            // sees every request (even ones that were HTTPS at the edge) as plain HTTP, tripping
            // the built-in master realm's default sslRequired=external policy (HTTPS required
            // for anything not a recognized private IP) with a 403 "HTTPS required" on the
            // admin-cli token request. The realm-JSON import only sets sslRequired=none on the
            // custom CanvasRealm, not the built-in master realm, so this is the correct fix --
            // trust the proxy, don't weaken master's policy.
            '--proxy-headers=xforwarded'
            // Serve everything under /idp so paths line up 1:1 with canvas-api's transparent
            // reverse proxy at /idp/* (no rewriting needed on either side, apps/api/src/auth/
            // idp-proxy.routes.ts). Paired with --hostname below so Keycloak's own issuer/
            // redirect/resource URLs are all correct through the proxy.
            '--http-relative-path=/idp'
            '--hostname=${keycloakPublicBaseUrl}'
          ]
          env: [
            { name: 'KC_DB', value: 'postgres' }
            { name: 'KC_DB_URL', value: 'jdbc:postgresql://${postgresFqdn}:5432/${keycloakDatabaseName}' }
            { name: 'KC_DB_USERNAME', value: postgresAdminUsername }
            { name: 'KC_DB_PASSWORD', secretRef: 'postgres-admin-password' }
            // Both env var forms set: Keycloak renamed the bootstrap-admin vars around the 26.x
            // line and this pins to 26.2 without having verified the exact cutover -- harmless
            // if one pair is simply ignored by the image actually running.
            { name: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: 'admin' }
            { name: 'KC_BOOTSTRAP_ADMIN_PASSWORD', secretRef: 'keycloak-admin-password' }
            { name: 'KEYCLOAK_ADMIN', value: 'admin' }
            { name: 'KEYCLOAK_ADMIN_PASSWORD', secretRef: 'keycloak-admin-password' }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    acrPullAssignment
  ]
}

output fqdn string = keycloakApp.properties.configuration.ingress.fqdn
output name string = keycloakApp.name
