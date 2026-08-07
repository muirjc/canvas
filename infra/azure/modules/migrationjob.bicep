// DB migration Container Apps Job (canvas-ycu, mirrors ADP's infra/azure/modules/
// migrationjob.bicep).
//
// Manual-trigger, one-off job running `node apps/api/dist/db/migrate.js` (apps/api/src/db/
// migrate.ts's compiled output -- a dependency-free numbered-.sql-file runner, see its own doc
// comment) against the same API image the app itself runs. Matches RUNBOOK.md's existing
// `npm run migrate --workspace=@canvas/api` pattern rather than running migrations on container
// boot.

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

resource migrationJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'canvas-migrate'
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
          name: 'migrate'
          image: '${acrLoginServer}/canvas-api:${apiImageTag}'
          command: ['node']
          args: ['apps/api/dist/db/migrate.js']
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            // migrate.ts's runMigrations() never reads SESSION_SECRET itself, but its own
            // getPool() -> config.ts's loadConfig() requires it to be set regardless (any
            // missing required env var throws before the pool is even created) -- verified live
            // against a real container run, not assumed.
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

output jobName string = migrationJob.name
