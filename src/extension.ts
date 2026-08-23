import * as vscode from "vscode";
import { SyncEngine } from "./syncEngine";
import { ScratchpadWebviewProvider } from "./scratchpadWebviewProvider";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const engine = new SyncEngine(() => resolveWorkspaceRoot());
  const provider = new ScratchpadWebviewProvider(context.extensionUri, engine);

  await bootstrapProject(engine);

  try {
    await provider.initialize();
  } catch (error) {
    showActivationError(error);
  }

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(ScratchpadWebviewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void (async () => {
        await bootstrapProject(engine);
        await provider.resync();
      })();
    }),
    vscode.commands.registerCommand("scratchpad.focusSidebar", () => {
      provider.reveal();
    }),
    vscode.commands.registerCommand("scratchpad.quickDump", async () => {
      const text = await vscode.window.showInputBox({
        title: "Cursor Scratchpad",
        prompt: "Add to the thought dump.",
        placeHolder: "that other idea",
        ignoreFocusOut: true,
      });
      if (text !== undefined) {
        await provider.dumpThought(text);
      }
    }),
    vscode.commands.registerCommand("scratchpad.clearDump", async () => {
      const choice = await vscode.window.showWarningMessage(
        "Clear the thought dump?",
        { modal: true },
        "Clear dump",
      );
      if (choice === "Clear dump") {
        await provider.clearDump();
      }
    }),
  );
}

export function deactivate(): void {
  // No long-lived processes to tear down.
}

async function bootstrapProject(engine: SyncEngine): Promise<void> {
  try {
    await engine.ensureProjectStore();
  } catch (error) {
    if (error instanceof Error && error.message.includes("No workspace folder")) {
      return;
    }
    showActivationError(error);
  }
}

function resolveWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const matched = vscode.workspace.getWorkspaceFolder(activeUri);
    if (matched) {
      return matched.uri.fsPath;
    }
  }

  return folders[0]?.uri.fsPath;
}

function showActivationError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`Scratchpad: ${message}`);
}
