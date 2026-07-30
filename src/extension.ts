import * as vscode from "vscode";
import { SessionVault } from "./session";
import {
  LAST_READ_KEY,
  LAST_SYNC_KEY,
  ReaderPanel,
  SIDEBAR_VIEW_ID,
  type ReaderState
} from "./webview";

const OFFICIAL_HOME = vscode.Uri.parse("https://weread.qq.com");

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("微信读书阅读器");
  const session = new SessionVault(context.secrets);
  const reader = new ReaderPanel(context, output, session);
  let bossHidden = false;

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    20
  );
  statusBar.name = "微信读书";
  statusBar.text = "$(book)";
  statusBar.tooltip = "在 VS Code 中打开微信读书";
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

  const updateReadingState = (state: ReaderState): void => {
    if (state.syncState === "syncing") {
      statusBar.text = "$(sync~spin)";
    } else if (state.syncState === "synced") {
      statusBar.text = "$(check)";
    } else if (state.syncState === "error") {
      statusBar.text = "$(warning)";
    } else if (state.loggedIn) {
      statusBar.text = "$(book)";
    } else {
      statusBar.text = "$(account)";
    }
    statusBar.tooltip = `微信读书：${state.message}\n单击打开阅读器`;
  };

  updateStatusBar();

  context.subscriptions.push(
    output,
    reader,
    statusBar,
    reader.onDidChangeState(updateReadingState),
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
      runDiagnostics(context, session, reader, output)
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
  context: vscode.ExtensionContext,
  session: SessionVault,
  reader: ReaderPanel,
  output: vscode.OutputChannel
): Promise<void> {
  await session.load();
  const lastRead = context.globalState.get<string>(LAST_READ_KEY);
  const lastSync = context.globalState.get<string>(LAST_SYNC_KEY);

  let officialReachable = false;
  let networkDetail = "请求尚未完成";
  try {
    const response = await fetch(OFFICIAL_HOME.toString(), {
      method: "HEAD",
      signal: AbortSignal.timeout(8_000)
    });
    officialReachable = response.ok;
    networkDetail = `HTTP ${response.status}`;
  } catch (error) {
    networkDetail = error instanceof Error ? error.message : String(error);
  }

  const checks = [
    {
      ok: officialReachable,
      label: "微信读书网络",
      detail: networkDetail
    },
    {
      ok: session.isLoggedIn,
      label: "登录会话",
      detail: session.isLoggedIn ? "已安全保存" : "尚未检测到完整登录 Cookie"
    },
    {
      ok: Boolean(lastRead),
      label: "继续阅读",
      detail: lastRead ?? "尚未打开过书籍"
    },
    {
      ok: Boolean(lastSync),
      label: "进度同步",
      detail: lastSync
        ? `最近成功：${new Date(lastSync).toLocaleString()}`
        : reader.currentState.message
    }
  ];

  output.appendLine("");
  output.appendLine(`===== 微信读书同步自检 ${new Date().toLocaleString()} =====`);
  for (const check of checks) {
    output.appendLine(`${check.ok ? "✓" : "○"} ${check.label}：${check.detail}`);
  }
  output.appendLine(
    "提示：手机端是否显示相同进度，需要在完成一次翻页后到微信读书 App 手工确认。"
  );

  const passed = checks.filter((check) => check.ok).length;
  const choice = await vscode.window.showInformationMessage(
    `微信读书自检完成：${passed}/${checks.length} 项已有记录`,
    "查看详情",
    "打开阅读器"
  );
  if (choice === "查看详情") {
    output.show(true);
  } else if (choice === "打开阅读器") {
    await reader.show();
  }
}
