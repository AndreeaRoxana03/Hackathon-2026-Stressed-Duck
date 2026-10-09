import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
  logout(): Promise<void>;
}

export class StaticTokenProvider implements AccessTokenProvider {
  public constructor(private readonly token: string) {
    if (!token.trim()) {
      throw new Error("A non-empty access token is required.");
    }
  }

  public async getAccessToken(): Promise<string> {
    return this.token;
  }

  public async logout(): Promise<void> {}
}

export interface OAuthTokenProviderOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly fetchImplementation?: typeof fetch;
  readonly openBrowser?: (url: string) => Promise<void>;
}

interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
}

interface TokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly expires_in?: unknown;
}

const EXPIRY_MARGIN_MS = 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function basicCredentials(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function waitForAuthorizationCode(
  authorizeUrl: URL,
  redirectUri: URL,
  openBrowser: (url: string) => Promise<void>,
): Promise<string> {
  if (
    redirectUri.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(redirectUri.hostname)
  ) {
    throw new Error("DUCK_OAUTH_REDIRECT_URI must be an HTTP loopback URL.");
  }

  const port = Number(redirectUri.port || "80");
  const callbackPath = redirectUri.pathname;
  const state = authorizeUrl.searchParams.get("state");
  if (!state) {
    throw new Error("OAuth authorization state was not created.");
  }

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", `${redirectUri.protocol}//${redirectUri.host}`);
      if (requestUrl.pathname !== callbackPath) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      const receivedState = requestUrl.searchParams.get("state");
      const finish = (callbackError?: Error, authorizationCode?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        server.close();
        if (callbackError) {
          reject(callbackError);
        } else {
          resolve(authorizationCode!);
        }
      };

      if (error) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h1>Sign-in failed</h1><p>You can close this window.</p>");
        finish(new Error(`TID authorization failed: ${error}`));
        return;
      }
      if (receivedState !== state) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h1>Invalid OAuth state</h1><p>You can close this window.</p>");
        finish(new Error("TID OAuth callback state did not match."));
        return;
      }
      if (!code) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h1>Missing authorization code</h1><p>You can close this window.</p>");
        finish(new Error("TID OAuth callback did not include a code."));
        return;
      }

      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<h1>Signed in</h1><p>You can close this window.</p>");
      finish(undefined, code);
    });
    const timeout = setTimeout(() => {
      settled = true;
      server.close();
      reject(new Error("TID sign-in timed out after five minutes."));
    }, LOGIN_TIMEOUT_MS);
    server.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    server.listen(port, redirectUri.hostname, () => {
      void openBrowser(authorizeUrl.toString()).catch((error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          reject(new Error(`Unable to open the sign-in page: ${(error as Error).message}`));
        }
      });
    });
  });
}

export class OAuthTokenProvider implements AccessTokenProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly openBrowser: (url: string) => Promise<void>;
  private tokenSet: TokenSet | undefined;
  private activeRequest: Promise<string> | undefined;

  public constructor(private readonly options: OAuthTokenProviderOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.openBrowser = options.openBrowser ?? defaultOpenBrowser;
  }

  public async getAccessToken(): Promise<string> {
    if (this.tokenSet && this.tokenSet.expiresAt > Date.now() + EXPIRY_MARGIN_MS) {
      return this.tokenSet.accessToken;
    }
    this.activeRequest ??= this.resolveAccessToken().finally(() => {
      this.activeRequest = undefined;
    });
    return await this.activeRequest;
  }

  public async logout(): Promise<void> {
    this.tokenSet = undefined;
  }

  private async resolveAccessToken(): Promise<string> {
    if (this.tokenSet?.refreshToken) {
      try {
        this.tokenSet = await this.requestToken(
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: this.tokenSet.refreshToken,
          }),
          this.tokenSet.refreshToken,
        );
        return this.tokenSet.accessToken;
      } catch {
        this.tokenSet = undefined;
      }
    }

    const redirectUri = new URL(this.options.redirectUri);
    const state = randomBytes(32).toString("base64url");
    const authorizeUrl = new URL("/oauth/authorize", this.options.baseUrl);
    authorizeUrl.search = new URLSearchParams({
      client_id: this.options.clientId,
      response_type: "code",
      scope: this.options.scopes.join(" "),
      redirect_uri: redirectUri.toString(),
      state,
    }).toString();
    const code = await waitForAuthorizationCode(authorizeUrl, redirectUri, this.openBrowser);
    this.tokenSet = await this.requestToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: this.options.clientId,
        redirect_uri: redirectUri.toString(),
      }),
    );
    return this.tokenSet.accessToken;
  }

  private async requestToken(parameters: URLSearchParams, previousRefreshToken?: string): Promise<TokenSet> {
    const response = await this.fetchImplementation(new URL("/oauth/token", this.options.baseUrl), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${basicCredentials(this.options.clientId, this.options.clientSecret)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: parameters,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`TID OAuth ${response.status}: ${body || response.statusText}`);
    }
    const parsed = JSON.parse(body) as TokenResponse;
    const accessToken = stringValue(parsed.access_token);
    if (!accessToken) {
      throw new Error("TID token response did not include an access_token.");
    }
    const expiresIn = Number(parsed.expires_in);
    const refreshToken = stringValue(parsed.refresh_token) ?? previousRefreshToken;
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    };
  }
}