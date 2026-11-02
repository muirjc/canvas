// canvas-1bty.14: canvas-api, the one component the public reaches -- since phase 10 the Python backend
// (apps/api-py) with the diagram-core bridge as a sidecar. Same name, so the same address, IP allow-list
// and Entra redirect URI as when it ran the TypeScript API. It serves the web app (built into its image),
// the paused page (CANVAS_PAUSED, pause.sh/resume.sh), and every API route; a route group named in
// TYPESCRIPT_ROUTE_GROUPS (the one-release fallback) and /docs go to the internal TypeScript service,
// canvas-api-ts (modules/tsapiapp.bicep).
//
// The managed identity's AcrPull and Key Vault grants live in modules/keyvault.bicep. /health has no auth
// guard and is the liveness/readiness probe. minReplicas=0 (cold starts accepted, canvas-aots).

@description('Azure region.')
param location string

@description('Container Apps environment resource ID.')
param environmentId string

@description('User-assigned managed identity resource ID.')
param identityId string

@description('ACR login server.')
param acrLoginServer string

@description('Tag of the canvas-api-py image (apps/api-py/Dockerfile) and canvas-diagram-bridge, built and pushed by deploy.sh.')
param imageTag string

@description('Key Vault URI (used to build secret references).')
param keyVaultUri string

@description('canvas-6upe: Application Insights connection string. Empty = telemetry off.')
param appInsightsConnectionString string = ''

@description('canvas-1bty.11: GITHUB_APP_ID; "unset" = GitHub approval off. The private key is the github-app-private-key Key Vault secret.')
param githubAppId string = 'unset'

@description('canvas-1bty.11: GITHUB_APP_API_URL.')
param githubApiUrl string = 'https://api.github.com'

@description('The public URL Canvas is used at -- this app\'s own URL, since it serves the web app. Becomes WEB_ORIGINS and CANVAS_PUBLIC_URL.')
param webOrigin string

@description('canvas-1bty.12: AI_PROVIDER: mock, anthropic or openai. The keys are the anthropic-api-key / openai-api-key Key Vault secrets.')
param aiProvider string = 'mock'

@description('canvas-1bty.13: AUTH_MODE: entra or local.')
param authMode string = 'entra'

@description('canvas-1bty.13: ALLOW_LOCAL_AUTH.')
param allowLocalAuth bool = false

@description('canvas-1bty.13: Entra tenant id.')
param entraTenantId string

@description('canvas-1bty.13: Entra app registration (client) id.')
param entraClientId string

@description('canvas-1bty.13: the Entra redirect URI (this app\'s public /auth/callback).')
param oidcRedirectUri string

@description('canvas-1bty.13: OIDC_CLIENT_AUTH: secret or managed-identity.')
param oidcClientAuth string = 'secret'

@description('canvas-1bty.13: the managed identity\'s client id (AZURE_CLIENT_ID), for managed-identity sign-in.')
param identityClientId string = ''

@description('canvas-cng: the IP allow-list, as [{ cidr, description }]. When non-empty, ingress only accepts these ranges -- once one Allow rule exists, Container Apps denies all other traffic. deploy.sh supplies it from infra/azure/.secrets/allowed-ips and refuses an empty list unless CANVAS_ALLOW_PUBLIC=1.')
param allowedIpRanges array = []

@description('canvas-1bty.14: the internal TypeScript service (TYPESCRIPT_API_URL); empty = none.')
param typescriptApiUrl string = ''

@description('canvas-1bty.14: route groups sent back to TypeScript (TYPESCRIPT_ROUTE_GROUPS): empty or "none" = none.')
param typescriptRouteGroups string = ''

@description('Port uvicorn listens on (apps/api-py/Dockerfile).')
param port int = 8000

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
        targetPort: port
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
          // canvas-1bty.12: the AI provider keys ("unset" until deploy.sh is given one).
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
          // canvas-1bty.13: sign-in.
          name: 'mfa-encryption-key'
          keyVaultUrl: '${keyVaultUri}secrets/mfa-encryption-key'
          identity: identityId
        }
        {
          name: 'oidc-client-secret'
          keyVaultUrl: '${keyVaultUri}secrets/oidc-client-secret'
          identity: identityId
        }
        {
          // canvas-1bty.11: base64 of the GitHub App's PEM private key, or "unset".
          name: 'github-app-private-key'
          keyVaultUrl: '${keyVaultUri}secrets/github-app-private-key'
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          // 'api' and first: pause.sh/resume.sh set CANVAS_PAUSED on this container.
          name: 'api'
          image: '${acrLoginServer}/canvas-api-py:${imageTag}'
          env: [
            { name: 'DB_CLIENT', value: 'postgres' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'COOKIE_SECURE', value: 'true' }
            { name: 'COOKIE_SAME_SITE', value: 'lax' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'OTEL_SERVICE_NAME', value: 'canvas-api' }
            // canvas-1bty.4: the diagram-core bridge, the sidecar below (same localhost).
            { name: 'DIAGRAM_BRIDGE_URL', value: 'http://127.0.0.1:7070' }
            // canvas-1bty.11: GitHub approval.
            { name: 'GITHUB_APP_ID', value: githubAppId }
            { name: 'GITHUB_APP_PRIVATE_KEY', secretRef: 'github-app-private-key' }
            { name: 'GITHUB_APP_API_URL', value: githubApiUrl }
            { name: 'CANVAS_PUBLIC_URL', value: webOrigin }
            // canvas-1bty.12: AI chat.
            { name: 'AI_PROVIDER', value: aiProvider }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'OPENAI_API_KEY', secretRef: 'openai-api-key' }
            // canvas-1bty.13: sign-in (lowercase 'true'/'false': the settings compare exactly).
            { name: 'AUTH_MODE', value: authMode }
            { name: 'ALLOW_LOCAL_AUTH', value: allowLocalAuth ? 'true' : 'false' }
            { name: 'WEB_ORIGINS', value: webOrigin }
            { name: 'OIDC_ISSUER_URL', value: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0' }
            { name: 'OIDC_CLIENT_ID', value: entraClientId }
            { name: 'OIDC_CLIENT_SECRET', secretRef: 'oidc-client-secret' }
            { name: 'OIDC_CLIENT_AUTH', value: oidcClientAuth }
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'OIDC_REDIRECT_URI', value: oidcRedirectUri }
            { name: 'MFA_ENCRYPTION_KEY', secretRef: 'mfa-encryption-key' }
            // canvas-1bty.14: the fallback to the internal TypeScript service (modules/tsapiapp.bicep).
            { name: 'TYPESCRIPT_API_URL', value: typescriptApiUrl }
            { name: 'TYPESCRIPT_ROUTE_GROUPS', value: typescriptRouteGroups }
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
                port: port
              }
              initialDelaySeconds: 5
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: port
              }
              initialDelaySeconds: 3
              periodSeconds: 10
            }
          ]
        }
        {
          // canvas-1bty.4: diagram-core (TypeScript) for the Python service until it is ported
          // (packages/diagram-bridge). Shares the app's network: listens on 127.0.0.1 only, so
          // nothing outside this replica can reach it.
          name: 'diagram-bridge'
          image: '${acrLoginServer}/canvas-diagram-bridge:${imageTag}'
          env: [
            { name: 'BRIDGE_HOST', value: '127.0.0.1' }
            { name: 'BRIDGE_PORT', value: '7070' }
          ]
          // 0.5 + 0.25 CPU / 1 + 0.5 Gi: a valid Container Apps combination (0.75 / 1.5Gi).
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
  }
}

output fqdn string = apiApp.properties.configuration.ingress.fqdn
output name string = apiApp.name
