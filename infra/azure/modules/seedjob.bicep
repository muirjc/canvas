// Optional dev/demo seed Container Apps Job (canvas-ycu). Runs
// `node apps/api/dist/seed/run.js` -- migrations, the full DiagramType catalog, bundled icon/
// shape libraries, one default project, and one admin user with local-auth credentials (see
// apps/api/src/seed/run.ts's own doc comment). A Job, not `az containerapp exec`, because the
// API app's minReplicas=0 (apiapp.bicep) means there may be no running replica to exec into --
// deploy.sh triggers this instead, which spins up its own one-shot replica regardless.
//
// NOT wired into deploy.sh's default flow unconditionally -- seeds a demo admin account with a
// published local password (apps/api/src/seed/run.ts), which is fine for a throwaway/demo
// environment but not something a real deployment should run unprompted. deploy.sh prints the
// trigger command rather than running it automatically.

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

resource seedJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'canvas-seed'
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
          name: 'seed'
          image: '${acrLoginServer}/canvas-api:${apiImageTag}'
          command: ['node']
          args: ['apps/api/dist/seed/run.js']
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            // seed.ts's local-auth admin user needs ALLOW_LOCAL_AUTH=true to actually be usable
            // afterward -- matches apiapp.bicep's own default, not hardcoded independently here.
            { name: 'ALLOW_LOCAL_AUTH', value: 'true' }
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

output jobName string = seedJob.name
