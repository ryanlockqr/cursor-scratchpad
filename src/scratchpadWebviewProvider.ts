import * as vscode from "vscode";
import {
  cloneState,
  createInboxItem,
  DUMP_REL,
  DumpState,
  EMPTY_STATE,
  MAX_INBOX_ITEMS,
  sanitizeSubject,
  sanitizeUserText,
  SyncEngine,
  SyncError,
} from "./syncEngine";

type WebviewToExtension =
  | { type: "ready" }
  | { type: "dump"; text: string; subject?: string }
  | { type: "editInbox"; id: string; text: string; subject?: string }
  | { type: "openNote"; id: string }
  | { type: "removeInbox"; id: string };

export class ScratchpadWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "scratchpad.sidebar";

  private view: vscode.WebviewView | undefined;
  private state: DumpState = cloneState(EMPTY_STATE);
  private syncing = false;
  private dumpWatcher: vscode.FileSystemWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private notePanel: vscode.WebviewPanel | undefined;
  private notePanelId: string | undefined;

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

  public async dumpThought(raw: string, subjectRaw = ""): Promise<void> {
    await this.reloadFromDisk();

    const text = sanitizeUserText(raw);
    const subject = sanitizeSubject(subjectRaw);
    if (text.length === 0 && subject.length === 0) {
      return;
    }

    if (this.state.inbox.length >= MAX_INBOX_ITEMS) {
      void vscode.window.showWarningMessage(
        `Dump is full (${MAX_INBOX_ITEMS} items). Clear completed thoughts first.`,
      );
      return;
    }

    const item = createInboxItem(text, subject);
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
    this.notePanel?.dispose();
    this.notePanel = undefined;
    this.notePanelId = undefined;
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
        await this.dumpThought(message.text, message.subject ?? "");
        return;
      case "openNote":
        this.openNotePanel(message.id);
        return;
      case "removeInbox":
        await this.removeInbox(message.id);
        return;
      case "editInbox":
        await this.editInbox(message.id, message.text, message.subject ?? "");
        return;
    }
  }

  private async removeInbox(id: string): Promise<void> {
    await this.reloadFromDisk();
    this.state = {
      inbox: this.state.inbox.filter((item) => item.id !== id),
      updatedAt: new Date().toISOString(),
    };
    await this.writeToDisk();
  }

  private async editInbox(id: string, raw: string, subjectRaw = ""): Promise<void> {
    await this.reloadFromDisk();
    const text = sanitizeUserText(raw);
    const subject = sanitizeSubject(subjectRaw);
    if (text.length === 0 && subject.length === 0) {
      return;
    }

    const inbox = this.state.inbox.map((item) =>
      item.id === id ? { ...item, text, subject } : item,
    );
    this.state = {
      inbox,
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
    if (this.view) {
      void this.view.webview.postMessage({
        type: "state",
        state: this.state,
        syncing: this.syncing,
        hasWorkspace: this.engine.getRootSafe() !== undefined,
      });
    }
    this.postNotePanel();
  }

  private openNotePanel(id: string): void {
    const item = this.state.inbox.find((entry) => entry.id === id);
    if (!item) {
      return;
    }

    const title = noteTitle(item);
    if (this.notePanel) {
      this.notePanelId = id;
      this.notePanel.title = title;
      this.notePanel.reveal(vscode.ViewColumn.Beside);
      this.postNotePanel();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "scratchpad.note",
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.notePanel = panel;
    this.notePanelId = id;
    panel.webview.html = this.renderNotePanelHtml(panel.webview);
    panel.onDidDispose(() => {
      if (this.notePanel === panel) {
        this.notePanel = undefined;
        this.notePanelId = undefined;
      }
    });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isWebviewMessage(message)) {
        return;
      }
      if (message.type === "editInbox") {
        void this.editInbox(message.id, message.text, message.subject ?? "");
      }
    });
    this.postNotePanel();
  }

  private postNotePanel(): void {
    if (!this.notePanel || !this.notePanelId) {
      return;
    }

    const item = this.state.inbox.find((entry) => entry.id === this.notePanelId);
    if (!item) {
      this.notePanel.dispose();
      return;
    }

    this.notePanel.title = noteTitle(item);
    void this.notePanel.webview.postMessage({
      type: "note",
      id: item.id,
      subject: item.subject,
      text: item.text,
      syncing: this.syncing,
    });
  }

  private renderNotePanelHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Note</title>
  <style>
    html, body { height: 100%; box-sizing: border-box; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      gap: 8px;
      overflow: hidden;
    }
    textarea {
      flex: 1;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      resize: none;
      overflow-x: hidden;
      overflow-y: auto;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: inherit;
      line-height: 1.45;
      border-radius: 6px;
      padding: 10px;
      outline: none;
    }
    input[type="text"] {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: inherit;
      font-weight: 700;
      border-radius: 6px;
      padding: 8px 10px;
      outline: none;
    }
    textarea:focus, input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
    .bar { display: flex; justify-content: flex-end; align-items: center; }
    button {
      border: none;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 5px 10px;
      border-radius: 4px;
      cursor: pointer;
      font: inherit;
    }
  </style>
