// canvas-6upe: API performance telemetry. Application Insights (workspace-based, on canvas-logs)
// receives the API's OpenTelemetry traces and metrics (apps/api/src/telemetry/register.ts). A
// workbook shows per-route timings, slowest queries and AI calls over time; an hourly alert emails
// the admin when a key route's p95 goes over budget. Pay-per-GB ingestion; nothing is sent while
// the environment is paused.

@description('Azure region.')
param location string

@description('Resource ID of the Log Analytics workspace (canvas-logs).')
param logAnalyticsWorkspaceId string

@description('Where performance alerts are emailed. Empty = no alert email (the workbook still works).')
param alertEmail string = ''

@description('Budget for the key routes: p95 over an hour, in milliseconds.')
param keyRouteP95BudgetMs int = 2000

@description('Budget for an AI chat turn (model time included): p95 over an hour, in milliseconds.')
param aiChatP95BudgetMs int = 30000

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'canvas-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalyticsWorkspaceId
    IngestionMode: 'LogAnalytics'
    RetentionInDays: 90
    DisableLocalAuth: false
  }
}

// Key paths: open a diagram, save, export, AI chat, the project list.
var keyRoutes = '"GET /diagrams/:id", "PATCH /diagrams/:id", "GET /diagrams/:id/export", "GET /projects", "POST /diagrams/:id/chat/messages"'
var aiRoute = 'POST /diagrams/:id/chat/messages'

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (!empty(alertEmail)) {
  name: 'canvas-perf-alerts'
  location: 'global'
  properties: {
    groupShortName: 'canvasperf'
    enabled: true
    emailReceivers: [
      {
        name: 'admin'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

resource keyRouteAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (!empty(alertEmail)) {
  name: 'canvas-key-route-p95'
  location: location
  properties: {
    displayName: 'Canvas: a key route is slower than its budget'
    description: 'p95 over the last hour of open diagram / save / export / project list > ${keyRouteP95BudgetMs} ms, or AI chat > ${aiChatP95BudgetMs} ms (at least 5 requests).'
    severity: 3
    enabled: true
    scopes: [appInsights.id]
    evaluationFrequency: 'PT1H'
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: 'requests | where name in (${keyRoutes}) | summarize p95 = percentile(duration, 95), n = count() by name | where n >= 5 and ((name == "${aiRoute}" and p95 > ${aiChatP95BudgetMs}) or (name != "${aiRoute}" and p95 > ${keyRouteP95BudgetMs}))'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

var workbookContent = {
  version: 'Notebook/1.0'
  items: [
    {
      type: 1
      content: {
        json: '## Canvas performance\nPer-route timings from the API\'s traces (milliseconds). Budgets: key routes p95 < ${keyRouteP95BudgetMs} ms, AI chat < ${aiChatP95BudgetMs} ms. Requests over 3 s are mostly cold starts (the API scales to zero when idle).'
      }
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        title: 'Routes, last 24 hours (slowest p95 first)'
        query: 'requests | where timestamp > ago(24h) | summarize requests = count(), p50 = round(percentile(duration, 50)), p95 = round(percentile(duration, 95)), p99 = round(percentile(duration, 99)), failed = countif(success == false) by route = name | order by p95 desc'
        size: 0
        queryType: 0
        resourceType: 'microsoft.insights/components'
        visualization: 'table'
      }
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        title: 'Key routes: p95 per hour, last 7 days'
        query: 'requests | where timestamp > ago(7d) and name in (${keyRoutes}) | summarize p95 = percentile(duration, 95) by bin(timestamp, 1h), name | render timechart'
        size: 0
        queryType: 0
        resourceType: 'microsoft.insights/components'
        visualization: 'timechart'
      }
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        title: 'Slowest SQL queries, last 24 hours'
        query: 'dependencies | where timestamp > ago(24h) and isnotempty(customDimensions["db.query.text"]) | summarize calls = count(), p95 = round(percentile(duration, 95)), total = round(sum(duration)) by query = tostring(customDimensions["db.query.text"]) | top 20 by p95 desc'
        size: 0
        queryType: 0
        resourceType: 'microsoft.insights/components'
        visualization: 'table'
      }
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        title: 'Outbound calls and app work (AI, GitHub, rendering), last 24 hours'
        query: 'dependencies | where timestamp > ago(24h) and isempty(customDimensions["db.query.text"]) | summarize calls = count(), p50 = round(percentile(duration, 50)), p95 = round(percentile(duration, 95)), failed = countif(success == false) by name, type, target | order by p95 desc'
        size: 0
        queryType: 0
        resourceType: 'microsoft.insights/components'
        visualization: 'table'
      }
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        title: 'Requests over 3 seconds per hour (cold starts), last 7 days'
        query: 'requests | where timestamp > ago(7d) | summarize slow = countif(duration > 3000), all = count() by bin(timestamp, 1h) | render timechart'
        size: 0
        queryType: 0
        resourceType: 'microsoft.insights/components'
        visualization: 'timechart'
      }
    }
  ]
  fallbackResourceIds: [appInsights.id]
}

resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: guid(resourceGroup().id, 'canvas-performance-workbook')
  location: location
  kind: 'shared'
  properties: {
    displayName: 'Canvas performance'
    category: 'workbook'
    sourceId: appInsights.id
    serializedData: string(workbookContent)
  }
}

@description('Not a secret (Microsoft: the connection string only identifies where to send data).')
output connectionString string = appInsights.properties.ConnectionString
output appInsightsName string = appInsights.name
