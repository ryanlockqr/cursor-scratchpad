import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface InboxItem {
  readonly id: string;
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
export const MAX_INBOX_ITEMS = 500;

/** Source of truth for the thought dump. Hidden from explorer; stays off git. */
export const DUMP_REL = ".cursor/scratchpad.md";
/** Cursor rule — local to this machine. Visible in the tree; not committed. */
const RULE_REL = ".cursor/rules/scratchpad.mdc";
const ORGANIZE_SKILL_DIR = ".cursor/skills/organize-scratchpad";
const RULES_FROM_NOTES_SKILL_DIR = ".cursor/skills/rules-from-scratchpad";
const BRIEF_SKILL_DIR = ".cursor/skills/brief-scratchpad";
const UPDATE_SKILL_DIR = ".cursor/skills/update-scratchpad";
const ORGANIZE_SKILL_REL = `${ORGANIZE_SKILL_DIR}/SKILL.md`;
const RULES_FROM_NOTES_SKILL_REL = `${RULES_FROM_NOTES_SKILL_DIR}/SKILL.md`;
const BRIEF_SKILL_REL = `${BRIEF_SKILL_DIR}/SKILL.md`;
const UPDATE_SKILL_REL = `${UPDATE_SKILL_DIR}/SKILL.md`;

const EXCLUDE_MARKERS = [
  DUMP_REL,
  RULE_REL,
  `${ORGANIZE_SKILL_DIR}/`,
  `${RULES_FROM_NOTES_SKILL_DIR}/`,
  `${BRIEF_SKILL_DIR}/`,
  `${UPDATE_SKILL_DIR}/`,
];
const CHECKBOX_RE = /^- \[([ xX])\]\s+(.+?)(?:\s+<!--id:([^\s>]+)-->)?\s*$/;
const NOTE_HEADING_RE = /^####\s+<!--id:([^\s>]+)-->\s*$/;
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
    await fs.mkdir(path.dirname(path.join(root, RULES_FROM_NOTES_SKILL_REL)), {
      recursive: true,
    });
    await fs.mkdir(path.dirname(path.join(root, BRIEF_SKILL_REL)), { recursive: true });
    await fs.mkdir(path.dirname(path.join(root, UPDATE_SKILL_REL)), { recursive: true });
    await ensureLocalGitExclude(root);
    await seedFileIfMissing(path.join(root, DUMP_REL), renderDump(EMPTY_STATE));
    await atomicWrite(path.join(root, RULE_REL), renderRule());
    await atomicWrite(path.join(root, ORGANIZE_SKILL_REL), renderOrganizeSkill());
    await atomicWrite(path.join(root, RULES_FROM_NOTES_SKILL_REL), renderRulesFromNotesSkill());
    await atomicWrite(path.join(root, BRIEF_SKILL_REL), renderBriefSkill());
    await atomicWrite(path.join(root, UPDATE_SKILL_REL), renderUpdateSkill());
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

export function createInboxItem(text: string): InboxItem {
  const trimmed = sanitizeUserText(text);
  if (trimmed.length === 0) {
    throw new SyncError("Dumped thoughts cannot be empty.");
  }

  return {
    id: createId(),
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

  const text = sanitizeUserText(current.lines.join("\n"));
  if (text.length === 0) {
    return;
  }

  let id = current.id;
  if (!id || seen.has(id)) {
    id = stableIdFor(text, current.done, inbox.length);
  }
  seen.add(id);

  inbox.push({
    id,
    text,
    done: current.done,
    createdAt: updatedAt,
  });
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
    "- When asked to organize, triage, clean up, or prioritize the dump, use `/organize-scratchpad`.",
    "- When asked what’s in the dump or for a briefing, use `/brief-scratchpad`.",
    "- When asked to prune or update the dump (what to keep vs drop), use `/update-scratchpad`.",
    "- When asked to turn dump notes into Cursor rules, use `/rules-from-scratchpad`.",
    "",
  ].join("\n");
}

function renderOrganizeSkill(): string {
  return [
    "---",
    "name: organize-scratchpad",
    "description: >-",
    "  Triages and rewrites the project thought dump at .cursor/scratchpad.md.",
    "  Use when the user asks to organize, triage, clean up, prioritize, cluster,",
    "  or make sense of scratchpad / the thought dump.",
    "disable-model-invocation: true",
    "---",
    "",
    "# Organize Scratchpad",
    "",
    "## When to use",
    "",
    "Only when the human asks to organize or triage the thought dump. Do not run this unprompted mid-task.",
    "",
    "## Instructions",
    "",
    "1. Read `.cursor/scratchpad.md` — it is the source of truth.",
    "2. Keep every open item that still matters. Drop or mark done only what is clearly obsolete or already finished.",
    "3. Rewrite the file cleanly:",
    "   - Keep the `# Scratchpad` title and a one-line purpose blurb.",
    "   - Use `### Open` and `### Done` sections.",
    "   - Each note is a `#### <!--id:...-->` heading, then the note body as normal markdown.",
    "   - Preserve `<!--id:...-->` on the heading.",
    "4. Do not invent new work. Do not expand dump items into a new project plan unless asked.",
    "5. After rewriting, briefly tell the human what you changed (counts moved, removed, or grouped).",
    "",
    "## Examples",
    "",
    "- \"organize my scratchpad\"",
    "- \"triage the dump\"",
    "- `/organize-scratchpad`",
    "",
  ].join("\n");
}

function renderRulesFromNotesSkill(): string {
  return [
    "---",
    "name: rules-from-scratchpad",
    "description: >-",
    "  Reads the thought dump in .cursor/scratchpad.md and drafts Cursor rules for",
    "  this repo. Use when the user asks to create rules from notes, turn the dump",
    "  into rules, or mine scratchpad / the thought dump for .cursor/rules.",
    "disable-model-invocation: true",
    "---",
    "",
    "# Rules from Scratchpad",
    "",
    "## When to use",
    "",
    "Only when invoked (`/rules-from-scratchpad`) or the human asks to create Cursor rules from the thought dump. Do not invent a ruleset unprompted. Always ask which candidates to keep.",
    "",
    "## Instructions",
    "",
    "1. Read `.cursor/scratchpad.md` (open items matter; skip done unless relevant).",
    "2. List existing `.cursor/rules/**/*.mdc`. Ignore `scratchpad.mdc` (dump guard). Do not write `AGENTS.md`, User Rules, or Team Rules — only **project** `.mdc` files.",
    "3. Split notes into rule-shaped vs not. **Not rules:** one-off tasks, ideas, bugs, reminders, style-guide dumps. Prefer a linter over a style rule.",
    "4. **Ask before writing.** Show a short numbered list of candidates (only rule-shaped notes). For each: one-line restatement, suggested `kebab-case.mdc` name, and a recommended apply type:",
    "   - **Always Apply** (`alwaysApply: true`) — rare. Whole-repo agent behavior.",
    "   - **Apply to Specific Files** (`alwaysApply: false` + `globs`) — matching paths.",
    "   - **Apply Intelligently** (`alwaysApply: false` + `description`, no globs) — default.",
    "   - **Apply Manually** (`alwaysApply: false`, no description, no globs) — `@`-mention only.",
    "   Ask: which of these should become rules? Numbers, \"all\", \"none\", or a tweak (name / apply type) are fine.",
    "   Use the ask-questions tool if available. Do not create files until they pick.",
    "5. After they choose, create only those rules with `/create-rule` so frontmatter is valid `.mdc`.",
    "   - Reference files with `@path` instead of pasting dump text.",
    "   - Do not overwrite existing rules unless asked. Never overwrite `scratchpad.mdc`.",
    "   - Do **not** git-exclude these files — they are version-controlled project rules.",
    "6. Do not empty the dump. Optionally mark only chosen notes as done, preserving `<!--id:...-->`.",
    "7. Tell them what you wrote, the apply type of each, and what stayed as tasks.",
    "",
    "## Examples",
    "",
    "- `/rules-from-scratchpad`",
    "- \"create rules from my notes\"",
    "- \"turn the dump into cursor rules\"",
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
    "   - Themes (a few groups), each with one-line note titles — not full bodies.",
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

function renderUpdateSkill(): string {
  return [
    "---",
    "name: update-scratchpad",
    "description: >-",
    "  Reviews the thought dump: what’s there, what can be dropped or marked done.",
    "  Use when the user asks to update, prune, clean out, or drop stale scratchpad",
    "  / dump notes. Ask before deleting. Do not start new work from the dump.",
    "disable-model-invocation: true",
    "---",
    "",
    "# Update Scratchpad",
    "",
    "## When to use",
    "",
    "Only when invoked (`/update-scratchpad`) or the human asks to prune/update the dump. Do not run unprompted. For a read-only overview use `/brief-scratchpad`. For a full rewrite/group use `/organize-scratchpad`.",
    "",
    "## Instructions",
    "",
    "1. Read `.cursor/scratchpad.md`. List open notes as short titles (not full bodies).",
    "2. Flag what looks droppable: already shipped, duplicates, empty rambles, one-off tasks that are done, notes that belong in a rule/skill instead.",
    "3. **Ask before changing the file.** Numbered list: keep / mark done / delete. They pick numbers, \"delete all flagged\", or \"none\".",
    "4. After they pick, rewrite `.cursor/scratchpad.md` only for those actions. Keep `# Scratchpad`, Open/Done, `#### <!--id:...-->` notes, ids on keepers.",
    "5. Do not invent new notes. Do not turn this into a project plan.",
    "6. Say what you removed, marked done, and left open.",
    "",
    "## Examples",
    "",
    "- `/update-scratchpad`",
    "- \"what can I drop from the dump\"",
    "- \"update my scratchpad\"",
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
  return [`#### <!--id:${item.id}-->`, "", item.text.replace(/\n+$/, ""), ""].join("\n");
}

function renderFooter(updatedAt: string): string {
  return `_Last synced: ${updatedAt} by scratchpad_`;
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
