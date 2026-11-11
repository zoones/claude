# worklog-band

A Claude Code mod for people who book their working time per session with a small `wl` command:
while this session has a worklog interval open, a quiet, right-aligned band above the prompt lets
you change or stop it without typing `wl`.

```
                                                     ⏱ Own ▾  ·  Stop
```

- **Stop** — `wl stop` for this session.
- **Category button** — opens a row of the other categories; picking one asks how to book:
  - **Zeit umbuchen** — `wl amend <category>`: the running entry gets the new category from its start on, comment kept.
  - **Ab jetzt fortsetzen** — `wl <category> "<comment>"`: the running entry ends now, a new one opens with the same comment.
- Keyboard: `ctrl+x tab` focuses the band (the category button first), Enter opens the row, then
  `1`–`9` pick a category in configured order, `u` / `f` (rebook / continue), `a` (cancel). Esc returns to the prompt.

The band reads the worklog every 15 s and after each turn. Where `wl` is not configured, not
executable from the session's project, or there is no worklog configuration, it stays hidden.

## What `wl` has to do

The mod does not book anything itself; it calls your `wl` with the session's first eight id
characters in `CLAUDE_CODE_SESSION_ID`:

| Call | Meaning |
|---|---|
| `wl <CATEGORY> <comment…>` | end the running interval of this session, open a new one |
| `wl amend <CATEGORY>` | change the category of this session's last entry |
| `wl stop` | end the running interval |

Its first output line is shown as a toast. The worklog file has one line per entry:
`ISO_TIMESTAMP|SESSION|CATEGORY|comment`, `STOP` as category for a stop. Lines of other sessions —
including `wl parallel`'s window lines under the pseudo-session `parallel` — are ignored.

## Configure

The categories and the log come from the **worklog configuration** that `wl` reads as well, so the
band always offers exactly what `wl` accepts — `~/.claude/worklog/config.json`:

```json
{
  "log": "~/.claude/worklog/worklog.log",
  "categories": {
    "ACME": { "label": "Acme Corp", "short": "Acme" },
    "BETA": { "label": "Beta Ltd", "short": "Beta" },
    "OWN":  { "label": "Own" }
  }
}
```

Categories in hotkey order (1–9); `label` is shown on the button, `short` in the picker row (both
default to the name). Other keys (`scopes`, `shares`, …) belong to `wl` and are ignored here. Without
the file — or with a broken one — the band stays hidden. It is re-read on every refresh.

Two plugin options, set in `/config` or in the `pluginConfigs` of your settings:

| Option | Meaning | Default |
|---|---|---|
| `wl` | path to the `wl` command; relative = from the session's project root | empty (band off) |
| `config` | the worklog configuration, `~` allowed | `~/.claude/worklog/config.json` |

```json
{
  "pluginConfigs": {
    "worklog-band@zoones": {
      "options": { "wl": "bin/wl" }
    }
  }
}
```

## Develop

```bash
claude plugin validate plugins/worklog-band
claude plugin test plugins/worklog-band
```

The tests stand in for `wl` and the log, so they never touch your real worklog.
