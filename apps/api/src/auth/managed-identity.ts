/**
 * canvas-haz.9: Entra sign-in without a client secret. Instead of OIDC_CLIENT_SECRET the API
 * proves it is the app registration with a token from its own managed identity ("workload identity
 * federation"): Entra trusts it through a federated credential on the app registration (issuer =
 * the tenant, subject = the managed identity's object id, audience api://AzureADTokenExchange).
 * Nothing to store, nothing to rotate.
 *
 * The token comes from the Container Apps managed-identity endpoint (IDENTITY_ENDPOINT +
 * IDENTITY_HEADER, set by the platform) for the user-assigned identity AZURE_CLIENT_ID, and is
 * reused until five minutes before it expires.
 */
const AUDIENCE = 'api://AzureADTokenExchange';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface ManagedIdentityOptions {
  /** The user-assigned identity's client id (AZURE_CLIENT_ID). */
  identityClientId: string;
  endpoint?: string;
  header?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class ManagedIdentityAssertion {
  private token = '';
  private expiresAt = 0;

  constructor(private readonly options: ManagedIdentityOptions) {}

  /** Fetches (or reuses) the identity's token for Entra's token-exchange audience. */
  async refresh(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    if (this.token && now < this.expiresAt - REFRESH_MARGIN_MS) return;
    const endpoint = this.options.endpoint ?? process.env.IDENTITY_ENDPOINT;
    const header = this.options.header ?? process.env.IDENTITY_HEADER;
    if (!endpoint || !header) {
      throw new Error('OIDC_CLIENT_AUTH=managed-identity needs the platform managed-identity endpoint (IDENTITY_ENDPOINT/IDENTITY_HEADER), which only exists inside Azure.');
    }
    const url = new URL(endpoint);
    url.searchParams.set('resource', AUDIENCE);
    url.searchParams.set('api-version', '2019-08-01');
    url.searchParams.set('client_id', this.options.identityClientId);
    const response = await (this.options.fetchImpl ?? fetch)(url, { headers: { 'X-IDENTITY-HEADER': header } });
    if (!response.ok) throw new Error(`Managed identity token request failed (${response.status}).`);
    const body = (await response.json()) as { access_token?: string; expires_on?: string | number };
    if (!body.access_token) throw new Error('Managed identity token response had no access_token.');
    this.token = body.access_token;
    const expiresOn = Number(body.expires_on);
    this.expiresAt = Number.isFinite(expiresOn) && expiresOn > 0 ? expiresOn * 1000 : now + 60 * 60 * 1000;
  }

  /**
   * openid-client client authentication: the identity's token as a client assertion, in place of
   * a secret. Synchronous (the library's hook is), so refresh() runs before each token exchange.
   */
  clientAuth(clientId: string) {
    return (_as: unknown, _client: unknown, body: URLSearchParams): void => {
      if (!this.token) throw new Error('Managed identity assertion not loaded -- refresh() before the token exchange.');
      body.set('client_id', clientId);
      body.set('client_assertion_type', ASSERTION_TYPE);
      body.set('client_assertion', this.token);
    };
  }
}
