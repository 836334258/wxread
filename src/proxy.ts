import { randomInt } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import httpProxy = require("http-proxy");
import { mergeCookieHeaders, SessionVault } from "./session";

const WEREAD_ORIGIN = "https://weread.qq.com";
const WEREAD_CDN_ORIGIN = "https://cdn.weread.qq.com";
const HEALTH_PATH = "/_weread_reader/health";
const CDN_PATH_PREFIX = "/_weread_reader/cdn";
const MAX_RETRIES = 2;

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
  const rewriteLinks = (root) => {
    if (root instanceof Element && root.matches("a[href]")) {
      root.setAttribute("href", localize(root.getAttribute("href")));
    }
    root.querySelectorAll?.("a[href]").forEach((anchor) => {
      anchor.setAttribute("href", localize(anchor.getAttribute("href")));
    });
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
  document.addEventListener("click", (event) => {
    const anchor = event.target?.closest?.("a[href]");
    if (anchor) anchor.setAttribute("href", localize(anchor.getAttribute("href")));
  }, true);
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) rewriteLinks(node);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => rewriteLinks(document));
  } else {
    rewriteLinks(document);
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
  private readonly retryCounts = new WeakMap<http.IncomingMessage, number>();
  private readonly cdnRequests = new WeakSet<http.IncomingMessage>();
  private server: http.Server | undefined;
  private address: ProxyAddress | undefined;

  constructor(
    private readonly session: SessionVault,
    private readonly log: (message: string) => void,
    private readonly events: ProxyEvents = {}
  ) {
    this.proxy.on("proxyReq", (proxyRequest, request) => {
      proxyRequest.setHeader("origin", WEREAD_ORIGIN);
      proxyRequest.setHeader("accept-encoding", "identity");

      if (this.cdnRequests.has(request)) {
        proxyRequest.removeHeader("cookie");
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
          proxyRequest.setHeader("cookie", cookies);
        }
      }

      const referer = request.headers.referer;
      if (referer && this.address) {
        proxyRequest.setHeader(
          "referer",
          referer.replace(this.address.origin, WEREAD_ORIGIN)
        );
      }

      const readerPath = normalizeReaderPath(request.url);
      if (readerPath) {
        this.events.onLastReadChanged?.(readerPath);
      }
      if (isSyncRequest(request)) {
        this.events.onSyncChanged?.("syncing", "正在同步阅读进度…");
      }
    });

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
      const shouldInject =
        request.method !== "HEAD" &&
        contentType.includes("text/html") &&
        (!contentEncoding || contentEncoding === "identity");

      if (!shouldInject) {
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
        const body = injectProxyBridge(Buffer.concat(chunks).toString("utf8"));
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
      const retryCount = this.retryCounts.get(request) ?? 0;
      const canRetry =
        (request.method === "GET" || request.method === "HEAD") &&
        response instanceof http.ServerResponse &&
        !response.headersSent &&
        !response.destroyed &&
        retryCount < MAX_RETRIES;

      if (canRetry) {
        const nextRetry = retryCount + 1;
        this.retryCounts.set(request, nextRetry);
        this.log(
          `代理请求失败，正在重试 ${nextRetry}/${MAX_RETRIES}：${error.message}`
        );
        setTimeout(() => {
          if (
            response instanceof http.ServerResponse &&
            !response.headersSent &&
            !response.destroyed
          ) {
            this.proxy.web(request, response, {
              target: this.cdnRequests.has(request)
                ? WEREAD_CDN_ORIGIN
                : WEREAD_ORIGIN
            });
          }
        }, nextRetry * 500);
        return;
      }

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
      <p>插件已经自动重试 ${MAX_RETRIES} 次。请稍后点击上方“刷新”。</p>
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
        this.proxy.web(request, response, { target: WEREAD_CDN_ORIGIN });
        return;
      }

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
