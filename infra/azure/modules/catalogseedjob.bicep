// Reference/lookup-data Container Apps Job (canvas-??? -- the gap found when a clean build of
// this environment left the DiagramType catalog, bundled icon/shape libraries, and default
// AiPersonas entirely unpopulated: nothing in deploy.sh's default flow ever ran
// the catalog seed (now `python -m canvas_api.jobs.seed_catalog`, canvas-1bty.16), so a fresh database couldn't even create a diagram).
//
// Unlike modules/seedjob.bicep (canvas-seed, dev/demo data including a published-password admin
// account -- deliberately left manual-trigger-only), this job's data is pure idempotent catalog
// content with no credentials or demo content in it, so deploy.sh runs it automatically on every
// deploy, right after migrations.

@description('Azure region.')
param location string

@description('Container Apps environment resource ID.')
param environmentId string

@description('User-assigned managed identity resource ID.')
param identityId string

@description('ACR login server.')
param acrLoginServer string

@description('Tag of the canvas-api-py image -- the same image the Python service runs; only the command differs.')
param apiImageTag string

@description('Key Vault URI.')
param keyVaultUri string

resource catalogSeedJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'canvas-seed-catalog'
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
      replicaTimeout: 600
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
          name: 'seed-catalog'
          image: '${acrLoginServer}/canvas-api-py:${apiImageTag}'
          command: ['python']
          args: ['-m', 'canvas_api.jobs.seed_catalog']
          env: [
            { name: 'DB_CLIENT', value: 'postgres' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            // Not used by the seed; Settings requires it.
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
    }
  }
}

output jobName string = catalogSeedJob.name
