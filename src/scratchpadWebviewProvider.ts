import * as vscode from "vscode";
import {
  cloneState,
  createInboxItem,
  DUMP_REL,
  DumpState,
  EMPTY_STATE,
  MAX_INBOX_ITEMS,
  sanitizeUserText,
  SyncEngine,
  SyncError,
} from "./syncEngine";

type WebviewToExtension =
  | { type: "ready" }
  | { type: "dump"; text: string }
  | { type: "toggleInbox"; id: string }
  | { type: "removeInbox"; id: string };

export class ScratchpadWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "scratchpad.sidebar";

  private view: vscode.WebviewView | undefined;
  private state: DumpState = cloneState(EMPTY_STATE);
  private syncing = false;
  private dumpWatcher: vscode.FileSystemWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly engine: SyncEngine,
  ) {}

  public async initialize(): Promise<void> {
    this.watchDump();
    await this.reloadFromDisk();
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    const messageSub = webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });

    webviewView.onDidDispose(() => {
      messageSub.dispose();
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  public async dumpThought(raw: string): Promise<void> {
    await this.reloadFromDisk();

    const text = sanitizeUserText(raw);
    if (text.length === 0) {
      return;
    }

    if (this.state.inbox.length >= MAX_INBOX_ITEMS) {
      void vscode.window.showWarningMessage(
        `Dump is full (${MAX_INBOX_ITEMS} items). Clear completed thoughts first.`,
      );
      return;
    }

    const item = createInboxItem(text);
    this.state = {
      inbox: [...this.state.inbox, item],
      updatedAt: new Date().toISOString(),
    };

    await this.writeToDisk();
  }

  public async clearDump(): Promise<void> {
    this.state = {
      inbox: [],
      updatedAt: new Date().toISOString(),
    };
    await this.writeToDisk();
  }

  public reveal(): void {
    void vscode.commands.executeCommand(`${ScratchpadWebviewProvider.viewType}.focus`);
  }

  public async resync(): Promise<void> {
    this.watchDump();
    await this.reloadFromDisk();
  }

  public dispose(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    this.dumpWatcher?.dispose();
    this.dumpWatcher = undefined;
  }

  private watchDump(): void {
    this.dumpWatcher?.dispose();
    this.dumpWatcher = undefined;

    const root = this.engine.getRootSafe();
    if (!root) {
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, DUMP_REL),
    );
    const scheduleReload = (): void => {
      if (this.engine.isWritingDump()) {
        return;
      }
      if (this.reloadTimer) {
        clearTimeout(this.reloadTimer);
      }
      this.reloadTimer = setTimeout(() => {
        void this.reloadFromDisk();
      }, 100);
    };
    watcher.onDidChange(scheduleReload);
    watcher.onDidCreate(scheduleReload);
    watcher.onDidDelete(scheduleReload);
    this.dumpWatcher = watcher;
  }

  private async reloadFromDisk(): Promise<void> {
    if (!this.engine.getRootSafe()) {
      this.state = cloneState(EMPTY_STATE);
      this.postState();
      return;
    }

    try {
      this.state = await this.engine.readDump();
      this.postState();
    } catch (error) {
      this.showError(error);
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isWebviewMessage(message)) {
      return;
    }

    switch (message.type) {
      case "ready":
        this.postState();
        return;
      case "dump":
        await this.dumpThought(message.text);
        return;
      case "toggleInbox":
        await this.toggleInbox(message.id);
        return;
      case "removeInbox":
        await this.removeInbox(message.id);
        return;
    }
  }

  private async toggleInbox(id: string): Promise<void> {
    await this.reloadFromDisk();
    const inbox = this.state.inbox.map((item) =>
      item.id === id ? { ...item, done: !item.done } : item,
    );
    this.state = {
      inbox,
      updatedAt: new Date().toISOString(),
    };
    await this.writeToDisk();
  }

  private async removeInbox(id: string): Promise<void> {
    await this.reloadFromDisk();
    this.state = {
      inbox: this.state.inbox.filter((item) => item.id !== id),
      updatedAt: new Date().toISOString(),
    };
    await this.writeToDisk();
  }

  private async writeToDisk(): Promise<void> {
    this.syncing = true;
    this.postState();

    try {
      await this.engine.syncDump(this.state);
      this.state = await this.engine.readDump();
    } catch (error) {
      this.showError(error);
    } finally {
      this.syncing = false;
      this.postState();
    }
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: "state",
      state: this.state,
      syncing: this.syncing,
      hasWorkspace: this.engine.getRootSafe() !== undefined,
    });
  }

  private showError(error: unknown): void {
    const message =
      error instanceof SyncError
        ? error.causes.length > 0
          ? `${error.message} ${error.causes[0]?.message ?? ""}`.trim()
          : error.message
        : error instanceof Error
          ? error.message
          : String(error);
    void vscode.window.showErrorMessage(`Scratchpad: ${message}`);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cursor Scratchpad</title>
  <style>
    :root {
      color-scheme: light dark;
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      height: 100%;
    }

    body {
      margin: 0;
      padding: 12px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }

    .stack {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .eyebrow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }

    .label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }

    .status {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }

    .status[data-busy="true"] {
      color: var(--vscode-focusBorder);
    }

    .card {
      border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
      background: var(--vscode-input-background);
      border-radius: 8px;
      padding: 10px;
    }

    textarea {
      width: 100%;
      min-height: 72px;
      max-height: 180px;
      resize: vertical;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: inherit;
      line-height: 1.4;
      border-radius: 6px;
      padding: 8px 10px;
      outline: none;
    }

    textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    textarea:focus {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }

    .hint {
      margin: 6px 0 0;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .inbox {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 10px;
    }

    .item {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 8px;
      align-items: start;
      padding: 7px 8px;
      border-radius: 6px;
    }

    .item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .item.done .text {
      text-decoration: line-through;
      opacity: 0.55;
    }

    .text {
      min-width: 0;
      line-height: 1.35;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .actions {
      display: flex;
      gap: 4px;
      opacity: 0;
    }

    .item:hover .actions,
    .item:focus-within .actions {
      opacity: 1;
    }

    button.ghost {
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font: inherit;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
    }

    button.ghost:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground, transparent);
    }

    .empty {
      padding: 10px 4px 2px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.45;
    }

    .banner {
      padding: 10px;
      border-radius: 8px;
      border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-widget-border));
      background: var(--vscode-inputValidation-warningBackground, transparent);
      color: var(--vscode-foreground);
      font-size: 12px;
      line-height: 1.4;
    }

    input[type="checkbox"] {
      margin-top: 2px;
      accent-color: var(--vscode-focusBorder);
    }
  </style>
