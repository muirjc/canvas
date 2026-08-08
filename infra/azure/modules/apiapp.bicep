// API container app (canvas-ycu, mirrors ADP's infra/azure/modules/apiapp.bicep) -- the one
// component the public actually reaches. External ingress; managed identity gets AcrPull
// (granted here, since this is the only/first consumer -- ADP granted it in its Keycloak module
// instead, only because that happened to deploy first there) and Key Vault Secrets User
// (modules/keyvault.bicep). /health has no auth guard and is wired as the liveness/readiness
// probe (apps/api/src/app.ts).
//
// minReplicas=0: a Node/Fastify cold start is a couple of seconds, not disruptive, so
// scale-to-zero when idle is a real cost saving -- this app costs ~$0 while nothing is using it.

@description('Azure region.')
param location string

@description('Container Apps environment resource ID.')
param environmentId string

@description('User-assigned managed identity resource ID.')
param identityId string

@description('ACR resource ID -- the identity is granted AcrPull on this scope.')
param acrId string

@description('ACR login server.')
param acrLoginServer string

@description('Tag of the API image (repo-root Dockerfile), already built+pushed to ACR by deploy.sh before this runs.')
param apiImageTag string

@description('Key Vault URI (used to build secret references).')
param keyVaultUri string

@description('Public URL the frontend (Storage static website) is served from -- becomes WEB_ORIGINS, the one origin allowed to make credentialed requests (apps/api/src/app.ts CORS config).')
param webOrigin string

@description('Port the API listens on inside the container (matches apps/api/src/config.ts PORT).')
param apiPort int = 3000

@description('canvas-ycu.1: Keycloak is now deployed alongside this app (modules/keycloak.bicep), so local email/password auth is no longer the only way to sign in -- defaults to false, requiring SSO + MFA for this deployment. Kept as a param, not hardcoded, purely as an emergency break-glass switch (e.g. Keycloak itself is unreachable) -- flip it back to true only for that, never as a standing configuration, or MFA becomes silently bypassable.')
param allowLocalAuth bool = false

@description('AI_PROVIDER value -- "mock" keeps AI chat on the deterministic fake NLU (no real API calls, no cost) until a real key is provided via Key Vault; switch to anthropic/openai once ANTHROPIC_API_KEY/OPENAI_API_KEY are set as real Key Vault secret values.')
param aiProvider string = 'mock'

@description('canvas-ycu.1: Keycloak container app FQDN (internal-only) from modules/keycloak.bicep -- canvas-api proxies /idp/* to this (apps/api/src/auth/idp-proxy.routes.ts).')
param keycloakFqdn string

@description('Public base URL the browser reaches Keycloak through: https://<this-api-fqdn>/idp. Keycloak is configured (KC_HOSTNAME, modules/keycloak.bicep) to believe this is its own address, so its issuer claim and generated URLs already match this exactly.')
param keycloakPublicBaseUrl string

@description('This app\'s own OIDC callback URL: https://<this-api-fqdn>/auth/callback -- computed in main.bicep from the same stable base keycloakPublicBaseUrl is derived from (this app\'s own FQDN isn\'t knowable from within its own resource definition), rather than string-manipulated out of keycloakPublicBaseUrl here.')
param oidcRedirectUri string

@description('Keycloak realm name -- must match infra/keycloak/CanvasRealm-realm.json\'s own "realm" field.')
param keycloakRealm string = 'CanvasRealm'

@description('Keycloak client ID -- must match the confidential client baked into the realm export.')
param keycloakClientId string = 'canvas-api'

var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acrId, identityId, 'AcrPull')
  scope: resourceGroup()
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: reference(identityId, '2024-11-30', 'Full').properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource apiApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'canvas-api'
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
        external: true
        targetPort: apiPort
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
          name: 'database-url'
          keyVaultUrl: '${keyVaultUri}secrets/database-url'
          identity: identityId
        }
        {
          name: 'session-secret'
          keyVaultUrl: '${keyVaultUri}secrets/session-secret'
          identity: identityId
        }
        {
          name: 'anthropic-api-key'
          keyVaultUrl: '${keyVaultUri}secrets/anthropic-api-key'
          identity: identityId
        }
        {
          name: 'openai-api-key'
          keyVaultUrl: '${keyVaultUri}secrets/openai-api-key'
          identity: identityId
        }
        {
          name: 'oidc-client-secret'
          keyVaultUrl: '${keyVaultUri}secrets/oidc-client-secret'
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: '${acrLoginServer}/canvas-api:${apiImageTag}'
          env: [
            { name: 'PORT', value: string(apiPort) }
            // NOT string(allowLocalAuth) -- Bicep/ARM's string() on a bool produces "True"/
            // "False" (capitalized), but apps/api/src/config.ts checks
            // `env.ALLOW_LOCAL_AUTH === 'true'` as an exact lowercase string match. string(true)
            // would silently evaluate to false with no error anywhere -- caught via `az
            // deployment sub what-if`'s actual rendered output, not by inspection alone.
            { name: 'ALLOW_LOCAL_AUTH', value: allowLocalAuth ? 'true' : 'false' }
            // Split-origin deployment (frontend on Storage static website, API here) --
            // COOKIE_SAME_SITE=none requires COOKIE_SECURE=true, which config.ts already forces
            // automatically whenever SameSite=none is set, but both are passed explicitly for
            // clarity (docs/azure-deployment.md, RUNBOOK.md).
            { name: 'COOKIE_SECURE', value: 'true' }
            { name: 'COOKIE_SAME_SITE', value: 'none' }
            { name: 'WEB_ORIGINS', value: webOrigin }
            { name: 'AI_PROVIDER', value: aiProvider }
            // canvas-ycu.1: OIDC_ISSUER_URL is the PUBLIC address (matches Keycloak's own KC_
            // HOSTNAME-reported issuer claim, and is what the browser is redirected to). The
            // API calling that same public address for its own server-side discovery/token/
            // userinfo calls does not reliably route back to itself within Container Apps'
            // network (confirmed: the request can't even succeed before this process itself has
            // started listening, an ordering problem independent of Container Apps specifics,
            // not just an optimization) -- OIDC_INTERNAL_ISSUER_URL redirects those specific
            // calls straight to Keycloak's own internal FQDN instead (oidc.ts's customFetch
            // override), while KEYCLOAK_INTERNAL_URL is the separate target the /idp/* reverse
            // proxy itself forwards browser-facing requests to.
            { name: 'OIDC_ISSUER_URL', value: '${keycloakPublicBaseUrl}/realms/${keycloakRealm}' }
            { name: 'OIDC_INTERNAL_ISSUER_URL', value: 'https://${keycloakFqdn}/idp/realms/${keycloakRealm}' }
            { name: 'KEYCLOAK_INTERNAL_URL', value: 'https://${keycloakFqdn}' }
            { name: 'OIDC_CLIENT_ID', value: keycloakClientId }
            { name: 'OIDC_CLIENT_SECRET', secretRef: 'oidc-client-secret' }
            { name: 'OIDC_REDIRECT_URI', value: oidcRedirectUri }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'OPENAI_API_KEY', secretRef: 'openai-api-key' }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: apiPort
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: apiPort
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    acrPullAssignment
  ]
}

output fqdn string = apiApp.properties.configuration.ingress.fqdn
output name string = apiApp.name
