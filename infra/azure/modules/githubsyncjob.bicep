// canvas-3s5.2: scheduled Container Apps Job that syncs open GitHub pull requests Canvas opened
// (merged = approved, closed = rejected, open = review/check state) -- `node
// apps/api/dist/github/sync-run.js`. Polling rather than webhooks: the API's IP allow-list keeps
// GitHub's webhook deliveries out. Deployed only when a GitHub App is configured (main.bicep).
// pause.sh moves the schedule to once a year (the CLI can't suspend a scheduled job); resume.sh
// and deploy.sh put it back.

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

@description('GITHUB_APP_ID.')
param githubAppId string

@description('GITHUB_API_URL.')
param githubApiUrl string

@description('How often to sync (cron, UTC).')
param cronExpression string = '*/15 * * * *'

resource syncJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'canvas-github-sync'
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
      replicaTimeout: 600
      replicaRetryLimit: 0
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
        {
          name: 'github-app-private-key'
          keyVaultUrl: '${keyVaultUri}secrets/github-app-private-key'
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'github-sync'
          image: '${acrLoginServer}/canvas-api:${apiImageTag}'
          command: ['node']
          args: ['apps/api/dist/github/sync-run.js']
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            // Not used by the sync; loadConfig requires it.
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'GITHUB_APP_ID', value: githubAppId }
            { name: 'GITHUB_APP_PRIVATE_KEY', secretRef: 'github-app-private-key' }
            { name: 'GITHUB_API_URL', value: githubApiUrl }
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

output jobName string = syncJob.name
