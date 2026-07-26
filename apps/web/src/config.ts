export interface WebConfig {
  apiBaseUrl: string;
}

export function loadWebConfig(): WebConfig {
  return {
    apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000',
  };
}
