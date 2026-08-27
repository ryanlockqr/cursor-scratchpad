import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface InboxItem {
  readonly id: string;
  readonly subject: string;
  readonly text: string;
  readonly done: boolean;
  readonly createdAt: string;
}

export interface DumpState {
  readonly inbox: readonly InboxItem[];
  readonly updatedAt: string;
}

export const EMPTY_STATE: DumpState = {
  inbox: [],
  updatedAt: new Date(0).toISOString(),
};

export const MAX_ITEM_LENGTH = 100_000;
export const MAX_SUBJECT_LENGTH = 80;
export const MAX_INBOX_ITEMS = 500;

/** Source of truth for the thought dump. Hidden from explorer; stays off git. */
export const DUMP_REL = ".cursor/scratchpad.md";
/** Cursor rule — local to this machine. Visible in the tree; not committed. */
const RULE_REL = ".cursor/rules/scratchpad.mdc";
const ORGANIZE_SKILL_DIR = ".cursor/skills/organize-scratchpad";
const BRIEF_SKILL_DIR = ".cursor/skills/brief-scratchpad";
/** Removed in 0.1.11 — still deleted on activate if left behind. */
const LEGACY_SKILL_DIRS = [
  ".cursor/skills/rules-from-scratchpad",
  ".cursor/skills/update-scratchpad",
] as const;
const ORGANIZE_SKILL_REL = `${ORGANIZE_SKILL_DIR}/SKILL.md`;
const BRIEF_SKILL_REL = `${BRIEF_SKILL_DIR}/SKILL.md`;

const EXCLUDE_MARKERS = [
  DUMP_REL,
  RULE_REL,
  `${ORGANIZE_SKILL_DIR}/`,
  `${BRIEF_SKILL_DIR}/`,
];
const CHECKBOX_RE = /^- \[([ xX])\]\s+(.+?)(?:\s+<!--id:([^\s>]+)-->)?\s*$/;
const NOTE_HEADING_RE = /^####\s+<!--id:([^\s>]+)-->\s*$/;
const SUBJECT_LINE_RE = /^\*\*(.+)\*\*\s*$/;
const FOOTER_RE = /_Last synced:\s*([^\s_]+)/;

export class SyncError extends Error {
  public override readonly name = "SyncError";

  public constructor(
    message: string,
    public readonly causes: readonly Error[] = [],
  ) {
    super(message);
  }
}

export class SyncEngine {
  private writeChain: Promise<void> = Promise.resolve();
  private writing = false;

  public constructor(private readonly getWorkspace: () => string | undefined) {}

  public getRootSafe(): string | undefined {
    return this.getWorkspace();
  }

  public resolveRoot(): string {
    const root = this.getRootSafe();
    if (!root) {
      throw new SyncError(
        "No workspace folder is open. Open a folder to dump thoughts for that project.",
      );
    }
    return root;
  }

  public dumpAbsolutePath(): string | undefined {
    const root = this.getRootSafe();
    return root ? path.join(root, DUMP_REL) : undefined;
  }

  public isWritingDump(): boolean {
    return this.writing;
  }

  public async ensureProjectStore(): Promise<void> {
    const root = this.resolveRoot();
    await fs.mkdir(path.dirname(path.join(root, DUMP_REL)), { recursive: true });
    await fs.mkdir(path.dirname(path.join(root, RULE_REL)), { recursive: true });
    await fs.mkdir(path.dirname(path.join(root, ORGANIZE_SKILL_REL)), { recursive: true });
    await fs.mkdir(path.dirname(path.join(root, BRIEF_SKILL_REL)), { recursive: true });
    await removeLegacySkillDirs(root);
    await ensureLocalGitExclude(root);
    await seedFileIfMissing(path.join(root, DUMP_REL), renderDump(EMPTY_STATE));
    await atomicWrite(path.join(root, RULE_REL), renderRule());
    await atomicWrite(path.join(root, ORGANIZE_SKILL_REL), renderOrganizeSkill());
    await atomicWrite(path.join(root, BRIEF_SKILL_REL), renderBriefSkill());
  }

