# Contributing

## Develop

```bash
npm install
```

Press **F5** to launch an Extension Development Host. Open a folder, dump a thought, and confirm `.cursor/scratchpad.md` is hidden, the rule and skills are visible, and dump/rule/skills are listed in `.git/info/exclude`.

```bash
npm run lint
npm run package
```

## Release

After a version lands on `main`, tag it. GitHub Actions packages the VSIX, publishes to Open VSX, and attaches the build to the GitHub release.

```bash
git tag v0.1.11
git push origin v0.1.11
```

Tag must match `package.json` `version`.

### First-time Open VSX setup

1. Create publisher `ryanlockqr` on [Open VSX](https://open-vsx.org/).
2. Store `OVSX_PAT` as a GitHub Actions secret.
3. Create the namespace once:

```bash
npx ovsx create-namespace ryanlockqr -p "$OVSX_PAT"
```
