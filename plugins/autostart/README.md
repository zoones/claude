# autostart

Runs the `AUTOSTART.md` of the directory Claude Code starts in as the session's first prompt.

```markdown
<!-- AUTOSTART.md -->
Ask me with AskUserQuestion what I want to do:
- "New document in 00_Eingang": file the newest document there
- "Scan from the flatbed scanner": scan a page and file it
- "Nothing": do nothing
Then do it.
```

## Trust

A cloned repository must not be able to prompt Claude just by being opened. So the first time a
directory has an `AUTOSTART.md` (and every time the file changes) the mod only shows a hint; type
`/autostart` to run the file now and trust exactly this text for that directory. From then on it runs
by itself at the start of each new session there.

No `AUTOSTART.md` yet? `/autostart` in that directory has Claude ask what should happen at the start
and write the file for you; then `/autostart` once more to try and trust it.

It runs once per session: not again on `--resume`/`--continue` of a session that already ran it, and
not in `claude -p` runs. The prompt goes through the normal permission checks like any typed prompt.

## Install

```
/plugin install autostart --marketplace https://gitlab.com/zoones.net/oss/claude.git
```
