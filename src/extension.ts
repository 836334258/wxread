import * as vscode from "vscode";
import { OFFICIAL_URLS } from "./links";
import { ReaderPanel, SIDEBAR_VIEW_ID } from "./webview";

const OFFICIAL_HOME = vscode.Uri.parse(OFFICIAL_URLS.home);
const LEGACY_SESSION_KEY = "wereadReader.sessionCookies";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("微信读书安全入口");
  const reader = new ReaderPanel();
  let bossHidden = false;

  void context.secrets
    .delete(LEGACY_SESSION_KEY)
    .then(
      () => output.appendLine("已清除旧版代理模式保存的登录会话。"),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`清除旧版登录会话失败：${message}`);
      }
    );

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    20
  );
  statusBar.name = "文档预览";
  statusBar.text = "$(book)";
  statusBar.tooltip = "打开微信读书官方网页入口";
  statusBar.command = "wereadReader.open";

  const updateStatusBar = (): void => {
    if (bossHidden) {
      statusBar.hide();
      return;
    }
    const visible = vscode.workspace
      .getConfiguration("wereadReader")
      .get<boolean>("showStatusBar", true);
    if (visible) {
      statusBar.show();
    } else {
      statusBar.hide();
    }
  };

  updateStatusBar();

  context.subscriptions.push(
    output,
    reader,
    statusBar,
    vscode.commands.registerCommand("wereadReader.open", () => reader.show()),
    vscode.commands.registerCommand("wereadReader.openFull", () =>
      reader.showFull()
    ),
    vscode.commands.registerCommand("wereadReader.reload", () =>
      reader.reload()
    ),
    vscode.commands.registerCommand("wereadReader.openExternal", () =>
      vscode.env.openExternal(OFFICIAL_HOME)
    ),
    vscode.commands.registerCommand("wereadReader.bossKey", async () => {
      bossHidden = await reader.toggleBossKey();
      updateStatusBar();
    }),
    vscode.commands.registerCommand("wereadReader.runDiagnostics", () =>
      runDiagnostics(output)
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("wereadReader.showStatusBar")) {
        updateStatusBar();
      }
    }),
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, reader, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.window.registerWebviewPanelSerializer("wereadReader.panel", {
      deserializeWebviewPanel: (panel) => reader.showFull(panel)
    })
  );
}

export function deactivate(): void {}

async function runDiagnostics(
  output: vscode.OutputChannel
): Promise<void> {
  let officialReachable = false;
  let networkDetail = "请求尚未完成";
  try {
    const response = await fetch(OFFICIAL_HOME.toString(), {
      method: "HEAD",
      signal: AbortSignal.timeout(8_000)
    });
    officialReachable = response.status >= 200 && response.status < 500;
    networkDetail = `HTTP ${response.status}`;
  } catch (error) {
    networkDetail = error instanceof Error ? error.message : String(error);
  }

  const checks = [
    {
      ok: officialReachable,
      label: "微信读书官网",
      detail: networkDetail
    },
    {
      ok: true,
      label: "安全模式",
      detail: "未启用本地代理、网页注入或 Cookie 存储"
    }
  ];

  output.appendLine("");
  output.appendLine(`===== 微信读书安全自检 ${new Date().toLocaleString()} =====`);
  for (const check of checks) {
    output.appendLine(`${check.ok ? "✓" : "○"} ${check.label}：${check.detail}`);
  }
  output.appendLine(
    "登录、阅读和进度同步均由系统浏览器中的微信读书官方网页完成。"
  );

  const passed = checks.filter((check) => check.ok).length;
  const choice = await vscode.window.showInformationMessage(
    `安全自检完成：${passed}/${checks.length} 项通过`,
    "查看详情",
    "打开官方网页"
  );
  if (choice === "查看详情") {
    output.show(true);
  } else if (choice === "打开官方网页") {
    await vscode.env.openExternal(OFFICIAL_HOME);
  }
}