  public async readDump(): Promise<DumpState> {
    const root = this.getRootSafe();
    if (!root) {
      return cloneState(EMPTY_STATE);
    }

    await this.ensureProjectStore();
    try {
      const contents = await fs.readFile(path.join(root, DUMP_REL), "utf8");
      return parseDump(contents);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return cloneState(EMPTY_STATE);
      }
      throw new SyncError("Failed to read the thought dump.", [toError(error)]);
    }
  }

  public syncDump(state: DumpState): Promise<void> {
    const snapshot = cloneState(state);
    const run = (): Promise<void> => this.writeDump(snapshot);
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  private async writeDump(state: DumpState): Promise<void> {
    const root = this.resolveRoot();
    await this.ensureProjectStore();
    this.writing = true;
    try {
      await atomicWrite(path.join(root, DUMP_REL), renderDump(state));
    } catch (error) {
      throw new SyncError("Failed to write the thought dump.", [toError(error)]);
    } finally {
      // Let the filesystem watcher settle before accepting external reloads.
      setTimeout(() => {
        this.writing = false;
      }, 150);
    }
  }
}

export function createInboxItem(text: string, subject = ""): InboxItem {
  const trimmed = sanitizeUserText(text);
  const title = sanitizeSubject(subject);
  if (trimmed.length === 0 && title.length === 0) {
    throw new SyncError("Dumped thoughts cannot be empty.");
  }

  return {
    id: createId(),
    subject: title,
    text: trimmed,
    done: false,
    createdAt: new Date().toISOString(),
  };
}

export function sanitizeUserText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, MAX_ITEM_LENGTH);
}

export function sanitizeSubject(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/^\*+|\*+$/g, "")
    .replace(/\*/g, "")
    .trim()
    .slice(0, MAX_SUBJECT_LENGTH);
}

export function cloneState(state: DumpState): DumpState {
  return {
    inbox: state.inbox.map((item) => ({ ...item })),
    updatedAt: state.updatedAt,
  };
}

export function parseDump(contents: string): DumpState {
  const footerMatch = FOOTER_RE.exec(contents);
  const updatedAt = footerMatch?.[1] && !Number.isNaN(Date.parse(footerMatch[1]))
    ? footerMatch[1]
    : new Date().toISOString();

  const fromNotes = parseHeadingNotes(contents, updatedAt);
  if (fromNotes.length > 0) {
    return { inbox: fromNotes, updatedAt };
  }

  return { inbox: parseLegacyCheckboxes(contents, updatedAt), updatedAt };
}

function parseHeadingNotes(contents: string, updatedAt: string): InboxItem[] {
  const inbox: InboxItem[] = [];
  const seen = new Set<string>();
  let sectionDone = false;
  let current: { done: boolean; id: string; lines: string[] } | undefined;

  const flush = (): void => {
    pushItem(inbox, seen, current, updatedAt);
    current = undefined;
  };

  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (FOOTER_RE.test(trimmed) || trimmed === "# Scratchpad") {
      flush();
      continue;
    }
    if (/^###\s+Done\b/i.test(trimmed)) {
      flush();
      sectionDone = true;
      continue;
    }
    if (/^###\s+Open\b/i.test(trimmed)) {
      flush();
      sectionDone = false;
      continue;
    }

    const heading = NOTE_HEADING_RE.exec(trimmed);
    if (heading) {
      flush();
      current = { done: sectionDone, id: heading[1]!.trim(), lines: [] };
      continue;
    }

    if (current) {
      current.lines.push(rawLine);
    }
  }
  flush();
  return inbox;
}

function parseLegacyCheckboxes(contents: string, updatedAt: string): InboxItem[] {
  const inbox: InboxItem[] = [];
  const seen = new Set<string>();
  let current: { done: boolean; id: string; lines: string[] } | undefined;

  const flush = (): void => {
    pushItem(inbox, seen, current, updatedAt);
    current = undefined;
  };

  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const match = CHECKBOX_RE.exec(trimmed);
    const isTopLevelCheckbox = Boolean(match) && !rawLine.startsWith(" ");

    if (isTopLevelCheckbox && match) {
      flush();
      current = {
        done: match[1]!.toLowerCase() === "x",
        id: match[3]?.trim() || "",
        lines: [stripIdMarker(match[2] ?? "")],
      };
      continue;
    }

    if (current && rawLine.startsWith("  ")) {
      current.lines.push(rawLine.slice(2));
    }
  }
  flush();
  return inbox;
}

function pushItem(
  inbox: InboxItem[],
  seen: Set<string>,
  current: { done: boolean; id: string; lines: string[] } | undefined,
  updatedAt: string,
): void {
  if (!current || inbox.length >= MAX_INBOX_ITEMS) {
    return;
  }

  const parsed = splitSubjectAndBody(current.lines.join("\n"));
  if (parsed.text.length === 0 && parsed.subject.length === 0) {
    return;
  }

  let id = current.id;
  if (!id || seen.has(id)) {
    id = stableIdFor(`${parsed.subject}\n${parsed.text}`, current.done, inbox.length);
  }
  seen.add(id);

  inbox.push({
    id,
    subject: parsed.subject,
    text: parsed.text,
    done: current.done,
    createdAt: updatedAt,
  });
}

