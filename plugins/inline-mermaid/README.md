# inline-mermaid

A Claude Code mod that draws Mermaid diagrams right in the transcript:

- under Claude's reply, for every closed ` ```mermaid ` block in it (a block still streaming waits
  until its fence closes),
- under `Read`, `Write` and `Edit` of a `.mmd` / `.mermaid` file (the whole diagram),
- under `Read`, `Write` and `Edit` of Markdown (`.md`) with ` ```mermaid ` blocks — only the
  blocks the call touched: what `Read` read (its `offset`/`limit` lines), what `Write` wrote, and
  for `Edit` the blocks the new text now stands in. Editing one step of a long process document
  shows that one diagram, not all twenty. At most 4 diagrams are drawn under one row; a line names
  the rest.

Under each diagram an `↗ open large` link opens the PNG in the system viewer (Preview on macOS)
with a cmd-click.

A syntax error shows as one dim line (`mermaid: Parse error on line 2: …`) instead of a picture.

## Needs

[`mmdc`](https://github.com/mermaid-js/mermaid-cli) on the `PATH` Claude Code was started with:

```bash
npm install -g @mermaid-js/mermaid-cli
```

Without it the mod writes `mermaid: mmdc did not run: …` under each diagram.

## How it draws

mmdc takes a second or two per diagram, so it never runs inside a draw: the row first says
`mermaid: drawing diagram…`, mmdc renders in the background and the row is drawn again with the
picture. Pictures (and errors) are cached by a hash of theme and diagram text in
`/tmp/claude-inline-mermaid-<uid>/`, so a redraw or the same diagram elsewhere is instant. Files
older than 30 days are deleted when a session starts.

Size: about 6 CSS pixels per column, at most 100 × 40 cells and never wider than the terminal,
aspect ratio kept. Tall state diagrams hit the 40 rows; `direction LR` in the diagram helps.

Theme: follows the macOS appearance, which Ghostty (`theme = light:…,dark:…`), kitty and WezTerm
follow too — `dark` in dark mode, `default` in light mode, on a transparent background. It is looked
at again every minute, so diagrams are drawn anew when the Mac switches at dusk. Without macOS
(Linux) it is `dark`. A terminal with a fixed look that differs from the system's: set
`CLAUDE_INLINE_MERMAID_THEME` to `dark`, `default`, `forest` or `neutral`.

Like `inline-images`, it draws only in **Ghostty, kitty and WezTerm**, never inside tmux, and does
nothing elsewhere. Force it with `CLAUDE_INLINE_MERMAID=1` (or off with `0`).

## Install

```
/plugin install inline-mermaid --marketplace https://gitlab.com/zoones.net/oss/claude.git
```

## Develop

```bash
claude plugin validate plugins/inline-mermaid
claude plugin test plugins/inline-mermaid
```
