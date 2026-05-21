type AuthConfig = { user: string; key: string };

// WebDriver protocol element ref — JSONWP uses 'ELEMENT', W3C uses a long UUID key
type WebDriverElement = Record<string, string>;

/**
 * Minimal W3C WebDriver Protocol client using fetch.
 * Covers the subset needed for device interaction: source, find, click,
 * sendKeys, actions, and execute (mobile commands).
 *
 * @param baseUrl - Appium server URL (e.g. http://localhost:4723).
 * @param sessionId - Active session ID.
 * @param auth - Optional basic auth for cloud providers like BrowserStack.
 */
export class WebDriverClient {
  readonly #baseUrl: string;

  readonly #sessionId: string;

  readonly #headers: Record<string, string>;

  constructor(baseUrl: string, sessionId: string, auth?: AuthConfig) {
    this.#baseUrl = baseUrl.replace(/\/+$/u, '');
    this.#sessionId = sessionId;
    this.#headers = { 'Content-Type': 'application/json' };

    if (auth) {
      const encoded = Buffer.from(`${auth.user}:${auth.key}`).toString(
        'base64',
      );
      this.#headers.Authorization = `Basic ${encoded}`;
    }
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  async getPageSource(): Promise<string> {
    return this.#get<string>(`/source`);
  }

  async execute<Type>(script: string, args: unknown[] = []): Promise<Type> {
    return this.#post<Type>(`/execute/sync`, { script, args });
  }

  async executeAsync<Type>(
    script: string,
    args: unknown[] = [],
  ): Promise<Type> {
    return this.#post<Type>(`/execute/async`, { script, args });
  }

  async findElement(
    strategy: string,
    selector: string,
  ): Promise<WebDriverElement> {
    return this.#post(`/element`, { using: strategy, value: selector });
  }

  async findElements(
    strategy: string,
    selector: string,
  ): Promise<WebDriverElement[]> {
    return this.#post(`/elements`, { using: strategy, value: selector });
  }

  async elementClick(elementId: string): Promise<void> {
    await this.#post(`/element/${elementId}/click`, {});
  }

  async elementSendKeys(elementId: string, text: string): Promise<void> {
    await this.#post(`/element/${elementId}/value`, { text });
  }

  async elementClear(elementId: string): Promise<void> {
    await this.#post(`/element/${elementId}/clear`, {});
  }

  async getElementAttribute(
    elementId: string,
    name: string,
  ): Promise<string | null> {
    return this.#get(`/element/${elementId}/attribute/${name}`);
  }

  async getElementRect(
    elementId: string,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.#get(`/element/${elementId}/rect`);
  }

  async performActions(actions: unknown[]): Promise<void> {
    await this.#post(`/actions`, { actions });
  }

  async releaseActions(): Promise<void> {
    await this.#delete(`/actions`);
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.#baseUrl}/status`, {
      headers: this.#headers,
    });
    const body = (await response.json()) as { value: Record<string, unknown> };
    return body.value;
  }

  async getSessionDetails(): Promise<Record<string, unknown>> {
    return this.#get(``);
  }

  async queryAppState(bundleId: string): Promise<number> {
    return this.execute<number>('mobile: queryAppState', [{ bundleId }]);
  }

  async getCurrentActivity(): Promise<string> {
    return this.execute<string>('mobile: getCurrentActivity', []);
  }

  async updateSettings(settings: Record<string, unknown>): Promise<void> {
    await this.#post(`/appium/settings`, { settings });
  }

  async #get<Type>(path: string): Promise<Type> {
    const url = `${this.#baseUrl}/session/${this.#sessionId}${path}`;
    const response = await fetch(url, { headers: this.#headers });
    return this.#unwrap<Type>(response, 'GET', path);
  }

  async #post<Type>(path: string, body: unknown): Promise<Type> {
    const url = `${this.#baseUrl}/session/${this.#sessionId}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.#headers,
      body: JSON.stringify(body),
    });
    return this.#unwrap<Type>(response, 'POST', path);
  }

  async #delete(path: string): Promise<void> {
    const url = `${this.#baseUrl}/session/${this.#sessionId}${path}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.#headers,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`DELETE ${path} failed (${response.status}): ${text}`);
    }
  }

  async #unwrap<Type>(
    response: Response,
    method: string,
    path: string,
  ): Promise<Type> {
    const body = (await response.json()) as {
      value: Type | { error: string; message: string };
    };

    if (!response.ok) {
      const errorValue = body.value as { error?: string; message?: string };
      throw new Error(
        `${method} ${path} failed (${response.status}): ${errorValue?.message ?? JSON.stringify(body.value)}`,
      );
    }

    return body.value as Type;
  }
}

export async function createSession(
  baseUrl: string,
  capabilities: Record<string, unknown>,
  auth?: AuthConfig,
): Promise<{ sessionId: string; client: WebDriverClient }> {
  const url = `${baseUrl.replace(/\/+$/u, '')}/session`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (auth) {
    const encoded = Buffer.from(`${auth.user}:${auth.key}`).toString('base64');
    headers.Authorization = `Basic ${encoded}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: capabilities,
      },
    }),
  });

  const body = (await response.json()) as {
    value: { sessionId: string; capabilities: Record<string, unknown> };
  };

  if (!response.ok) {
    throw new Error(
      `Failed to create Appium session (${response.status}): ${JSON.stringify(body)}`,
    );
  }

  const { sessionId } = body.value;
  return {
    sessionId,
    client: new WebDriverClient(baseUrl, sessionId, auth),
  };
}
