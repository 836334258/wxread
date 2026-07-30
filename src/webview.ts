import * as vscode from "vscode";
import { SessionVault } from "./session";
import type { SyncState, WeReadProxy } from "./proxy";

const OFFICIAL_HOME = "https://weread.qq.com";
export const SIDEBAR_VIEW_ID = "wereadReader.sidebar";
export const LAST_READ_KEY = "wereadReader.lastReadPath";
export const LAST_SYNC_KEY = "wereadReader.lastSyncAt";

export interface ReaderState {
  readonly loggedIn: boolean;
  readonly message: string;
  readonly syncState: SyncState;
}

interface ReaderEndpoint {
  readonly uri: vscode.Uri;
  readonly port: number;
}

function nonce(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderReaderHtml(
  webview: vscode.Webview,
  proxyUri: vscode.Uri,
  opacity: number,
  lastReadPath?: string,
  compact = false
): string {
  const token = nonce();
  const rawSource = proxyUri.toString(true);
  const source = escapeAttribute(rawSource);
  const frameSource = escapeAttribute(
    `${proxyUri.scheme}://${proxyUri.authority}`
  );
  const continueUrl = lastReadPath
    ? `${rawSource.replace(/\/$/, "")}${lastReadPath}`
    : undefined;
  const safeOpacity = Math.max(0.35, Math.min(1, opacity));

  return /* html */ `<!doctype html>
<html lang="zh-CN" data-layout="${compact ? "compact" : "full"}">
  <head>
    <meta charset="UTF-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src ${frameSource}; style-src 'nonce-${token}'; script-src 'nonce-${token}';"
    >
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>微信读书</title>
    <style nonce="${token}">
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: var(--vscode-editor-background);
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
      }
      body { display: grid; grid-template-rows: auto 1fr; }
      .toolbar {
        display: flex;
        min-height: 38px;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorGroupHeader-tabsBackground);
      }
      button {
        height: 28px;
        flex: 0 0 auto;
        padding: 0 9px;
        border: 1px solid transparent;
        border-radius: 4px;
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
        cursor: pointer;
        font: inherit;
      }
      button:hover { background: var(--vscode-button-secondaryHoverBackground); }
      button:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }
      .hint {
        min-width: 0;
        margin-left: auto;
        overflow: hidden;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .viewport { position: relative; min-width: 0; min-height: 0; }
      iframe {
        width: 100%;
        height: 100%;
        border: 0;
        background: #f7f7f7;
        opacity: ${safeOpacity};
      }
      .banner {
        position: absolute;
        z-index: 2;
        top: 10px;
        left: 50%;
        display: none;
        width: min(520px, calc(100% - 20px));
        padding: 10px;
        transform: translateX(-50%);
        border: 1px solid var(--vscode-inputValidation-errorBorder);
        border-radius: 6px;
        background: var(--vscode-inputValidation-errorBackground);
        color: var(--vscode-inputValidation-errorForeground);
        box-shadow: 0 4px 18px #0005;
        font-size: 12px;
      }
      .banner.visible { display: flex; align-items: center; gap: 8px; }
      .banner span { flex: 1; overflow-wrap: anywhere; }
      .status[data-state="syncing"] { color: var(--vscode-charts-blue); }
      .status[data-state="synced"] { color: var(--vscode-charts-green); }
      .status[data-state="error"] { color: var(--vscode-charts-red); }
      html[data-layout="compact"] .toolbar {
        flex-wrap: wrap;
        padding: 4px;
      }
      html[data-layout="compact"] button { padding: 0 7px; }
      html[data-layout="compact"] .hint {
        width: 100%;
        margin: 0 4px;
        line-height: 18px;
      }
      @media (max-width: 260px) {
        .toolbar { gap: 3px; }
        button { padding: 0 5px; font-size: 12px; }
      }
    </style>
  </head>
  <body>
    <nav class="toolbar" aria-label="阅读器工具栏">
      <button type="button" data-action="home" title="返回微信读书首页">书架</button>
      ${
        continueUrl
          ? '<button type="button" data-action="continue" title="打开上次阅读的书">继续</button>'
          : ""
      }
      <button type="button" data-action="reload" title="刷新当前页面">刷新</button>
      ${
        compact
          ? '<button type="button" data-action="full" title="在编辑器区域展开">展开</button>'
          : ""
      }
      <button type="button" data-action="external" title="使用系统浏览器打开">浏览器</button>
      <span class="hint status" data-state="idle">登录后由微信读书自动同步</span>
    </nav>
    <main class="viewport">
      <div class="banner" role="alert">
        <span>微信读书连接异常，已停止自动重试。</span>
        <button type="button" data-action="retry">重试</button>
        <button type="button" data-action="external">浏览器</button>
      </div>
      <iframe
        id="reader"
        src="${source}"
        title="微信读书官方阅读器"
        allow="clipboard-read; clipboard-write; fullscreen"
        referrerpolicy="no-referrer"
      ></iframe>
    </main>
    <script nonce="${token}">
      const vscode = acquireVsCodeApi();
      const reader = document.getElementById("reader");
      const status = document.querySelector(".status");
      const banner = document.querySelector(".banner");
      let retryCount = 0;
      let retryTimer;

      function reload() {
        banner.classList.remove("visible");
        reader.src = reader.src;
      }

      function handleError(message) {
        const detail = message || "连接异常";
        status.textContent = detail;
        status.dataset.state = "error";
        clearTimeout(retryTimer);
        if (retryCount < 2) {
          retryCount += 1;
          status.textContent = detail + "，重试 " + retryCount + "/2…";
          retryTimer = setTimeout(reload, retryCount * 1200);
        } else {
          banner.querySelector("span").textContent = detail;
          banner.classList.add("visible");
        }
      }

      document.body.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const action = button.dataset.action;
        if (action === "home") reader.src = ${JSON.stringify(rawSource)};
        if (action === "continue") reader.src = ${JSON.stringify(continueUrl ?? rawSource)};
        if (action === "reload" || action === "retry") {
          retryCount = 0;
          reload();
        }
        if (action === "external") vscode.postMessage({ type: "external" });
        if (action === "full") vscode.postMessage({ type: "full" });
      });

      window.addEventListener("message", (event) => {
        if (event.data?.type === "reload") {
          retryCount = 0;
          reload();
        }
        if (event.data?.type === "status") {
          status.textContent = event.data.message;
          status.dataset.state = event.data.state;
        }
        if (event.data?.type === "proxyError") handleError(event.data.message);
      });
    </script>
  </body>
</html>`;
}

function renderStartupErrorHtml(message: string): string {
  const detail = escapeAttribute(message);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { padding: 16px; color: #d4d4d4; background: #1e1e1e; font: 13px sans-serif; }
      p { overflow-wrap: anywhere; }
    </style>
  </head>
  <body><h3>微信读书启动失败</h3><p>${detail}</p><p>请执行“微信读书：刷新阅读器”重试。</p></body>
</html>`;
}

export class ReaderPanel implements vscode.WebviewViewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private view: vscode.WebviewView | undefined;
  private proxy: WeReadProxy | undefined;
  private endpoint: ReaderEndpoint | undefined;
  private proxyStartup: Promise<ReaderEndpoint> | undefined;
  private hiddenTarget: "panel" | "sidebar" | "both" | undefined;
  private lastTextEditor:
    | { document: vscode.TextDocument; viewColumn: vscode.ViewColumn | undefined }
    | undefined;
  private state: ReaderState = {
    loggedIn: false,
    message: "等待打开微信读书",
    syncState: "idle"
  };
  private readonly stateEmitter = new vscode.EventEmitter<ReaderState>();
  private readonly disposables: vscode.Disposable[] = [];
  readonly onDidChangeState = this.stateEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly session: SessionVault
  ) {}

  get currentState(): ReaderState {
    return this.state;
  }

  get visible(): boolean {
    return Boolean(this.panel?.visible || this.view?.visible);
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.onDidDispose(
      () => {
        if (this.view === view) {
          this.view = undefined;
        }
      },
      undefined,
      this.disposables
    );
    await this.initializeWebview(view.webview, true);
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.explorer");
    await vscode.commands.executeCommand(`${SIDEBAR_VIEW_ID}.focus`);
    this.view?.show(false);
  }

  async showFull(panelToRestore?: vscode.WebviewPanel): Promise<void> {
    if (this.panel && !panelToRestore) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    if (vscode.window.activeTextEditor) {
      this.lastTextEditor = {
        document: vscode.window.activeTextEditor.document,
        viewColumn: vscode.window.activeTextEditor.viewColumn
      };
    }

    const title = vscode.workspace
      .getConfiguration("wereadReader")
      .get<string>("panelTitle", "微信读书");
    const panel =
      panelToRestore ??
      vscode.window.createWebviewPanel(
        "wereadReader.panel",
        title,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

    this.panel = panel;
    panel.title = title;
    panel.onDidDispose(
      () => {
        if (this.panel === panel) {
          this.panel = undefined;
        }
      },
      undefined,
      this.disposables
    );
    await this.initializeWebview(panel.webview, false);
  }

  reload(): void {
    if (!this.panel?.visible && !this.view?.visible) {
      void this.show();
      return;
    }
    void this.panel?.webview.postMessage({ type: "reload" });
    void this.view?.webview.postMessage({ type: "reload" });
  }

  async toggleBossKey(): Promise<boolean> {
    if (this.hiddenTarget) {
      const target = this.hiddenTarget;
      this.hiddenTarget = undefined;
      if ((target === "panel" || target === "both") && this.panel) {
        this.panel.reveal(vscode.ViewColumn.One);
      }
      if (target === "sidebar" || target === "both") {
        await this.show();
      }
      return false;
    }

    if (this.panel?.visible) {
      const sidebarVisible = this.view?.visible ?? false;
      this.hiddenTarget = sidebarVisible ? "both" : "panel";
      if (sidebarVisible) {
        await vscode.commands.executeCommand("workbench.action.closeSidebar");
      }
      const previous = this.lastTextEditor;
      if (previous && !previous.document.isClosed) {
        await vscode.window.showTextDocument(previous.document, {
          viewColumn: previous.viewColumn,
          preserveFocus: false,
          preview: false
        });
      } else {
        await vscode.commands.executeCommand(
          "workbench.action.openPreviousRecentlyUsedEditor"
        );
      }
      return true;
    }

    if (this.view?.visible) {
      this.hiddenTarget = "sidebar";
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      return true;
    }

    await this.show();
    return false;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.view = undefined;
    this.endpoint = undefined;
    void this.proxy?.stop();
    this.proxy = undefined;
    this.stateEmitter.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private async initializeWebview(
    webview: vscode.Webview,
    compact: boolean
  ): Promise<void> {
    webview.options = { enableScripts: true };
    webview.onDidReceiveMessage(
      async (message: unknown) => {
        if (typeof message !== "object" || message === null || !("type" in message)) {
          return;
        }
        if (message.type === "external") {
          await vscode.env.openExternal(vscode.Uri.parse(OFFICIAL_HOME));
        } else if (message.type === "full") {
          await this.showFull();
        }
      },
      undefined,
      this.disposables
    );

    try {
      const endpoint = await this.ensureProxy();
      const config = vscode.workspace.getConfiguration("wereadReader");
      webview.options = {
        enableScripts: true,
        portMapping: [
          {
            webviewPort: endpoint.port,
            extensionHostPort: endpoint.port
          }
        ]
      };
      webview.html = renderReaderHtml(
        webview,
        endpoint.uri,
        config.get<number>("opacity", 1),
        this.context.globalState.get<string>(LAST_READ_KEY),
        compact
      );
      void webview.postMessage({
        type: "status",
        state: this.state.syncState,
        message: this.state.message
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      webview.html = renderStartupErrorHtml(message);
      this.output.appendLine(`启动失败：${message}`);
      void vscode.window
        .showErrorMessage(`微信读书阅读器启动失败：${message}`, "查看日志")
        .then((choice) => {
          if (choice === "查看日志") {
            this.output.show(true);
          }
        });
    }
  }

  private async ensureProxy(): Promise<ReaderEndpoint> {
    if (this.endpoint) {
      return this.endpoint;
    }
    this.proxyStartup ??= this.startProxy();
    try {
      return await this.proxyStartup;
    } finally {
      if (!this.endpoint) {
        this.proxyStartup = undefined;
      }
    }
  }

  private async startProxy(): Promise<ReaderEndpoint> {
    const preferredPort = vscode.workspace
      .getConfiguration("wereadReader")
      .get<number>("proxyPort", 0);
    const { WeReadProxy } = await import("./proxy");
    const proxy = new WeReadProxy(
      this.session,
      (message) => this.output.appendLine(message),
      {
        onAuthChanged: (loggedIn) => {
          this.updateState(
            this.state.syncState,
            loggedIn ? "账号已登录，等待阅读同步" : "等待扫码登录",
            loggedIn
          );
        },
        onError: (message) => {
          this.postToReaders({
            type: "proxyError",
            message: `连接异常：${message}`
          });
        },
        onLastReadChanged: (path) => {
          void this.context.globalState.update(LAST_READ_KEY, path);
        },
        onSyncChanged: (syncState, message) => {
          if (syncState === "synced") {
            void this.context.globalState.update(
              LAST_SYNC_KEY,
              new Date().toISOString()
            );
          }
          this.updateState(syncState, message);
        }
      }
    );
    this.proxy = proxy;

    try {
      const address = await proxy.start(preferredPort);
      const endpoint = {
        uri: vscode.Uri.parse(`http://localhost:${address.port}`),
        port: address.port
      };
      this.endpoint = endpoint;
      this.updateState(
        "idle",
        this.session.isLoggedIn
          ? "账号已登录，等待阅读同步"
          : "等待扫码登录",
        this.session.isLoggedIn
      );
      return endpoint;
    } catch (error) {
      await proxy.stop();
      if (this.proxy === proxy) {
        this.proxy = undefined;
      }
      throw error;
    }
  }

  private updateState(
    syncState: SyncState,
    message: string,
    loggedIn = this.state.loggedIn
  ): void {
    this.state = { loggedIn, message, syncState };
    this.stateEmitter.fire(this.state);
    this.postToReaders({
      type: "status",
      state: syncState,
      message
    });
  }

  private postToReaders(message: object): void {
    void this.panel?.webview.postMessage(message);
    void this.view?.webview.postMessage(message);
  }
}
