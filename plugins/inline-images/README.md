# inline-images

A Claude Code mod that shows pictures right in the transcript:

- under every `Read` of a picture (screenshots from Chrome/Playwright tests, label renderings, …),
- under your own prompt when you pasted or dropped a picture into it (`[Image #N]`).

The terminal draws PNG only: other formats (JPEG, GIF, WebP, HEIC, TIFF, BMP) are converted with
`sips` (macOS) into `/tmp/claude-inline-images-<uid>/` and redone only when the source is newer.
Without `sips` (Linux) only PNGs show.

Pictures are drawn with the terminal's graphics protocol (kitty), so they appear only in
**Ghostty, kitty and WezTerm**, never inside tmux. Everywhere else (iTerm2, Terminal.app, the desktop
app, VS Code) the mod does nothing at all — no placeholder lines. Force it with
`CLAUDE_INLINE_IMAGES=1` (or off with `0`).

Size: at most 90 × 36 cells and never wider than the terminal, aspect ratio kept. Under each picture an
`↗ open large` link opens the file in the system viewer (Preview on macOS) with a cmd-click.

## How it finds pasted pictures

Claude Code does not hand plugins the bytes of a pasted picture, only that one was pasted. The mod
reads it from the session's temp folder, `<tmp>/claude-<uid>/<project root with / as ->/<session id>/images/N.png`
(`/private/tmp` on macOS, `/tmp` on Linux). If a Claude Code update moves that folder, pasted pictures
silently stop showing; `Read` pictures keep working.

## Install

```
/plugin install inline-images --marketplace https://gitlab.com/zoones.net/oss/claude.git
```

Load it only once — an extra copy through `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS` shows every
picture twice.

## Develop

```bash
claude plugin validate plugins/inline-images
claude plugin test plugins/inline-images
```
