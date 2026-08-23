# Cursor Scratchpad

[![Open VSX](https://img.shields.io/open-vsx/v/ryanlockqr/scratchpad)](https://open-vsx.org/extension/ryanlockqr/scratchpad)
[![CI](https://github.com/ryanlockqr/cursor-scratchpad/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanlockqr/cursor-scratchpad/actions/workflows/ci.yml)

Dump the thought. Keep coding.

Cursor moves fast, so extra thoughts show up mid-task. Put them in the thought dump so you don’t lose them — come back later, and the agent can read it when you ask.

## Usage

Open the Scratchpad icon in the activity bar.

| You do | What happens |
| --- | --- |
| Type or paste a note, press **Enter** | Adds it to the thought dump (`Shift+Enter` for a new line) |
| Click a note | Edit it (`⌘/Ctrl+Enter` saves) |
| Done or Remove | Archive it or drop it |
| `/organize-scratchpad` | Triage the dump |
| `/brief-scratchpad` | Short briefing — no rewrite |
| `/update-scratchpad` | What’s there, what to drop — asks first |
| `/rules-from-scratchpad` | Pick notes to turn into project rules |

Command Palette: Quick Dump, Clear Dump.

## How it works

| Path | Role | Local |
| --- | --- | --- |
| `.cursor/scratchpad.md` | Thought dump | Hidden in explorer; off git |
| `.cursor/rules/scratchpad.mdc` | Don’t chase the thought dump | Visible; off git |
| `.cursor/skills/organize-scratchpad/SKILL.md` | Triage the dump | Visible; off git |
| `.cursor/skills/brief-scratchpad/SKILL.md` | Brief the dump | Visible; off git |
| `.cursor/skills/update-scratchpad/SKILL.md` | Prune the dump | Visible; off git |
| `.cursor/skills/rules-from-scratchpad/SKILL.md` | Draft repo rules from notes | Visible; off git |

Written when you open a folder with the extension. Listed in `.git/info/exclude`, not `.gitignore`. Rules you create from notes are normal project files and can be committed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for develop and release steps.

## License

MIT. See [LICENSE](LICENSE).
