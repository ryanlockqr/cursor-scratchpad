# Cursor Scratchpad

[![Open VSX](https://img.shields.io/open-vsx/v/ryanlockqr/scratchpad)](https://open-vsx.org/extension/ryanlockqr/scratchpad)
[![CI](https://github.com/ryanlockqr/cursor-scratchpad/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanlockqr/cursor-scratchpad/actions/workflows/ci.yml)

Park the thought. Keep coding.

A Cursor sidebar for dumping stray ideas as you work. Chuck thoughts in. Stay on the task. Ask the agent to organize the dump when you want.

## Why

Mid-task ideas pull focus. Dump them here instead of chasing them. The agent is told not to chase the dump — and can triage it when you ask.

Per project, per machine. Anyone with the extension gets the dump, guard rule, and skills locally. They stay off git, so people without the extension never see them.

## Usage

Open the Scratchpad icon in the activity bar.

| You do | What happens |
| --- | --- |
| Type a thought, press **Enter** | Appends `- [ ]` to the dump |
| Check or Remove | Mark done or drop it |
| Ask `/organize-scratchpad` (or organize / triage the dump) | Uses the `organize-scratchpad` skill |
| Ask `/rules-from-scratchpad` (or create rules from notes) | Uses the `rules-from-scratchpad` skill |

Command Palette: Quick Dump, Clear Dump.

## How it works

| Path | Role | Local |
| --- | --- | --- |
| `.cursor/scratchpad.md` | Parked thoughts | Hidden in explorer; off git |
| `.cursor/rules/scratchpad.mdc` | Don’t chase parked thoughts | Visible; off git |
| `.cursor/skills/organize-scratchpad/SKILL.md` | Triage the dump on request | Visible; off git |
| `.cursor/skills/rules-from-scratchpad/SKILL.md` | Draft repo rules from dump notes | Visible; off git |

These are written when you open a folder with the extension. They go in `.git/info/exclude` (not `.gitignore`). Rules the agent **creates from notes** live in `.cursor/rules/` as normal project files and can be committed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for develop and release steps.

## License

MIT. See [LICENSE](LICENSE).
