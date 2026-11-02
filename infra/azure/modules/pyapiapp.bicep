// canvas-1bty.3: the Python backend (apps/api-py), moving here from canvas-api route group by route
// group (docs/python-backend-assessment.md). Internal ingress only: browsers never reach it directly.
// canvas-api stays the front door and forwards the route prefixes Python answers (PYTHON_ROUTES) to
// http://canvas-api-py inside the Container Apps environment. Same managed identity, secrets and
// database as canvas-api; both services read the same sessions (canvas-1bty.2), so the session
// secret and cookie settings must match canvas-api's.
//
// canvas-1bty.4: a second container, diagram-bridge, runs next to it (diagram-core over localhost).
//
// minReplicas=0 like canvas-api: it costs nothing while idle (cold starts accepted, canvas-aots).

@description('Azure region.')
param location string

@description('Container Apps environment resource ID.')
param environmentId string

@description('User-assigned managed identity resource ID.')
param identityId string

@description('ACR login server.')
param acrLoginServer string

@description('Tag of the canvas-api-py image (apps/api-py/Dockerfile), built and pushed by deploy.sh with the same tag as canvas-api.')
param imageTag string

@description('Key Vault URI (used to build secret references).')
param keyVaultUri string

@description('canvas-6upe: Application Insights connection string. Empty = telemetry off.')
param appInsightsConnectionString string = ''

@description('canvas-1bty.11: GITHUB_APP_ID, as canvas-api (modules/apiapp.bicep); "unset" = GitHub approval off. The private key is the github-app-private-key Key Vault secret.')
param githubAppId string = 'unset'

@description('canvas-1bty.11: GITHUB_APP_API_URL.')
param githubApiUrl string = 'https://api.github.com'

@description('canvas-1bty.11: the public URL Canvas is used at (CANVAS_PUBLIC_URL), for the links back to Canvas in pull requests.')
param publicUrl string

@description('canvas-1bty.12: AI_PROVIDER, as canvas-api (modules/apiapp.bicep): mock, anthropic or openai. The keys are the anthropic-api-key / openai-api-key Key Vault secrets.')
param aiProvider string = 'mock'

// canvas-1bty.13: sign-in moved here, so every sign-in setting must match canvas-api's
// (modules/apiapp.bicep): canvas-api only forwards a sign-in route it has registered itself.
@description('canvas-1bty.13: AUTH_MODE, as canvas-api: entra or local.')
param authMode string = 'entra'

@description('canvas-1bty.13: ALLOW_LOCAL_AUTH, as canvas-api.')
param allowLocalAuth bool = false

@description('canvas-1bty.13: Entra tenant id, as canvas-api.')
param entraTenantId string

@description('canvas-1bty.13: Entra app registration (client) id, as canvas-api.')
param entraClientId string

@description('canvas-1bty.13: the Entra redirect URI, as canvas-api (its public /auth/callback).')
param oidcRedirectUri string

@description('canvas-1bty.13: OIDC_CLIENT_AUTH, as canvas-api: secret or managed-identity.')
param oidcClientAuth string = 'secret'

@description('canvas-1bty.13: the managed identity\'s client id (AZURE_CLIENT_ID), for managed-identity sign-in.')
param identityClientId string = ''

@description('Port uvicorn listens on (apps/api-py/Dockerfile).')
param port int = 8000

resource pyApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'canvas-api-py'
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
        // Reachable only from inside the environment, as http://canvas-api-py.
        external: false
        targetPort: port
        transport: 'http'
        allowInsecure: true
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
          // canvas-1bty.13: sign-in, as canvas-api.
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
          name: 'api-py'
          image: '${acrLoginServer}/canvas-api-py:${imageTag}'
          env: [
            { name: 'DB_CLIENT', value: 'postgres' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            // Must match canvas-api (modules/apiapp.bicep): the Python service refreshes the same cookie.
            { name: 'COOKIE_SECURE', value: 'true' }
            { name: 'COOKIE_SAME_SITE', value: 'lax' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'OTEL_SERVICE_NAME', value: 'canvas-api-py' }
            // canvas-1bty.4: the diagram-core bridge, the sidecar below (same localhost).
            { name: 'DIAGRAM_BRIDGE_URL', value: 'http://127.0.0.1:7070' }
            // canvas-1bty.11: GitHub approval, as canvas-api.
            { name: 'GITHUB_APP_ID', value: githubAppId }
            { name: 'GITHUB_APP_PRIVATE_KEY', secretRef: 'github-app-private-key' }
            { name: 'GITHUB_APP_API_URL', value: githubApiUrl }
            { name: 'CANVAS_PUBLIC_URL', value: publicUrl }
            // canvas-1bty.12: AI chat, as canvas-api.
            { name: 'AI_PROVIDER', value: aiProvider }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'OPENAI_API_KEY', secretRef: 'openai-api-key' }
            // canvas-1bty.13: sign-in, as canvas-api (same lowercase 'true'/'false' as there).
            { name: 'AUTH_MODE', value: authMode }
            { name: 'ALLOW_LOCAL_AUTH', value: allowLocalAuth ? 'true' : 'false' }
            { name: 'WEB_ORIGINS', value: publicUrl }
            { name: 'OIDC_ISSUER_URL', value: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0' }
            { name: 'OIDC_CLIENT_ID', value: entraClientId }
            { name: 'OIDC_CLIENT_SECRET', secretRef: 'oidc-client-secret' }
            { name: 'OIDC_CLIENT_AUTH', value: oidcClientAuth }
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'OIDC_REDIRECT_URI', value: oidcRedirectUri }
            { name: 'MFA_ENCRYPTION_KEY', secretRef: 'mfa-encryption-key' }
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

output name string = pyApp.name
@description('What canvas-api forwards to (PYTHON_API_URL).')
output internalUrl string = 'http://${pyApp.name}'
