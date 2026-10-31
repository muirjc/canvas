/**
 * canvas-6upe: OpenTelemetry for the API -- traces and metrics to Azure Application Insights.
 *
 * Imported FIRST by server.ts (and the job entry points that want it), before Fastify loads, so
 * the HTTP instrumentation can wrap Node's http server. On only when
 * APPLICATIONINSIGHTS_CONNECTION_STRING is set and TELEMETRY isn't 'off'; never under tests.
 * Postgres-driver spans are off: every query (Postgres or SQLite) gets one span from the Kysely
 * log hook instead (telemetry.ts), so the two engines look the same.
 *
 * Privacy: spans carry route templates, status codes, timings, the diagram family and an opaque
 * user id/role -- never DSL content, prompts, emails, tokens or query parameter values.
 */
import { useAzureMonitor } from '@azure/monitor-opentelemetry';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim();
const enabled = Boolean(connectionString) && process.env.NODE_ENV !== 'test' && process.env.TELEMETRY !== 'off';

if (enabled) {
  const ratio = Number(process.env.TELEMETRY_SAMPLING_RATIO ?? '1');
  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString },
    samplingRatio: Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 1,
    enableLiveMetrics: false,
    instrumentationOptions: {
      http: { enabled: true },
      azureSdk: { enabled: false },
      postgreSql: { enabled: false },
      mongoDb: { enabled: false },
      mySql: { enabled: false },
      redis: { enabled: false },
      redis4: { enabled: false },
      bunyan: { enabled: false },
      winston: { enabled: false },
    },
  });
  // Outbound fetch (the AI providers, GitHub, Entra discovery) goes through undici, which the
  // http instrumentation doesn't see. Constructed after the provider is registered.
  new UndiciInstrumentation();
}

export const telemetryEnabled = enabled;
