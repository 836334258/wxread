import { randomInt } from "node:crypto";
import * as http from "node:http";
import httpProxy = require("http-proxy");
import { mergeCookieHeaders, SessionVault } from "./session";

const WEREAD_ORIGIN = "https://weread.qq.com";
const HEALTH_PATH = "/_weread_reader/health";

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
  if (!location.startsWith(WEREAD_ORIGIN)) {
    return location;
  }

  const url = new URL(location);
  return `${url.pathname}${url.search}${url.hash}`;
}

export class WeReadProxy {
  private readonly proxy = httpProxy.createProxyServer({
    target: WEREAD_ORIGIN,
    changeOrigin: true,
    secure: true,
    xfwd: false,
    ws: true
  });

  private readonly fingerprint = String(randomInt(100_000_000, 1_000_000_000));
  private server: http.Server | undefined;
  private address: ProxyAddress | undefined;

  constructor(
    private readonly session: SessionVault,
    private readonly log: (message: string) => void,
    private readonly events: ProxyEvents = {}
  ) {
    this.proxy.on("proxyReq", (proxyRequest, request) => {
      proxyRequest.setHeader("origin", WEREAD_ORIGIN);

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

    this.proxy.on("proxyRes", (proxyResponse, request) => {
      const headers = proxyResponse.headers;
      delete headers["x-frame-options"];
      delete headers["content-security-policy"];
      delete headers["content-security-policy-report-only"];
      delete headers["cross-origin-embedder-policy"];
      delete headers["cross-origin-opener-policy"];
      delete headers["cross-origin-resource-policy"];

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
    });

    this.proxy.on("error", (error, _request, response) => {
      this.log(`代理请求失败：${error.message}`);
      this.events.onError?.(error.message);
      this.events.onSyncChanged?.("error", "网络异常，同步暂时中断");
      if (response instanceof http.ServerResponse && !response.headersSent) {
        response.writeHead(502, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end("微信读书页面暂时无法访问，请稍后刷新。");
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
    if (!server) {
      await this.session.flush();
      return;
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.session.flush();
    this.log("本地阅读代理已停止");
  }
}
