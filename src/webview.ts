import * as vscode from "vscode";

const OFFICIAL_HOME = "https://weread.qq.com";

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
  opacity: number
): string {
  const token = nonce();
  const source = escapeAttribute(proxyUri.toString(true));
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
      iframe {
        width: 100%;
        height: 100%;
        border: 0;
        background: #f7f7f7;
        opacity: ${safeOpacity};
      }
    </style>
  </head>
  <body>
    <nav class="toolbar" aria-label="阅读器工具栏">
      <button type="button" data-action="home" title="返回微信读书首页">书架</button>
      <button type="button" data-action="reload" title="刷新当前页面">刷新</button>
      <button type="button" data-action="external" title="使用系统浏览器打开">浏览器打开</button>
      <span class="hint">登录后，阅读进度、书架和划线由微信读书自动同步</span>
    </nav>
    <iframe
      id="reader"
      src="${source}"
      title="微信读书官方阅读器"
      allow="clipboard-read; clipboard-write; fullscreen"
    ></iframe>
    <script nonce="${token}">
      const vscode = acquireVsCodeApi();
      const reader = document.getElementById("reader");

      document.querySelector(".toolbar").addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const action = button.dataset.action;
        if (action === "home") reader.src = ${JSON.stringify(proxyUri.toString(true))};
        if (action === "reload") reader.src = reader.src;
        if (action === "external") vscode.postMessage({ type: "external" });
      });

      window.addEventListener("message", (event) => {
        if (event.data?.type === "reload") reader.src = reader.src;
      });
    </script>
  </body>
</html>`;
}

export class ReaderPanel {
  private panel: vscode.WebviewPanel | undefined;
  private proxy: import("./proxy").WeReadProxy | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  async show(panelToRestore?: vscode.WebviewPanel): Promise<void> {
    if (this.panel && !panelToRestore) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const config = vscode.workspace.getConfiguration("wereadReader");
    const preferredPort = config.get<number>("proxyPort", 0);
    const title = config.get<string>("panelTitle", "微信读书");
    const opacity = config.get<number>("opacity", 1);

    const { WeReadProxy } = await import("./proxy");
    const proxy = new WeReadProxy((message) => this.output.appendLine(message));

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
      panel.webview.html = renderReaderHtml(panel.webview, browserUri, opacity);
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

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    void this.proxy?.stop();
    this.proxy = undefined;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
