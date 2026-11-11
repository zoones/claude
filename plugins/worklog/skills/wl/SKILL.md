---
name: wl
description: "Log the debitable scope of the current work to the worklog. Invoke with /wl <category> [comment] (categories: wl config), /wl stop, /wl to show today's entries, /wl parallel, or /wl setup to verify the configuration and status line."
---

# /wl — worklog entry

Thin wrapper around `wl` (the plugin's `bin/wl`, on the Bash tool's PATH while the plugin is enabled). Execute it
with the given arguments and report the result in ONE line — no extra commentary, no follow-up questions.

**Per-session**: each line is stamped with the Claude session id (`CLAUDE_CODE_SESSION_ID`, first 8 chars), so
concurrent tabs keep independent timelines. Within a session a new entry closes that same session's previous one;
`stop` closes only this session. The context hook reports the active category for *this* tab only.

**Categories and billing scopes are configuration, not code**: `~/.claude/worklog/config.json` (override
`WL_CONFIG`). `wl config` shows what applies — or, without a file, an example to start from.

## Argument handling

The arguments are: an optional first token (category or subcommand) plus an optional free-text comment. Map them to a
single call:

- `/wl` (no args) → `wl` (shows today's entries; print them as a short fenced block)
- `/wl stop` → `wl stop` (closes at the last activity, see below — pass `--now`, `--at HH:MM` or `--ago 20m` straight
  through when the user names a different end)
- `/wl amend [-N] [--at HH:MM] <category> [comment]` → `wl amend [-N] [--at HH:MM] <category> "comment"`
  (with `--at` the category may be omitted: the line is only re-timed; rebooks an entry already written instead of
  opening a new interval — see below)
- `/wl config` → `wl config`; `/wl help` → `wl help`
- `/wl push <file>` / `/wl test` / `/wl booked [FROM [TO]]` → the same `wl` call (the optional booking backend:
  sends /worktime's intervals to a time-tracking instance, checks the connection, reads back what is booked)
- `/wl setup` → run the setup verification below and report/fix what's missing
- `/wl <category> rest of the words...` → `wl <category> "rest of the words..."` (first token is a category of the
  configuration or one of its aliases — everything after it is ONE comment argument, quoted)
- `/wl acme=60,own=40 rest...` → `wl acme=60,own=40 "rest..."` — an explicit split for work that follows no
  category's usual split: percent per billing scope (the config's `scopes` — scopes, not categories), adding up to
  100; `acme,own` without numbers splits evenly. Also valid in `amend`. Use it when the user states a split ("60%
  Acme, 40% own"); `wl` refuses an invalid one (exit 2) and writes nothing — report that instead of guessing a
  corrected split.
- `/wl <category> --at HH:MM rest...` → `wl <category> --at HH:MM "rest..."` — the switch happened earlier ("since
  14:00 this is Acme"). Only after this session's last entry; an earlier point is `amend --at`.
- `/wl parallel --from HH:MM [--to HH:MM] rest...` → `wl parallel --from HH:MM [--to HH:MM] "rest..."` — the user
  worked in two sessions at once ("that ran in parallel from 14:00"): run it in the session that was open
  throughout — it shares the window evenly with every session STARTING an entry within it, in /worktime, instead of
  both being booked in full. `--to` defaults to now. This is the ONLY way to record such a decision — never keep it
  in a memory note instead.

If the first token is not a known category, share split or subcommand, run `wl help` and show it.

## Closing an interval (`stop`) — never stamp "now" blindly

`wl stop` closes at this session's **last activity plus at most 3 minutes of reading** (`WL_READ_TAIL`, seconds),
not at the second the command runs, and reports the idle tail it dropped. A cap, not a threshold: a threshold books
a gap just under it in full and one just over it not at all. The asymmetry is the reason: `/worktime` and a booking
import reconstruct a *missing* stop from activity evidence, but they trust a *declared* end unconditionally — so a
stop typed 40 minutes after the work ended bills those minutes for good, while saying nothing at all would have
been repaired.

Activity is stamped by the plugin's `wl-activity-hook` on `PostToolUse` (work with tools) and on `Stop` (a turn that
produced only an answer — a design discussion is work too), into `~/.claude/worklog/activity/`. The user's **prompt
is deliberately not stamped**: `UserPromptSubmit` fires before the turn runs, so the message asking for the stop
would be the freshest activity and the clip could never engage.

The script handles the common case on its own; what it needs from you:

- The user names an end ("until 17:00", "I was gone from half past five") → `--at 17:00` / `--ago 45m`; for a past
  day give the date: `--at 2026-08-25 17:00`. Never hand-edit the log — every correction has a flag, and a
  hand-written stamp that does not parse breaks every reader of the log.
- The work happened **outside** this session (IDE, meeting, phone) → `--now`. The stamps only see this session, so
  an auto-close would clip that work away. The script's own guard covers the extreme case (nothing stamped since the
  interval started → keeps the interval and says so), but half an hour of IDE work after the last tool call is
  invisible to it.
- The script says `no activity data for this session` → the plugin's hooks are not loaded (they load at session
  start; a session started before the plugin was enabled has none). Mention it.

