// DB migration Container Apps Job (canvas-ycu, mirrors ADP's infra/azure/modules/
// migrationjob.bicep).
//
// Manual-trigger, one-off job running `python -m canvas_api.jobs.migrate` (a dependency-free
// numbered-.sql-file runner, canvas_api/migrations.py) in the same canvas-api-py image the app
// runs, rather than running migrations on container boot. The .sql files are apps/api-py/migrations.

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
          image: '${acrLoginServer}/canvas-api-py:${apiImageTag}'
          command: ['python']
          args: ['-m', 'canvas_api.jobs.migrate']
          env: [
            { name: 'DB_CLIENT', value: 'postgres' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            // Not used by the migration; Settings requires it.
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
