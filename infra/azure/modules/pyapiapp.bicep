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
