import * as vscode from "vscode";
import { officialUriForAction } from "./links";

export const SIDEBAR_VIEW_ID = "wereadReader.sidebar";

function nonce(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

export function renderLauncherHtml(compact = false): string {
  const token = nonce();
  return /* html */ `<!doctype html>
<html lang="zh-CN" data-layout="${compact ? "compact" : "full"}">
  <head>
    <meta charset="UTF-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${token}'; script-src 'nonce-${token}';"
    >
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文档预览</title>
    <style nonce="${token}">
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      html, body {
        width: 100%;
        min-height: 100%;
        margin: 0;
        background: var(--vscode-sideBar-background);
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
      }
      body {
        display: grid;
        min-height: 100vh;
        place-items: center;
        padding: 20px;
      }
      .card {
        width: min(520px, 100%);
        padding: 24px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 12px;
        background: var(--vscode-editor-background);
        box-shadow: 0 8px 28px #0002;
      }
      .mark {
        display: grid;
        width: 48px;
        height: 48px;
        margin-bottom: 16px;
        place-items: center;
        border-radius: 12px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        font-size: 24px;
        font-weight: 700;
      }
      h1 { margin: 0 0 10px; font-size: 20px; }
      p {
        margin: 0 0 18px;
        color: var(--vscode-descriptionForeground);
        font-size: 13px;
        line-height: 1.7;
      }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; }
      button {
        min-height: 32px;
        padding: 0 12px;
        border: 1px solid transparent;
        border-radius: 5px;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        cursor: pointer;
        font: inherit;
      }
      button:hover { background: var(--vscode-button-hoverBackground); }
      button.secondary {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
      }
      button.secondary:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }
      button:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 2px;
      }
      .safe {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        margin-top: 18px;
        padding-top: 16px;
        border-top: 1px solid var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        line-height: 1.6;
      }
      .safe strong { color: var(--vscode-charts-green); }
      html[data-layout="compact"] body {
        display: block;
        min-height: 0;
        padding: 8px;
      }
      html[data-layout="compact"] .card {
        padding: 14px;
        border-radius: 8px;
        box-shadow: none;
      }
      html[data-layout="compact"] .mark {
        width: 38px;
        height: 38px;
        margin-bottom: 10px;
        border-radius: 9px;
        font-size: 19px;
      }
      html[data-layout="compact"] h1 { font-size: 16px; }
      html[data-layout="compact"] p { margin-bottom: 12px; }
      @media (max-width: 260px) {
        button { width: 100%; }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="mark" aria-hidden="true">阅</div>
      <h1>官方网页阅读</h1>
      <p>
        登录、书架、阅读和进度同步均在系统默认浏览器中的微信读书官方网页完成。
        扩展不会代理、注入或修改网页，也不会读取或保存账号 Cookie。
      </p>
      <div class="actions">
        <button type="button" data-action="home">打开微信读书</button>
        <button type="button" class="secondary" data-action="shelf">打开官方书架</button>
        ${
          compact
            ? '<button type="button" class="secondary" data-action="full">展开说明</button>'
            : ""
        }
      </div>
      <div class="safe">
        <strong>安全模式</strong>
        <span>仅打开官方域名，不在 VS Code 内进行登录或正文阅读。</span>
      </div>
    </main>
    <script nonce="${token}">
      const vscode = acquireVsCodeApi();
      document.body.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const action = button.dataset.action;
        if (action === "full") {
          vscode.postMessage({ type: "full" });
        } else {
          vscode.postMessage({ type: "open", action });
        }
      });
    </script>
  </body>
</html>`;
}

interface LauncherMessage {
  readonly type?: unknown;
  readonly action?: unknown;
}

export class ReaderPanel implements vscode.WebviewViewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private view: vscode.WebviewView | undefined;
  private hiddenTarget: "panel" | "sidebar" | "both" | undefined;
  private lastTextEditor:
    | { document: vscode.TextDocument; viewColumn: vscode.ViewColumn | undefined }
    | undefined;
  private readonly disposables: vscode.Disposable[] = [];

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
    this.initializeWebview(view.webview, true);
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
      .get<string>("panelTitle", "文档预览");
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
    this.initializeWebview(panel.webview, false);
  }

  reload(): void {
    if (!this.panel?.visible && !this.view?.visible) {
      void this.show();
      return;
    }
    if (this.panel) {
      this.panel.webview.html = renderLauncherHtml(false);
    }
    if (this.view) {
      this.view.webview.html = renderLauncherHtml(true);
    }
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
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private initializeWebview(webview: vscode.Webview, compact: boolean): void {
    webview.options = { enableScripts: true };
    webview.html = renderLauncherHtml(compact);
    webview.onDidReceiveMessage(
      async (rawMessage: unknown) => {
        const message = rawMessage as LauncherMessage;
        if (message.type === "full") {
          await this.showFull();
          return;
        }
        if (message.type !== "open") {
          return;
        }
        const uri = officialUriForAction(message.action);
        if (uri) {
          await vscode.env.openExternal(vscode.Uri.parse(uri));
        }
      },
      undefined,
      this.disposables
    );
  }
}
