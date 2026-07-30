import * as vscode from "vscode";
import { ReaderPanel } from "./webview";

const OFFICIAL_HOME = vscode.Uri.parse("https://weread.qq.com");

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("微信读书阅读器");
  const reader = new ReaderPanel(context, output);

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    20
  );
  statusBar.name = "微信读书";
  statusBar.text = "$(book) 微信读书";
  statusBar.tooltip = "在 VS Code 中打开微信读书";
  statusBar.command = "wereadReader.open";

  const updateStatusBar = (): void => {
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
    vscode.commands.registerCommand("wereadReader.reload", () =>
      reader.reload()
    ),
    vscode.commands.registerCommand("wereadReader.openExternal", () =>
      vscode.env.openExternal(OFFICIAL_HOME)
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("wereadReader.showStatusBar")) {
        updateStatusBar();
      }
    }),
    vscode.window.registerWebviewPanelSerializer("wereadReader.panel", {
      deserializeWebviewPanel: (panel) => reader.show(panel)
    })
  );
}

export function deactivate(): void {}