function splitSubjectAndBody(raw: string): { subject: string; text: string } {
  const trimmed = sanitizeUserText(raw);
  if (trimmed.length === 0) {
    return { subject: "", text: "" };
  }

  const [first, ...rest] = trimmed.split("\n");
  const match = first ? SUBJECT_LINE_RE.exec(first.trim()) : undefined;
  if (!match) {
    return { subject: "", text: trimmed };
  }

  return {
    subject: sanitizeSubject(match[1] ?? ""),
    text: sanitizeUserText(rest.join("\n")),
  };
}

function stripIdMarker(text: string): string {
  return text.replace(/\s+<!--id:[^>]+-->\s*$/, "").trim();
}

function stableIdFor(text: string, done: boolean, index: number): string {
  const digest = createHash("sha1")
    .update(`${done ? "1" : "0"}\n${text}\n${index}`)
    .digest("hex")
    .slice(0, 10);
  return `t_${digest}`;
}

function renderDump(state: DumpState): string {
  return [
    "# Scratchpad",
    "",
    "Thought dump for this project. Not the current task.",
    "",
    renderInboxMarkdown(state.inbox),
    "",
    renderFooter(state.updatedAt),
    "",
  ].join("\n");
}

function renderRule(): string {
  return [
    "---",
    "description: The thought dump lives in .cursor/scratchpad.md. Do not chase it unless asked.",
    "alwaysApply: true",
    "---",
    "",
    "# Scratchpad",
    "",
    "The human keeps a thought dump in `.cursor/scratchpad.md` while working.",
    "",
    "- That file is the source of truth for the dump.",
    "- Those items are **not** the current task.",
    "- Do **not** switch to dump items unless the human asks.",
    "- Stay on the work in progress. Capture is handled by the Scratchpad extension sidebar.",
    "- When asked to organize, regroup, prune, drop, or mark dump notes done, use `/organize-scratchpad`.",
    "- When asked what’s in the dump or for a briefing, use `/brief-scratchpad`.",
    "",
  ].join("\n");
}

function renderOrganizeSkill(): string {
  return [
    "---",
    "name: organize-scratchpad",
    "description: >-",
    "  Organizes the thought dump: regroup, add subjects, and prune or mark done",
    "  after asking. Use when the user asks to organize, regroup, cluster, tidy,",
    "  update, prune, clean out, or drop scratchpad / dump notes.",
    "disable-model-invocation: true",
    "---",
    "",
    "# Organize Scratchpad",
    "",
    "## When to use",
    "",
    "Only when the human asks to organize, regroup, prune, update, or clean the dump. Do not run unprompted. Read-only overview → `/brief-scratchpad`.",
    "",
    "## Instructions",
    "",
    "1. Read `.cursor/scratchpad.md` — it is the source of truth.",
    "2. List open notes by **subject** (or first line if none) — not full bodies.",
    "3. Propose changes, then **ask before rewriting**:",
    "   - Regroup / cluster / add or shorten subjects.",
    "   - Mark done or delete: shipped, duplicates, empty rambles, finished one-offs.",
    "   Numbered list is fine. They pick numbers, \"delete all flagged\", \"organize only\", or \"none\".",
    "4. After they pick, rewrite `.cursor/scratchpad.md`:",
    "   - Keep `# Scratchpad` and the one-line purpose blurb.",
    "   - `### Open` / `### Done`.",
    "   - Each note: `#### <!--id:...-->`, optional `**subject**`, then body. Preserve ids on keepers.",
    "   - Do not invent new notes. Empty notes can be dropped.",
    "5. Do not expand dump items into a project plan.",
    "6. Say what you regrouped, marked done, removed, and left open.",
    "",
    "## Examples",
    "",
    "- `/organize-scratchpad`",
    "- \"organize my scratchpad\"",
    "- \"prune the dump\"",
    "- \"what can I drop\"",
    "",
  ].join("\n");
}

