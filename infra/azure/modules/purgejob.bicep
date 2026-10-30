// canvas-ne2y: scheduled Container Apps Job that runs the housekeeping purge nightly -- `node
// apps/api/dist/purge/run.js`. It physically removes diagrams and projects deleted more than 30
// days ago (past the admin's Restore window) and unsaved drafts (Create with AI, Import, templates)
// abandoned for more than 24 hours. pause.sh moves the schedule to once a year (the CLI can't
// suspend a scheduled job); resume.sh and deploy.sh put it back.

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

@description('When to purge (cron, UTC). Nightly at 03:00 UTC.')
param cronExpression string = '0 3 * * *'

resource purgeJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'canvas-purge'
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
      triggerType: 'Schedule'
      replicaTimeout: 900
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: cronExpression
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
          name: 'purge'
          image: '${acrLoginServer}/canvas-api:${apiImageTag}'
          command: ['node']
          args: ['apps/api/dist/purge/run.js']
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            // Not used by the purge; loadConfig requires it.
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}

output jobName string = purgeJob.name
