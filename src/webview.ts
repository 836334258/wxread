import * as vscode from "vscode";
import { SessionVault } from "./session";
import type { SyncState, WeReadProxy } from "./proxy";

const OFFICIAL_HOME = "https://weread.qq.com";
export const LAST_READ_KEY = "wereadReader.lastReadPath";
export const LAST_SYNC_KEY = "wereadReader.lastSyncAt";

export interface ReaderState {
  readonly loggedIn: boolean;
  readonly message: string;
  readonly syncState: SyncState;
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
  lastReadPath?: string
): string {
  const token = nonce();
  const source = escapeAttribute(proxyUri.toString(true));
  const continueUrl = lastReadPath
    ? `${proxyUri.toString(true).replace(/\/$/, "")}${lastReadPath}`
    : undefined;
  const safeOpacity = Math.max(0.35, Math.min(1, opacity));

  return /* html */ `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src ${source}; style-src 'nonce-${token}'; script-src 'nonce-${token}';"
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
      body { display: grid; grid-template-rows: 38px 1fr; }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorGroupHeader-tabsBackground);
      }
      button {
        height: 28px;
        padding: 0 10px;
        border: 1px solid transparent;
        border-radius: 4px;
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
        cursor: pointer;
        font: inherit;
      }
      button:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }
      button:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }
      .hint {
        margin-left: auto;
        overflow: hidden;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .viewport { position: relative; min-height: 0; }
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
        top: 16px;
        left: 50%;
        display: none;
        width: min(520px, calc(100% - 32px));
        padding: 12px;
        transform: translateX(-50%);
        border: 1px solid var(--vscode-inputValidation-errorBorder);
        border-radius: 6px;
        background: var(--vscode-inputValidation-errorBackground);
        color: var(--vscode-inputValidation-errorForeground);
        box-shadow: 0 4px 18px #0005;
      }
      .banner.visible { display: flex; align-items: center; gap: 10px; }
      .banner span { flex: 1; }
      .status[data-state="syncing"] { color: var(--vscode-charts-blue); }
      .status[data-state="synced"] { color: var(--vscode-charts-green); }
      .status[data-state="error"] { color: var(--vscode-charts-red); }
    </style>
  </head>
  <body>
    <nav class="toolbar" aria-label="阅读器工具栏">
      <button type="button" data-action="home" title="返回微信读书首页">书架</button>
      ${
        continueUrl
          ? '<button type="button" data-action="continue" title="打开上次阅读的书">继续阅读</button>'
          : ""
      }
      <button type="button" data-action="reload" title="刷新当前页面">刷新</button>
      <button type="button" data-action="external" title="使用系统浏览器打开">浏览器打开</button>
      <span class="hint status" data-state="idle">登录后由微信读书自动同步</span>
    </nav>
    <main class="viewport">
      <div class="banner" role="alert">
        <span>微信读书连接异常，已停止自动重试。</span>
        <button type="button" data-action="retry">重试</button>
        <button type="button" data-action="external">浏览器打开</button>
      </div>
      <iframe
        id="reader"
        src="${source}"
        title="微信读书官方阅读器"
        allow="clipboard-read; clipboard-write; fullscreen"
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
        status.textContent = message || "连接异常";
        status.dataset.state = "error";
        clearTimeout(retryTimer);
        if (retryCount < 2) {
          retryCount += 1;
          status.textContent = "连接异常，正在自动重试 " + retryCount + "/2…";
          retryTimer = setTimeout(reload, retryCount * 1200);
        } else {
          banner.classList.add("visible");
        }
      }

      document.body.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const action = button.dataset.action;
        if (action === "home") reader.src = ${JSON.stringify(proxyUri.toString(true))};
        if (action === "continue") reader.src = ${JSON.stringify(continueUrl ?? proxyUri.toString(true))};
        if (action === "reload" || action === "retry") {
          retryCount = 0;
          reload();
        }
        if (action === "external") vscode.postMessage({ type: "external" });
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

export class ReaderPanel {
  private panel: vscode.WebviewPanel | undefined;
  private proxy: WeReadProxy | undefined;
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
    return this.panel?.visible ?? false;
  }

  async show(panelToRestore?: vscode.WebviewPanel): Promise<void> {
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

    const config = vscode.workspace.getConfiguration("wereadReader");
    const preferredPort = config.get<number>("proxyPort", 0);
    const title = config.get<string>("panelTitle", "微信读书");
    const opacity = config.get<number>("opacity", 1);

    const { WeReadProxy } = await import("./proxy");
    const updateState = (
      syncState: SyncState,
      message: string,
      loggedIn = this.state.loggedIn
    ): void => {
      this.state = { loggedIn, message, syncState };
      this.stateEmitter.fire(this.state);
      void this.panel?.webview.postMessage({
        type: "status",
        state: syncState,
        message
      });
    };

    const proxy = new WeReadProxy(
      this.session,
      (message) => this.output.appendLine(message),
      {
        onAuthChanged: (loggedIn) => {
          updateState(
            this.state.syncState,
            loggedIn ? "账号已登录，等待阅读同步" : "等待扫码登录",
            loggedIn
          );
        },
        onError: (message) => {
          void this.panel?.webview.postMessage({
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
          updateState(syncState, message);
        }
      }
    );

    try {
      const address = await proxy.start(preferredPort);
      const localUri = vscode.Uri.parse(address.origin);
      const browserUri = await vscode.env.asExternalUri(localUri);

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

      panel.title = title;
      const lastReadPath =
        this.context.globalState.get<string>(LAST_READ_KEY);
      panel.webview.html = renderReaderHtml(
        panel.webview,
        browserUri,
        opacity,
        lastReadPath
      );
      panel.webview.onDidReceiveMessage(
        async (message: unknown) => {
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "external"
          ) {
            await vscode.env.openExternal(vscode.Uri.parse(OFFICIAL_HOME));
          }
        },
        undefined,
        this.disposables
      );
      panel.onDidDispose(
        () => {
          if (this.panel === panel) {
            this.panel = undefined;
            this.proxy = undefined;
          }
          void proxy.stop();
        },
        undefined,
        this.disposables
      );

      this.panel = panel;
      this.proxy = proxy;
      updateState(
        "idle",
        this.session.isLoggedIn
          ? "账号已登录，等待阅读同步"
          : "等待扫码登录",
        this.session.isLoggedIn
      );
    } catch (error) {
      await proxy.stop();
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`启动失败：${message}`);
      void vscode.window.showErrorMessage(
        `微信读书阅读器启动失败：${message}`,
        "查看日志"
      ).then((choice) => {
        if (choice === "查看日志") {
          this.output.show(true);
        }
      });
    }
  }

  reload(): void {
    if (!this.panel) {
      void this.show();
      return;
    }
    void this.panel.webview.postMessage({ type: "reload" });
    this.panel.reveal(vscode.ViewColumn.One);
  }

  async toggleBossKey(): Promise<void> {
    if (!this.panel) {
      await this.show();
      return;
    }
    if (!this.panel.visible) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const previous = this.lastTextEditor;
    if (previous && !previous.document.isClosed) {
      await vscode.window.showTextDocument(previous.document, {
        viewColumn: previous.viewColumn,
        preserveFocus: false,
        preview: false
      });
      return;
    }
    await vscode.commands.executeCommand(
      "workbench.action.openPreviousRecentlyUsedEditor"
    );
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    void this.proxy?.stop();
    this.proxy = undefined;
    this.stateEmitter.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
