# Changelog

## [0.1.4] - 2026-08-23

- Add `rules-from-scratchpad`: list dump notes, ask which to make project rules, then `/create-rule`
- Slash-only organize/rules skills (`disable-model-invocation`)

## [0.1.3] - 2026-08-23

- Keep dump, rule, and skill per machine (local git exclude); dump stays hidden in explorer

## [0.1.2] - 2026-08-21

- Slim marketplace README; move develop/release docs to CONTRIBUTING.md

## [0.1.1] - 2026-08-21

- Marketplace / UI name: **Cursor Scratchpad**

## [0.1.0] - 2026-08-18

- Scratchpad sidebar: Enter parks a thought as `- [ ]` while you work
- Dump file `.cursor/scratchpad.md` is the source of truth (sidebar reads/writes/watches it)
- Dump is hidden from explorer; sidebar is the UI
- Stable always-on rule: don’t chase parked thoughts
- `organize-scratchpad` skill for triage when asked
- Keep the dump off git via local `.git/info/exclude` (does not change `.gitignore`)
- Command Palette dump / clear commands