## Rebooking (`amend`)

When work already logged turns out to belong to a different category ("book that on Acme please"), `amend` rewrites
the existing line in place — same timestamp, same session, so the interval keeps its length and `/worktime` sees the
corrected category. A new `wl <category>` entry would instead split the time at "now" and leave the earlier stretch
on the wrong category.

- `wl amend acme` — this session's LAST entry, comment unchanged
- `wl amend acme "new label"` — category and comment
- `wl amend -2 acme` — the entry before it; `-N` counts back over this session's own lines, `stop` lines included
- `wl amend -2 --at 09:55` — **re-time** an entry (a stop written too late), category and comment kept;
  `wl amend --at 09:55 acme` re-times and rebooks in one go. Refused (exit 2, log untouched) when the time is in the
  future or outside the session's neighbouring entries. This — never a hand edit of the log — is how a wrong
  timestamp gets corrected.

Only lines of the current session are reachable. If the entry to fix is older than the current session (different
tab, previous day), say so instead of guessing — `-N` cannot cross sessions.

## After logging

Confirm with the echoed line from the script (e.g. `wl: OWN — coverage tooling`). The band above the prompt and a
status line using `wl-statusline` pick the change up by themselves. If the new category obviously contradicts what
this session is currently doing, say so in the same line — one sentence, no lecture.

## Setup — what makes the system work

The plugin brings `wl`, its hooks (activity stamps, the active category in the model's context), the band above the
prompt and `/worktime`. What it cannot bring:

1. **The configuration** — `~/.claude/worklog/config.json` (override `WL_CONFIG`): the log file, the billing scopes,
   the categories (aliases, band label/short, shares, describe, subject keywords), and for `/worktime` the author and
   the repos to scan. Without it `wl` refuses any category, the band stays hidden, and `wl config` prints an example.
2. **A status line** (optional) — a plugin cannot set it. The plugin keeps stable shims in `~/.claude/worklog/bin/`
   (rewritten on every session start to point at the installed version): call `wl-statusline` from your own status
   line script with the status line's JSON on stdin, or point `statusLine` at a script that does:
   ```bash
   input=$(cat)
   printf '%s' "$input" | ~/.claude/worklog/bin/wl-statusline
   ```
3. **`wl` in a plain terminal** (optional) — `~/.claude/worklog/bin` on your PATH, or `alias wl=~/.claude/worklog/bin/wl`.

### `/wl setup` verification procedure

Check each piece and report a short OK/missing list; offer to fix what's missing (never overwrite existing settings):

- `jq` is on the PATH
- `wl config` resolves a configuration (not the example) and names the log the user expects
- `~/.claude/worklog/bin/wl` and `~/.claude/worklog/bin/wl-statusline` exist (written at session start)
- `~/.claude/worklog/activity/` has a file for the current session (proves the activity hook fires; it appears after
  the first tool call of a session started with the plugin enabled)
- if the user wants it in the status line: their `statusLine` script calls `wl-statusline`
- no second copy of the hooks in the user's own settings (an old `wl-activity-hook` / `wl-context-hook` entry would
  run twice and, from an old path, stamp a folder `wl` no longer reads)
