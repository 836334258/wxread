import { randomInt } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import httpProxy = require("http-proxy");
import { mergeCookieHeaders, SessionVault } from "./session";

const WEREAD_ORIGIN = "https://weread.qq.com";
const WEREAD_CDN_ORIGIN = "https://cdn.weread.qq.com";
const HEALTH_PATH = "/_weread_reader/health";
const CDN_PATH_PREFIX = "/_weread_reader/cdn";

export interface ProxyAddress {
  readonly origin: string;
  readonly port: number;
}

export type SyncState = "idle" | "syncing" | "synced" | "error";

export interface ProxyEvents {
  readonly onAuthChanged?: (loggedIn: boolean) => void;
  readonly onError?: (message: string) => void;
  readonly onLastReadChanged?: (path: string) => void;
  readonly onSyncChanged?: (state: SyncState, message: string) => void;
}

export function normalizeReaderPath(url: string | undefined): string | undefined {
  if (!url || !/^\/web\/reader\/[^/?#]+/.test(url)) {
    return undefined;
  }
  const parsed = new URL(url, WEREAD_ORIGIN);
  return `${parsed.pathname}${parsed.search}`;
}

function isSyncRequest(request: http.IncomingMessage): boolean {
  if (request.method !== "POST" || !request.url) {
    return false;
  }
  return /^\/web\/(?:book\/read|book\/bookmark|bookmark|review|chapter\/review)/.test(
    request.url
  );
}

function isDocumentRequest(request: http.IncomingMessage): boolean {
  const destination = request.headers["sec-fetch-dest"];
  const accept = request.headers.accept ?? "";
  return (
    request.method === "GET" &&
    (destination === "iframe" ||
      destination === "document" ||
      accept.includes("text/html"))
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function rewriteSetCookie(cookie: string): string {
  let rewritten = cookie
    .replace(/;\s*domain=[^;]+/gi, "")
    .replace(/;\s*samesite=(strict|lax|none)/gi, "");

  if (!/;\s*secure(?:;|$)/i.test(rewritten)) {
    rewritten += "; Secure";
  }
  rewritten += "; SameSite=None";
  return rewritten;
}

export function rewriteLocation(location: string): string {
  if (location.startsWith(WEREAD_ORIGIN)) {
    const url = new URL(location);
    return `${url.pathname}${url.search}${url.hash}`;
  }
  if (location.startsWith(WEREAD_CDN_ORIGIN)) {
    const url = new URL(location);
    return `${CDN_PATH_PREFIX}${url.pathname}${url.search}${url.hash}`;
  }
  return location;
}

export function rewriteCdnUrls(value: string): string {
  return value
    .replaceAll("https://cdn.weread.qq.com", CDN_PATH_PREFIX)
    .replaceAll("http://cdn.weread.qq.com", CDN_PATH_PREFIX)
    .replaceAll("https:\\/\\/cdn.weread.qq.com", CDN_PATH_PREFIX)
    .replaceAll("http:\\/\\/cdn.weread.qq.com", CDN_PATH_PREFIX)
    .replaceAll("//cdn.weread.qq.com", CDN_PATH_PREFIX);
}

export function injectProxyBridge(html: string): string {
  const bridge = `<script data-weread-reader-bridge>
(() => {
  const upstream = "https://weread.qq.com";
  const cdn = "https://cdn.weread.qq.com";
  const cdnPrefix = "/_weread_reader/cdn";
  const localize = (value) => {
    try {
      const url = new URL(String(value), location.href);
      if (url.origin === upstream) {
        return url.pathname + url.search + url.hash;
      }
      if (url.origin === cdn) {
        return cdnPrefix + url.pathname + url.search + url.hash;
      }
      return value;
    } catch {
      return value;
    }
  };
  const rewriteAttribute = (element, name) => {
    const current = element.getAttribute(name);
    if (current == null) return;
    const localized = localize(current);
    if (localized !== current) {
      element.setAttribute(name, localized);
    }
  };
  const rewriteElementUrls = (element) => {
    if (element.matches("a[href]")) rewriteAttribute(element, "href");
    if (element.matches("iframe[src]")) rewriteAttribute(element, "src");
    if (element.matches("form[action]")) rewriteAttribute(element, "action");
    if (element.matches("script[src]")) rewriteAttribute(element, "src");
    if (element.matches("link[href]")) rewriteAttribute(element, "href");
    if (element.matches("img[src]")) rewriteAttribute(element, "src");
    if (element.matches("source[src]")) rewriteAttribute(element, "src");
  };
  const rewriteUrls = (root) => {
    if (root instanceof Element) rewriteElementUrls(root);
    root
      .querySelectorAll?.(
        "a[href], iframe[src], form[action], script[src], link[href], img[src], source[src]"
      )
      .forEach(rewriteElementUrls);
  };
  const patchUrlProperty = (prototype, name) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor?.get || !descriptor?.set) return;
    Object.defineProperty(prototype, name, {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        descriptor.set.call(this, localize(value));
      }
    });
  };
  patchUrlProperty(HTMLIFrameElement.prototype, "src");
  patchUrlProperty(HTMLFormElement.prototype, "action");
  patchUrlProperty(HTMLScriptElement.prototype, "src");
  patchUrlProperty(HTMLLinkElement.prototype, "href");
  patchUrlProperty(HTMLImageElement.prototype, "src");
  patchUrlProperty(HTMLSourceElement.prototype, "src");
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const normalizedName = String(name).toLowerCase();
    if (
      (this instanceof HTMLIFrameElement && normalizedName === "src") ||
      (this instanceof HTMLFormElement && normalizedName === "action") ||
      (this instanceof HTMLScriptElement && normalizedName === "src") ||
      (this instanceof HTMLLinkElement && normalizedName === "href") ||
      (this instanceof HTMLImageElement && normalizedName === "src") ||
      (this instanceof HTMLSourceElement && normalizedName === "src")
    ) {
      value = localize(value);
    }
    return nativeSetAttribute.call(this, name, value);
  };
  const nativePushState = history.pushState.bind(history);
  const nativeReplaceState = history.replaceState.bind(history);
  history.pushState = (state, unused, url) =>
    nativePushState(state, unused, url == null ? url : localize(url));
  history.replaceState = (state, unused, url) =>
    nativeReplaceState(state, unused, url == null ? url : localize(url));
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return nativeOpen.call(this, method, localize(url), ...rest);
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === "string" || input instanceof URL) {
      return nativeFetch(localize(input), init);
    }
    if (input instanceof Request) {
      const localized = localize(input.url);
      return nativeFetch(
        localized === input.url ? input : new Request(localized, input),
        init
      );
    }
    return nativeFetch(input, init);
  };
  const nativeWindowOpen = window.open.bind(window);
  window.open = (url, target, features) =>
    nativeWindowOpen(url == null ? url : localize(url), target, features);
  document.addEventListener("click", (event) => {
    const anchor = event.target?.closest?.("a[href]");
    if (anchor) anchor.setAttribute("href", localize(anchor.getAttribute("href")));
  }, true);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof Element) {
        rewriteElementUrls(record.target);
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) rewriteUrls(node);
      }
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["href", "src", "action"],
    childList: true,
    subtree: true
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => rewriteUrls(document));
  } else {
    rewriteUrls(document);
  }
})();
</script>`;

  const head = /<head(?:\s[^>]*)?>/i;
  if (head.test(html)) {
    return html.replace(head, (match) => `${match}${bridge}`);
  }
  return `${bridge}${html}`;
}

export class WeReadProxy {
  private readonly upstreamAgent = new https.Agent({
    keepAlive: true,
    family: 4,
    maxSockets: 32,
    timeout: 20_000
  });
  private readonly proxy = httpProxy.createProxyServer({
    target: WEREAD_ORIGIN,
    changeOrigin: true,
    secure: true,
    xfwd: false,
    ws: true,
    selfHandleResponse: true,
    agent: this.upstreamAgent,
    proxyTimeout: 20_000,
    timeout: 20_000
  });

  private readonly fingerprint = String(randomInt(100_000_000, 1_000_000_000));
  private readonly cdnRequests = new WeakSet<http.IncomingMessage>();
  private server: http.Server | undefined;
  private address: ProxyAddress | undefined;

  constructor(
    private readonly session: SessionVault,
    private readonly log: (message: string) => void,
    private readonly events: ProxyEvents = {}
  ) {
    this.proxy.on("proxyRes", (proxyResponse, request, response) => {
      const headers = proxyResponse.headers;
      delete headers["x-frame-options"];
      delete headers["content-security-policy"];
      delete headers["content-security-policy-report-only"];
      delete headers["cross-origin-embedder-policy"];
      delete headers["cross-origin-opener-policy"];
      delete headers["cross-origin-resource-policy"];
      delete headers.connection;
      delete headers["keep-alive"];
      if (this.cdnRequests.has(request)) {
        headers["access-control-allow-origin"] = "*";
        delete headers["access-control-allow-credentials"];
      }

      const location = headers.location;
      if (location) {
        headers.location = rewriteLocation(location);
      }

      const setCookie = headers["set-cookie"]?.map(rewriteSetCookie) ?? [];
      if (
        request.url?.includes("/web/login/weblogin") &&
        !setCookie.some((cookie) => cookie.startsWith("wr_fp="))
      ) {
        setCookie.push(
          rewriteSetCookie(`wr_fp=${this.fingerprint}; Path=/; Max-Age=31104000`)
        );
      }
      if (setCookie.length > 0) {
        headers["set-cookie"] = setCookie;
        const wasLoggedIn = this.session.isLoggedIn;
        this.session.captureSetCookies(setCookie);
        if (wasLoggedIn !== this.session.isLoggedIn) {
          this.events.onAuthChanged?.(this.session.isLoggedIn);
        }
      }

      if (isSyncRequest(request)) {
        if (
          proxyResponse.statusCode !== undefined &&
          proxyResponse.statusCode >= 200 &&
          proxyResponse.statusCode < 400
        ) {
          this.events.onSyncChanged?.("synced", "阅读进度已同步");
        } else {
          this.events.onSyncChanged?.(
            "error",
            `同步失败（${proxyResponse.statusCode ?? "未知状态"}）`
          );
        }
      }

      if (!(response instanceof http.ServerResponse)) {
        proxyResponse.destroy();
        return;
      }

      const contentType = headers["content-type"] ?? "";
      const contentEncoding = headers["content-encoding"];
      const shouldTransform =
        request.method !== "HEAD" &&
        (contentType.includes("text/html") ||
          contentType.includes("text/css") ||
          contentType.includes("javascript") ||
          contentType.includes("application/json")) &&
        (!contentEncoding || contentEncoding === "identity");

      if (!shouldTransform) {
        response.writeHead(
          proxyResponse.statusCode ?? 502,
          proxyResponse.statusMessage ?? "",
          headers
        );
        proxyResponse.pipe(response);
        return;
      }

      const chunks: Buffer[] = [];
      proxyResponse.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      proxyResponse.on("end", () => {
        if (response.destroyed || response.headersSent) {
          return;
        }
        let body = rewriteCdnUrls(Buffer.concat(chunks).toString("utf8"));
        if (contentType.includes("text/html")) {
          body = injectProxyBridge(body);
        }
        delete headers["content-encoding"];
        delete headers["transfer-encoding"];
        headers["content-length"] = String(Buffer.byteLength(body));
        response.writeHead(
          proxyResponse.statusCode ?? 502,
          proxyResponse.statusMessage ?? "",
          headers
        );
        response.end(body);
      });
      proxyResponse.on("error", (error) => {
        if (!response.headersSent && !response.destroyed) {
          response.writeHead(502, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store"
          });
          response.end(`微信读书页面读取失败：${error.message}`);
        }
      });
    });

    this.proxy.on("error", (error, request, response) => {
      this.log(`代理请求失败：${error.message}`);
      if (isDocumentRequest(request)) {
        this.events.onError?.(error.message);
      }
      if (isSyncRequest(request)) {
        this.events.onSyncChanged?.(
          "error",
          `同步请求失败：${error.message}`
        );
      }
      if (response instanceof http.ServerResponse && !response.headersSent) {
        if (isDocumentRequest(request)) {
          response.writeHead(502, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store"
          });
          response.end(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { margin: 0; padding: 20px; color: #444; background: #f7f7f7; font: 14px/1.6 sans-serif; }
      .card { max-width: 560px; margin: 10vh auto 0; padding: 20px; border-radius: 8px; background: #fff; box-shadow: 0 4px 18px #0001; }
      code { overflow-wrap: anywhere; color: #b42318; }
    </style>
  </head>
  <body>
    <div class="card">
      <h3>微信读书暂时连接失败</h3>
      <p>插件会在侧栏中自动重试，也可以点击上方“刷新”。</p>
      <code>${escapeHtml(error.message)}</code>
    </div>
  </body>
</html>`);
        } else {
          response.writeHead(502, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store"
          });
          response.end(`微信读书资源加载失败：${error.message}`);
        }
      }
    });
  }

  async start(preferredPort: number): Promise<ProxyAddress> {
    if (this.address) {
      return this.address;
    }

    await this.session.load();
    this.events.onAuthChanged?.(this.session.isLoggedIn);

    const server = http.createServer((request, response) => {
      if (request.url === HEALTH_PATH) {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (request.url?.startsWith(`${CDN_PATH_PREFIX}/`)) {
        this.cdnRequests.add(request);
        request.url = request.url.slice(CDN_PATH_PREFIX.length);
        this.prepareRequest(request, true);
        this.proxy.web(request, response, { target: WEREAD_CDN_ORIGIN });
        return;
      }

      this.prepareRequest(request, false);
      this.proxy.web(request, response);
    });

    server.on("upgrade", (request, socket, head) => {
      this.proxy.ws(request, socket, head);
    });

    const address = await new Promise<ProxyAddress>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(preferredPort, "127.0.0.1", () => {
        server.off("error", onError);
        const serverAddress = server.address();
        if (!serverAddress || typeof serverAddress === "string") {
          reject(new Error("无法获取本地代理端口"));
          return;
        }
        resolve({
          origin: `http://127.0.0.1:${serverAddress.port}`,
          port: serverAddress.port
        });
      });
    });

    this.server = server;
    this.address = address;
    this.log(`本地阅读代理已启动：${address.origin}`);
    return address;
  }

  private prepareRequest(
    request: http.IncomingMessage,
    isCdnRequest: boolean
  ): void {
    request.headers.origin = WEREAD_ORIGIN;
    request.headers["accept-encoding"] = "identity";

    if (isCdnRequest) {
      delete request.headers.cookie;
    } else {
      const wasLoggedIn = this.session.isLoggedIn;
      this.session.captureCookieHeader(request.headers.cookie);
      if (wasLoggedIn !== this.session.isLoggedIn) {
        this.events.onAuthChanged?.(this.session.isLoggedIn);
      }
      const cookies = mergeCookieHeaders(
        this.session.cookieHeader,
        request.headers.cookie
      );
      if (cookies) {
        request.headers.cookie = cookies;
      }
    }

    const referer = request.headers.referer;
    if (referer && this.address) {
      request.headers.referer = referer.replace(
        this.address.origin,
        WEREAD_ORIGIN
      );
    }

    const readerPath = normalizeReaderPath(request.url);
    if (readerPath) {
      this.events.onLastReadChanged?.(readerPath);
    }
    if (isSyncRequest(request)) {
      this.events.onSyncChanged?.("syncing", "正在同步阅读进度…");
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.address = undefined;
    this.upstreamAgent.destroy();
    if (!server) {
      await this.session.flush();
      return;
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.session.flush();
    this.log("本地阅读代理已停止");
  }
}
