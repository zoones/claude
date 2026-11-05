# live-log

A Claude Code mod that shows the output of Claude's long-running Bash commands live, in a
**Live log** pane beside the chat, so you can see that something is moving.

- Every command Claude starts with `run_in_background` (or that you push to the background with
  Ctrl+B) gets a tab in the pane, and its output streams in while it runs.
- If the command writes to a log file (`> build.log 2>&1`, `&>> run.log`, `| tee -a test.log`),
  the pane follows that file too. A relative path counts from a leading `cd <dir> &&`.
- Tabs at the top: `●` running, `✓` completed, `✗` failed, `■` stopped, `○` ended without a
  notice (no process writes its output any more, e.g. stopped from the tasks list). At most four: running
  commands always get one, ended ones fill what is left, the rest wait behind `+N`. A click or the
  keys `1`–`4` (while the pane has focus) switch between them.
- An ended tab (and one following a file) closes with its `×`, or with **✕ close** (`x`) at the
  bottom for the one shown; a tab waiting behind `+N` moves up.
- The wheel or the arrow keys scroll back through the last 2000 lines per command; the tabs and the
  bottom line stay put. At the bottom the pane follows new lines; scrolled up, the bottom line says
  how far (`↑ 40 lines above the end`) and **↓ End** (or `e`) jumps back.
- Colour codes are stripped, and progress bars that redraw their line with `\r` show as one line.
- `/live-log` opens the pane; `/live-log path/to/file.log` follows any file, e.g. the log of a
  process you started yourself.

## How Claude learns to use it

With the first prompt of a session (and again after a compaction) the mod tells Claude that the
pane exists and to run anything longer than about 30 seconds — builds, test suites, installs,
imports, dev servers — in the background, unbuffered (`python -u`, `stdbuf -oL`, …), with a log
file when the output should be kept, and then to wait for the completion notice instead of polling.

## Notes

- The pane opens by itself when a background command starts and the terminal is at least 144
  columns wide; below that a toast points to `/live-log`.
- It reads the files every half second; the full output always stays in the files on disk.
- Background commands of subagents are not shown.
- A stopped command gets no completion notice from Claude Code: the mod ends its tab when Claude
  stops it (`TaskStop`), and otherwise checks every 3 seconds with `lsof` whether any process
  still holds the command's output file.
- macOS and Linux (`tail`, `head`, `sh`, `lsof`).

## Install

```
/plugin install live-log --marketplace https://gitlab.com/zoones.net/oss/claude.git
```

## Develop

```bash
claude plugin validate plugins/live-log
claude plugin test plugins/live-log
```
