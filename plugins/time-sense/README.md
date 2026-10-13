# time-sense

A Claude Code mod that gives Claude a sense of time. Claude Code tells the model only the date the
session started, never the time, and prompts carry no timestamps. Claude therefore guesses at
"yesterday", "in a week" or "this evening", and the guess is wrong in sessions that run long or are
resumed.

The mod adds one line to every prompt. The model reads it, you never see it:

```
Current local time: Tuesday, 2026-10-13 14:32 (Europe/Vienna, UTC+02:00), ISO week 42; previous prompt 4 min ago. …
```

- **Weekday + ISO week**: "tomorrow", "next Monday" and "end of the week" resolve correctly.
- **Time zone + offset**: "tonight" and "this morning" fit where you are.
- **Time since the previous prompt**: whether that build ran a minute ago or two days ago. The
  mod remembers it per session across restarts and `--resume` (sessions idle for 30 days are
  forgotten).

It adds about 50 tokens per prompt. The line goes in the prompt's context, not the system prompt,
so prompt caching is unaffected.

The time zone is the machine's own. Set `CLAUDE_TIME_SENSE_TZ` (an IANA name such as
`America/New_York`) to override it; an unknown name falls back to the machine's zone.

No shell and no platform-specific tools: it runs the same on macOS, Linux and Windows. If anything
fails, the prompt goes through without the line.

## Install

For all your sessions (global), type at the prompt of a Claude Code terminal session:

```
/plugin install time-sense --marketplace https://gitlab.com/zoones.net/oss/claude.git
```

Answer `y` to add the marketplace and pick the **user** scope. The mod is active from the next
prompt on.

## Develop

```bash
claude plugin validate plugins/time-sense
claude plugin test plugins/time-sense
```
