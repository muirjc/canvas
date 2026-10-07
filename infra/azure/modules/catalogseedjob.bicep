// Reference/lookup-data Container Apps Job (canvas-??? -- the gap found when a clean build of
// this environment left the DiagramType catalog, bundled icon/shape libraries, and default
// AiPersonas entirely unpopulated: nothing in deploy.sh's default flow ever ran
// apps/api/src/seed/catalog.ts's data, so a fresh database couldn't even create a diagram).
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

@description('Tag of the API image -- the same image the API app runs; only the command differs.')
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
          image: '${acrLoginServer}/canvas-api:${apiImageTag}'
          command: ['node']
          args: ['apps/api/dist/seed/catalog.js']
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            // seed/catalog.ts's runMigrations() -> config.ts's loadConfig() requires this to be
            // set regardless, same as migrationjob.bicep's own identical comment explains.
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
