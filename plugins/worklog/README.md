# worklog

Book your working time per Claude Code session — and get it billed right.

- **`wl`** — declare what you are working on right now: `wl acme "order export"`, `wl stop`, `wl amend own`,
  `wl acme=60,own=40 "cutover"`, `wl parallel --from 14:00 "support"`. One line per entry in a plain log, tagged with
  the session, so concurrent tabs keep their own timelines. Claude calls it itself; `/wl` wraps it.
- **Activity stamps** — every tool call and every finished turn stamps the session's last activity, so `wl stop`
  closes at the last real work instead of at the moment somebody remembered to type it. A late stop bills idle time
  for good; a missing one can be repaired — so the stop errs early.
- **The active category in Claude's context** — every prompt carries the session's current category, and Claude
  says so when the work drifts away from it.
- **A band above the prompt** — `⏱ Own ▾ · Stop`: switch the category from now on or rebook the whole interval,
  stop it, without typing `wl` (`ctrl+x tab` focuses it, digits pick, `u`/`f` rebook/continue).
- **`/worktime`** — turns the log, your own keystrokes in the session transcripts, git commits of all configured
  repos, IDE and build logs into per-day intervals per category, plus a booking view per billing scope. Parallel
  sessions are never booked twice: `wl parallel` declares a shared window, any other overlap is put to you.
- **Optional booking backend** — `wl push` / `wl booked` send the synthesis to a Zoones time-tracking instance and read
  back what is booked there.

## Install

```
/plugin marketplace add https://gitlab.com/zoones.net/oss/claude
/plugin install worklog@zoones
```

Needs `jq`, `python3` and `git`.

## Configure

Everything about your clients lives in one file, `~/.claude/worklog/config.json` (override with `WL_CONFIG`) —
the scripts know none. `wl config` shows what applies, or prints this example when there is no file yet:

```json
{
  "log": "~/.claude/worklog/worklog.log",
  "author": "Your Name",
  "repos": [
    { "path": "~/projects/app", "name": "APP",
      "pathHints": { "clients/acme": "ACME" },
      "buildLogs": ["/tmp/app-*.log"] }
  ],
  "scopes": ["ACME", "OWN"],
  "categories": {
    "ACME": { "label": "Acme Corp", "short": "Acme", "keywords": ["acme"], "shares": { "ACME": 1 },
              "describe": "work for Acme only" },
    "OWN":  { "label": "Own", "shares": { "OWN": 1 }, "describe": "not debitable: tooling, infrastructure" },
    "BOTH": { "label": "Acme + own", "short": "A+O", "aliases": ["A+O"], "shares": { "ACME": 1, "OWN": 1 },
              "describe": "product work usable by Acme and ourselves", "default": true }
  },
  "rounding": { "granularityMinutes": 15, "leftoverTo": "OWN" }
}
```

| Key | Used by | Meaning |
|---|---|---|
| `log` | all | the worklog file (default `~/.claude/worklog/worklog.log`; `WL_LOG` overrides) |
| `scopes` | wl, /worktime | the billing scopes an explicit split may name (`wl acme=60,own=40`) |
| `categories` | all | what an entry is booked to, in the band's hotkey order |
| `…label` / `short` | band | the button / the picker row |
| `…aliases` | wl | other names `wl` takes for the category |
| `…shares` | /worktime | how the category fans out to the scopes |
| `…describe`, `default` | /worktime | what belongs there; the fallback category |
| `…keywords` | /worktime | commit subjects naming one of these words are tagged with the category |
| `author`, `repos` | /worktime | whose commits, in which repos (`pathHints` tag files, `name` tags the rest, `buildLogs` globs); without `repos` the current repo |
| `rounding` | /worktime | booking granularity and where the leftover quarter-hour goes |

### Status line and plain terminal

A plugin cannot set the status line. On every session start the plugin keeps stable shims in
`~/.claude/worklog/bin/` pointing at its installed version — use them from your own status line script, and put
the folder on your `PATH` (or alias `wl`) to use `wl` outside Claude:

```bash
input=$(cat)
printf '%s' "$input" | ~/.claude/worklog/bin/wl-statusline     # ⏱ WL: ACME — order export (09:12)
```

## The log

```
2026-11-11T09:12:00+0100|1a2b3c4d|ACME|order export
2026-11-11T11:40:00+0100|1a2b3c4d|STOP|
2026-11-11T14:00:00+0100|parallel|PARALLEL|2026-11-11T15:12:00+0100|1a2b3c4d|support call
```

`ISO_TIMESTAMP|SESSION|CATEGORY|comment`; each entry ends the session's previous interval, `STOP` ends without
opening. `wl parallel` writes its window under the pseudo-session `parallel`, so no reader takes it for an open
interval. Never edit the log by hand — `wl amend` rebooks and re-times entries.

## Develop

```bash
plugins/worklog/tests/wl.tests.sh          # wl, its hooks, status line, shims (throwaway log and config)
claude plugin test plugins/worklog         # the band
claude plugin validate plugins/worklog
```