function renderBriefSkill(): string {
  return [
    "---",
    "name: brief-scratchpad",
    "description: >-",
    "  Reads the thought dump and gives a short briefing: open notes, themes,",
    "  what looks stale. Use when the user asks what’s in the dump, a summary,",
    "  a briefing, or catch-me-up on scratchpad / thought dump notes. Do not rewrite the dump.",
    "disable-model-invocation: true",
    "---",
    "",
    "# Brief Scratchpad",
    "",
    "## When to use",
    "",
    "Only when invoked (`/brief-scratchpad`) or the human asks what’s in the thought dump. Do not brief unprompted mid-task. Do not rewrite `.cursor/scratchpad.md` — that’s `/organize-scratchpad`.",
    "",
    "## Instructions",
    "",
    "1. Read `.cursor/scratchpad.md`. Open notes matter; Done is optional unless they ask.",
    "2. Reply in chat only. Do not edit the dump, rules, or skills.",
    "3. Keep it short:",
    "   - Counts: open vs done.",
    "   - Themes (a few groups), each with **subject** if present, else a one-line title — not full bodies.",
    "   - Stale or duplicate-looking open notes, if any.",
    "4. Do not start work from dump items. Do not expand notes into a plan unless they pick one after the brief.",
    "5. If the dump is empty, say so in one line.",
    "",
    "## Examples",
    "",
    "- `/brief-scratchpad`",
    "- \"what’s in the dump\"",
    "- \"brief my scratchpad\"",
    "",
  ].join("\n");
}

function renderInboxMarkdown(inbox: readonly InboxItem[]): string {
  if (inbox.length === 0) {
    return "_Nothing here yet._";
  }

  const open = inbox.filter((item) => !item.done);
  const done = inbox.filter((item) => item.done);
  const blocks: string[] = [];

  if (open.length > 0) {
    blocks.push("### Open", "", ...open.map(toNoteBlock));
  }
  if (done.length > 0) {
    if (blocks.length > 0) {
      blocks.push("");
    }
    blocks.push("### Done", "", ...done.map(toNoteBlock));
  }

  return blocks.join("\n");
}

function toNoteBlock(item: InboxItem): string {
  const body: string[] = [`#### <!--id:${item.id}-->`, ""];
  if (item.subject) {
    body.push(`**${item.subject}**`, "");
  }
  if (item.text) {
    body.push(item.text.replace(/\n+$/, ""), "");
  }
  return body.join("\n");
}

function renderFooter(updatedAt: string): string {
  return `_Last synced: ${updatedAt} by scratchpad_`;
}

async function removeLegacySkillDirs(root: string): Promise<void> {
  for (const rel of LEGACY_SKILL_DIRS) {
    await fs.rm(path.join(root, rel), { recursive: true, force: true });
  }
}

async function seedFileIfMissing(filePath: string, contents: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw toError(error);
    }
    await atomicWrite(filePath, contents);
  }
}

async function ensureLocalGitExclude(root: string): Promise<void> {
  const gitDir = await resolveGitDir(root);
  if (!gitDir) {
    return;
  }

  const excludePath = path.join(gitDir, "info", "exclude");
  await fs.mkdir(path.dirname(excludePath), { recursive: true });

  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw toError(error);
    }
  }

  const present = new Set(
    existing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );

  const missing = EXCLUDE_MARKERS.filter((line) => !present.has(line));
  if (missing.length === 0) {
    return;
  }

  let next = existing;
  if (next.length > 0 && !next.endsWith("\n")) {
    next += "\n";
  }
  if (!next.includes("# scratchpad")) {
    next += "\n# scratchpad (local only, not committed)\n";
  }
  next += `${missing.join("\n")}\n`;
  await atomicWrite(excludePath, next);
}

async function resolveGitDir(root: string): Promise<string | undefined> {
  const gitPath = path.join(root, ".git");
  try {
    const stat = await fs.stat(gitPath);
    if (stat.isDirectory()) {
      return gitPath;
    }
    if (!stat.isFile()) {
      return undefined;
    }
    const text = await fs.readFile(gitPath, "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(text);
    if (!match?.[1]) {
      return undefined;
    }
    return path.resolve(root, match[1].trim());
  } catch {
    return undefined;
  }
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, contents, { encoding: "utf8", flag: "wx" });
    try {
      await fs.rename(tempPath, filePath);
    } catch (renameError) {
      const err = toError(renameError);
      const code = (err as NodeJS.ErrnoException).code;
      if (os.platform() === "win32" && (code === "EPERM" || code === "EEXIST")) {
        await fs.copyFile(tempPath, filePath);
        await fs.unlink(tempPath);
        return;
      }
      throw err;
    }
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw toError(error);
  }
}

function createId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
