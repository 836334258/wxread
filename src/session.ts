import * as vscode from "vscode";

const SESSION_KEY = "wereadReader.sessionCookies";

export interface ParsedCookie {
  readonly name: string;
  readonly value: string;
  readonly remove: boolean;
}

export function parseSetCookie(cookie: string): ParsedCookie | undefined {
  const [pair, ...attributes] = cookie.split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) {
    return undefined;
  }

  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  const maxAge = attributes
    .map((attribute) => attribute.trim())
    .find((attribute) => /^max-age=/i.test(attribute));
  const expires = attributes
    .map((attribute) => attribute.trim())
    .find((attribute) => /^expires=/i.test(attribute));

  const remove =
    value.length === 0 ||
    maxAge?.toLowerCase() === "max-age=0" ||
    (expires !== undefined &&
      Number.isFinite(Date.parse(expires.slice("expires=".length))) &&
      Date.parse(expires.slice("expires=".length)) <= Date.now());

  return { name, value, remove };
}

export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return cookies;
}

export function mergeCookieHeaders(
  persisted: string | undefined,
  incoming: string | undefined
): string | undefined {
  const merged = parseCookieHeader(persisted);
  for (const [name, value] of parseCookieHeader(incoming)) {
    merged.set(name, value);
  }

  if (merged.size === 0) {
    return undefined;
  }
  return [...merged].map(([name, value]) => `${name}=${value}`).join("; ");
}

export class SessionVault {
  private cookies = new Map<string, string>();
  private loadPromise: Promise<void> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromStorage();
    }
    await this.loadPromise;
  }

  private async loadFromStorage(): Promise<void> {
    const stored = await this.secrets.get(SESSION_KEY);
    if (!stored) {
      return;
    }

    try {
      const entries = JSON.parse(stored) as Array<[string, string]>;
      this.cookies = new Map(
        entries.filter(
          (entry): entry is [string, string] =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "string"
        )
      );
    } catch {
      await this.secrets.delete(SESSION_KEY);
    }
  }

  get cookieHeader(): string | undefined {
    if (this.cookies.size === 0) {
      return undefined;
    }
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  get isLoggedIn(): boolean {
    return this.cookies.has("wr_vid") && this.cookies.has("wr_skey");
  }

  captureSetCookies(setCookies: readonly string[]): void {
    let changed = false;
    for (const rawCookie of setCookies) {
      const cookie = parseSetCookie(rawCookie);
      if (!cookie) {
        continue;
      }

      if (cookie.remove) {
        changed = this.cookies.delete(cookie.name) || changed;
      } else if (this.cookies.get(cookie.name) !== cookie.value) {
        this.cookies.set(cookie.name, cookie.value);
        changed = true;
      }
    }
    if (changed) {
      this.queueSave();
    }
  }

  captureCookieHeader(header: string | undefined): void {
    const incoming = parseCookieHeader(header);
    let changed = false;
    for (const [name, value] of incoming) {
      if (this.cookies.get(name) !== value) {
        this.cookies.set(name, value);
        changed = true;
      }
    }
    if (changed) {
      this.queueSave();
    }
  }

  async clear(): Promise<void> {
    this.cookies.clear();
    await this.secrets.delete(SESSION_KEY);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private queueSave(): void {
    const serialized = JSON.stringify([...this.cookies]);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.secrets.store(SESSION_KEY, serialized));
  }
}