</head>
<body>
  <div class="bar"><button type="button" id="save">Save</button></div>
  <input type="text" id="subject" placeholder="Subject (optional)" maxlength="80" autocomplete="off" />
  <textarea id="body" spellcheck="true"></textarea>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const body = document.getElementById("body");
    const subject = document.getElementById("subject");
    const save = document.getElementById("save");
    let noteId = "";
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.type !== "note") return;
      noteId = data.id;
      if (document.activeElement !== body) body.value = data.text || "";
      if (document.activeElement !== subject) subject.value = data.subject || "";
      save.textContent = data.syncing ? "Saving…" : "Save";
    });
    save.addEventListener("click", () => {
      if (!noteId) return;
      vscode.postMessage({ type: "editInbox", id: noteId, text: body.value, subject: subject.value });
    });
    body.addEventListener("keydown", (event) => {
      if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        document.getElementById("save").click();
      }
    });
  </script>
</body>
</html>`;
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
      padding: 12px 12px 28px;
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
      max-width: 100%;
      min-width: 0;
      min-height: 72px;
      max-height: 180px;
      resize: vertical;
      overflow-x: hidden;
      overflow-y: auto;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      word-break: break-word;
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

    .subject-input {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      margin-bottom: 6px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-editor-background, var(--vscode-input-background));
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: inherit;
      font-weight: 700;
      border-radius: 6px;
      padding: 7px 10px;
      outline: none;
    }

    .subject-input:focus {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }

    .subject-input::placeholder {
      font-weight: 500;
      color: var(--vscode-input-placeholderForeground);
    }

    .hint {
      margin: 6px 0 0;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .inbox {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-bottom: 24px;
    }

    .item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: start;
      padding: 10px;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
      background: var(--vscode-input-background);
    }

    .item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .text {
      min-width: 0;
      line-height: 1.35;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .item-subject {
      font-weight: 700;
      margin-bottom: 4px;
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
      <input
        class="subject-input"
        id="subject"
        type="text"
        maxlength="80"
        placeholder="Subject (optional)"
        autocomplete="off"
      />
      <textarea
        id="dump"
        rows="3"
        placeholder="A thought… or a ramble"
        autocomplete="off"
        spellcheck="true"
      ></textarea>
      <p class="hint">Enter dumps it. Shift+Enter for a new line. Click a note to open it.</p>
    </section>
    <div class="inbox" id="inbox"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const dumpInput = document.getElementById("dump");
    const subjectInput = document.getElementById("subject");
    const inboxEl = document.getElementById("inbox");
    const statusEl = document.getElementById("status");
    const bannerEl = document.getElementById("workspace-banner");

    vscode.postMessage({ type: "ready" });

    function submitDump() {
      const text = dumpInput.value.trim();
      const subject = subjectInput.value.trim();
      if (!text && !subject) {
        return;
      }
      vscode.postMessage({ type: "dump", text, subject });
      dumpInput.value = "";
      subjectInput.value = "";
    }

    dumpInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      event.preventDefault();
      submitDump();
    });

    subjectInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      if (dumpInput.value.trim()) {
        submitDump();
      } else {
        dumpInput.focus();
      }
    });

    inboxEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const button = target.closest("button[data-action]");
      if (button instanceof HTMLElement) {
        const id = button.getAttribute("data-id");
        const action = button.getAttribute("data-action");
        if (id && action === "remove") {
          vscode.postMessage({ type: "removeInbox", id });
        }
        return;
      }
      const item = target.closest(".item");
      if (item instanceof HTMLElement) {
        const id = item.getAttribute("data-id");
        if (id) {
          vscode.postMessage({ type: "openNote", id });
        }
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

    function previewText(text) {
      const lines = String(text).split("\\n");
      let preview = lines.slice(0, 4).join("\\n");
      if (preview.length > 180) {
        preview = preview.slice(0, 180);
      }
      if (preview.length < String(text).length) {
        preview += "…";
      }
      return preview;
    }

    function renderItem(item) {
      const subject = String(item.subject || "");
      const preview = previewText(item.text);
      const titleHtml = subject
        ? '<div class="item-subject">' + escapeHtml(subject) + '</div>'
        : "";
      const bodyHtml = preview
        ? '<div>' + escapeHtml(preview) + '</div>'
        : "";
      return (
        '<div class="item" data-id="' + escapeAttr(item.id) + '">' +
          '<div class="text">' + titleHtml + bodyHtml + '</div>' +
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

function noteTitle(item: { subject: string; text: string }): string {
  const line = item.subject.trim() || item.text.split("\n")[0]?.trim() || "Note";
  return line.length > 48 ? `${line.slice(0, 45)}…` : line;
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
    case "editInbox":
      return (
        typeof (value as { id?: unknown }).id === "string" &&
        typeof (value as { text?: unknown }).text === "string"
      );
    case "openNote":
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