</head>
<body>
  <div class="stack">
    <div id="workspace-banner" class="banner" hidden>
      Open a folder. Dump is per project.
    </div>

    <section class="card">
      <div class="eyebrow">
        <span class="label">Dump</span>
        <span class="status" id="status">Idle</span>
      </div>
      <textarea
        id="dump"
        maxlength="2000"
        rows="3"
        placeholder="A thought…"
        autocomplete="off"
        spellcheck="true"
      ></textarea>
      <p class="hint">Enter dumps it. Shift+Enter for a new line.</p>
      <div class="inbox" id="inbox"></div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const dumpInput = document.getElementById("dump");
    const inboxEl = document.getElementById("inbox");
    const statusEl = document.getElementById("status");
    const bannerEl = document.getElementById("workspace-banner");

    vscode.postMessage({ type: "ready" });

    dumpInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      event.preventDefault();
      const text = dumpInput.value.trim();
      if (!text) {
        return;
      }
      vscode.postMessage({ type: "dump", text });
      dumpInput.value = "";
    });

    inboxEl.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
        return;
      }
      const id = target.getAttribute("data-id");
      if (id) {
        vscode.postMessage({ type: "toggleInbox", id });
      }
    });

    inboxEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const button = target.closest("button[data-action]");
      if (!(button instanceof HTMLElement)) {
        return;
      }
      const id = button.getAttribute("data-id");
      const action = button.getAttribute("data-action");
      if (id && action === "remove") {
        vscode.postMessage({ type: "removeInbox", id });
      }
    });

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.type !== "state") {
        return;
      }
      render(data);
    });

    function render(payload) {
      const state = payload.state || { inbox: [] };
      bannerEl.hidden = Boolean(payload.hasWorkspace);

      statusEl.dataset.busy = payload.syncing ? "true" : "false";
      statusEl.textContent = payload.syncing ? "Saving…" : "Saved";

      if (!state.inbox || state.inbox.length === 0) {
        inboxEl.innerHTML = '<div class="empty">Nothing here yet.</div>';
        return;
      }

      inboxEl.innerHTML = state.inbox.map(renderItem).join("");
    }

    function renderItem(item) {
      const done = item.done ? " done" : "";
      const checked = item.done ? " checked" : "";
      return (
        '<div class="item' + done + '">' +
          '<input type="checkbox" data-id="' + escapeAttr(item.id) + '"' + checked + ' />' +
          '<div class="text">' + escapeHtml(item.text) + '</div>' +
          '<div class="actions">' +
            '<button class="ghost" type="button" data-action="remove" data-id="' + escapeAttr(item.id) + '">Remove</button>' +
          '</div>' +
        '</div>'
      );
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\\n/g, "");
    }
  </script>
</body>
</html>`;
  }
}

function isWebviewMessage(value: unknown): value is WebviewToExtension {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const type = (value as { type: unknown }).type;
  switch (type) {
    case "ready":
      return true;
    case "dump":
      return typeof (value as { text?: unknown }).text === "string";
    case "toggleInbox":
    case "removeInbox":
      return typeof (value as { id?: unknown }).id === "string";
    default:
      return false;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
