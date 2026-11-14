// Mermaid syntax dry run Container Apps Job (canvas-dfam).
//
// Manual-trigger, read-only job running `python -m canvas_api.jobs.syntax_report --numbered` against the Azure
// database, which is private to the VNet (so the report can't run from a laptop). Run it with the NEW image before
// releasing a change to the Mermaid syntax Canvas reads or writes: infra/azure/syntax-report.sh points the job at an
// image, starts it and prints the report (docs/admin-guide/operations.md, "Moving to a newer Mermaid version").
// Exit status 1 = some diagram can't be opened by that build. deploy.sh keeps the job on the app's image.

@description('Azure region.')
param location string

@description('Container Apps environment resource ID.')
param environmentId string

@description('User-assigned managed identity resource ID.')
param identityId string

@description('ACR login server.')
param acrLoginServer string

@description('Tag of the canvas-api-py image -- the app\'s, until syntax-report.sh points the job at a newer one.')
param apiImageTag string

@description('Key Vault URI.')
param keyVaultUri string

resource syntaxReportJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'canvas-syntax-report'
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
      replicaTimeout: 1800
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
          name: 'syntax-report'
          image: '${acrLoginServer}/canvas-api-py:${apiImageTag}'
          command: ['python']
          args: ['-m', 'canvas_api.jobs.syntax_report', '--numbered']
          env: [
            { name: 'DB_CLIENT', value: 'postgres' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            // Not used by the report; Settings requires it.
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

output jobName string = syntaxReportJob.name
