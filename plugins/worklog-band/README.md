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

The band reads the worklog every 15 s and after each turn. Where `wl` is not configured, or not
executable from the session's project, it stays hidden.

## What `wl` has to do

The mod does not book anything itself; it calls your `wl` with the session's first eight id
characters in `CLAUDE_CODE_SESSION_ID`:

| Call | Meaning |
|---|---|
| `wl <CATEGORY> <comment…>` | end the running interval of this session, open a new one |
| `wl amend <CATEGORY>` | change the category of this session's last entry |
| `wl stop` | end the running interval |

Its first output line is shown as a toast. The worklog file has one line per entry:
`ISO_TIMESTAMP|SESSION|CATEGORY|comment`, `STOP` as category for a stop.

## Configure

Three options, set in `/config` or in the `pluginConfigs` of your settings:

| Option | Meaning | Default |
|---|---|---|
| `wl` | path to the `wl` command; relative = from the session's project root | empty (band off) |
| `log` | the worklog file `wl` writes, `~` allowed | `~/.worklog.log` |
| `categories` | comma-separated, in hotkey order: `CATEGORY`, `CATEGORY=Label` or `CATEGORY=Label\|Short` (Label on the button, Short in the row) | empty |

```json
{
  "pluginConfigs": {
    "worklog-band@zoones": {
      "options": {
        "wl": "bin/wl",
        "log": "~/.worklog.log",
        "categories": "ACME=Acme Corp|Acme, BETA=Beta Ltd|Beta, OWN=Own"
      }
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
