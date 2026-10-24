// API container app (canvas-ycu, mirrors ADP's infra/azure/modules/apiapp.bicep) -- the one
// component the public actually reaches. Managed identity gets Key Vault Secrets User AND AcrPull
// (both from modules/keyvault.bicep, which owns the identity itself) -- RBAC role assignments are
// scope-based and additive, so that one AcrPull grant already covers every container app using
// this same identity, this one included. This module used to declare its own separate
// (functionally redundant) AcrPull grant; removed after a real deploy failure
// (RoleAssignmentExists) proved that redeploying an already-existing role assignment resource is
// not reliably idempotent even when its principalId is provably unchanged -- one authoritative
// declaration avoids the whole class of conflict rather than trying to make a second one
// re-deploy cleanly. /health has no auth guard and is wired as the liveness/readiness probe
// (apps/api/src/app.ts).
//
// minReplicas=0: a Node/Fastify cold start is a couple of seconds, not disruptive, so
// scale-to-zero when idle is a real cost saving -- this app costs ~$0 while nothing is using it.

@description('Azure region.')
param location string

@description('Container Apps environment resource ID.')
param environmentId string

@description('User-assigned managed identity resource ID.')
param identityId string

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

@description('canvas-haz: this deployment authenticates via Microsoft Entra ID, so local email/password auth is no longer the only way to sign in -- defaults to false, requiring SSO + whatever Conditional Access/MFA policy the tenant enforces for this app. Kept as a param, not hardcoded, purely as an emergency break-glass switch (e.g. the Entra tenant itself is unreachable) -- flip it back to true only for that, never as a standing configuration, or MFA becomes silently bypassable.')
param allowLocalAuth bool = false

@description('canvas-ez1.1: AUTH_MODE -- "entra" (Entra ID sign-in) or "local" (Canvas-managed email + password accounts only; the OIDC_* values below are then ignored by the API). deploy.sh refuses "local" without an IP allow-list (docs/ip-allowlist-security-plan.md, option B).')
@allowed(['entra', 'local'])
param authMode string = 'entra'

@description('canvas-cng: the IP allow-list, as [{ cidr, description }]. When non-empty, ingress only accepts these ranges -- once one Allow rule exists, Container Apps denies all other traffic. Entra sign-in still applies on top (docs/ip-allowlist-security-plan.md, option A). deploy.sh supplies it from infra/azure/.secrets/allowed-ips and refuses an empty list unless CANVAS_ALLOW_PUBLIC=1.')
param allowedIpRanges array = []

@description('AI_PROVIDER value -- "mock" keeps AI chat on the deterministic fake NLU (no real API calls, no cost) until a real key is provided via Key Vault; switch to anthropic/openai once ANTHROPIC_API_KEY/OPENAI_API_KEY are set as real Key Vault secret values.')
param aiProvider string = 'mock'

@description('canvas-haz: Entra ID tenant ID this app authenticates against (RUNBOOK.md\'s "Entra ID SSO" section). OIDC_ISSUER_URL is derived from this plus the v2.0 endpoint suffix apps/api/src/config.ts\'s own validateOidcIssuerUrl() requires.')
param entraTenantId string

@description('canvas-haz: the "canvas-azure" Entra app registration\'s Application (client) ID.')
param entraClientId string

@description('This app\'s own OIDC callback URL: https://<this-api-fqdn>/auth/callback -- computed in main.bicep from this app\'s own predictable Container Apps FQDN (not knowable from within its own resource definition, hence computed one level up).')
param oidcRedirectUri string

@description('canvas-3s5.1: GITHUB_APP_ID -- the GitHub App diagrams are submitted for approval with; "unset" = off. The private key is the github-app-private-key Key Vault secret ("unset" until deploy.sh is given one).')
param githubAppId string = 'unset'

@description('canvas-3s5.1: GITHUB_APP_API_URL.')
param githubApiUrl string = 'https://api.github.com'

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
        ipSecurityRestrictions: [for (range, i) in allowedIpRanges: {
          name: 'allowed-ip-${i + 1}'
          description: range.description
          ipAddressRange: range.cidr
          action: 'Allow'
        }]
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
          // canvas-ez1.5: encrypts stored two-step-verification secrets (deploy.sh generates it).
          name: 'mfa-encryption-key'
          keyVaultUrl: '${keyVaultUri}secrets/mfa-encryption-key'
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
          // canvas-3s5.1: base64 of the GitHub App's PEM private key, or "unset".
          name: 'github-app-private-key'
          keyVaultUrl: '${keyVaultUri}secrets/github-app-private-key'
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
            { name: 'AUTH_MODE', value: authMode }
            // Split-origin deployment (frontend on Storage static website, API here) --
            // COOKIE_SAME_SITE=none requires COOKIE_SECURE=true, which config.ts already forces
            // automatically whenever SameSite=none is set, but both are passed explicitly for
            // clarity (docs/azure-deployment.md, RUNBOOK.md).
            { name: 'COOKIE_SECURE', value: 'true' }
            { name: 'COOKIE_SAME_SITE', value: 'none' }
            { name: 'WEB_ORIGINS', value: webOrigin }
            { name: 'AI_PROVIDER', value: aiProvider }
            // canvas-haz: Entra's issuer is always public -- no internal/public split, no reverse
            // proxy, no customFetch rewrite needed the way the self-hosted Keycloak this replaced
            // required. environment().authentication.loginEndpoint already ends in '/' (it's
            // 'https://login.microsoftonline.com/' in the public cloud, a different host entirely
            // in sovereign clouds like Azure Government/China) -- using it rather than hardcoding
            // the public-cloud hostname keeps this correct if this subscription is ever deployed
            // into one of those. The /v2.0 suffix is REQUIRED -- apps/api/src/config.ts's own
            // validateOidcIssuerUrl() fails fast at startup without it (a bare tenant path or the
            // v1 endpoint produces a different claims shape, e.g. no flat top-level `roles` claim).
            { name: 'OIDC_ISSUER_URL', value: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0' }
            { name: 'OIDC_CLIENT_ID', value: entraClientId }
            { name: 'OIDC_CLIENT_SECRET', secretRef: 'oidc-client-secret' }
            { name: 'OIDC_REDIRECT_URI', value: oidcRedirectUri }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'MFA_ENCRYPTION_KEY', secretRef: 'mfa-encryption-key' }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'OPENAI_API_KEY', secretRef: 'openai-api-key' }
            { name: 'GITHUB_APP_ID', value: githubAppId }
            { name: 'GITHUB_APP_PRIVATE_KEY', secretRef: 'github-app-private-key' }
            { name: 'GITHUB_APP_API_URL', value: githubApiUrl }
            // Links in pull requests point back at the web app.
            { name: 'CANVAS_PUBLIC_URL', value: webOrigin }
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
  // No explicit dependsOn for the AcrPull grant needed here (see this file's own header comment --
  // that grant lives in modules/keyvault.bicep): this module already consumes
  // keyVault.outputs.identityId/keyVaultUri (identityId/keyVaultUri params above), which gives
  // Bicep an implicit dependency on the keyVault module completing -- including its AcrPull role
  // assignment -- before this one deploys.
}

output fqdn string = apiApp.properties.configuration.ingress.fqdn
output name string = apiApp.name
