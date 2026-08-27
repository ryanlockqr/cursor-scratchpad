# Cursor Scratchpad

[![Open VSX](https://img.shields.io/open-vsx/v/ryanlockqr/scratchpad)](https://open-vsx.org/extension/ryanlockqr/scratchpad)
[![CI](https://github.com/ryanlockqr/cursor-scratchpad/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanlockqr/cursor-scratchpad/actions/workflows/ci.yml)

Dump the thought. Keep coding.

Cursor moves fast, so extra thoughts show up mid-task. Put them in the thought dump so you don’t lose them — come back later, and the agent can read it when you ask.

## Usage

Open the Scratchpad icon in the activity bar.

| You do | What happens |
| --- | --- |
| Type or paste a note, press **Enter** | Adds it to the thought dump (`Shift+Enter` for a new line). Optional subject is stored as bold markdown |
| Click a note | Opens it in a tab to edit (list shows subject only) |
| Remove | Drop it |
| `/organize-scratchpad` | Regroup, add subjects, prune or mark done — asks first |
| `/brief-scratchpad` | Short briefing — no rewrite |

Command Palette: Quick Dump, Clear Dump.

## How it works

| Path | Role | Local |
| --- | --- | --- |
| `.cursor/scratchpad.md` | Thought dump | Hidden in explorer; off git |
| `.cursor/rules/scratchpad.mdc` | Don’t chase the thought dump | Visible; off git |
| `.cursor/skills/organize-scratchpad/SKILL.md` | Organize / prune the dump | Visible; off git |
| `.cursor/skills/brief-scratchpad/SKILL.md` | Brief the dump | Visible; off git |

Written when you open a folder with the extension. Listed in `.git/info/exclude`, not `.gitignore`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for develop and release steps.

## License

MIT. See [LICENSE](LICENSE).
