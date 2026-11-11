# Zoones Claude Code mods

A [Claude Code](https://claude.com/claude-code) plugin marketplace.

| Plugin | What it does |
|---|---|
| [`inline-images`](plugins/inline-images) | Shows pictures right in the transcript: under each `Read` of a picture and under prompts with pasted images (Ghostty, kitty, WezTerm) |
| [`inline-mermaid`](plugins/inline-mermaid) | Draws Mermaid diagrams right in the transcript: under Claude's replies and under `Read`/`Write`/`Edit` of `.mmd` files and Markdown with mermaid blocks (Ghostty, kitty, WezTerm; needs `mmdc`) |
| [`time-sense`](plugins/time-sense) | Gives Claude a sense of time: every prompt carries the current date, time, weekday, time zone and how long ago the previous prompt was |
| [`autostart`](plugins/autostart) | Runs the `AUTOSTART.md` of the directory Claude starts in as the session's first prompt, once you have trusted that file with `/autostart` |
| [`live-log`](plugins/live-log) | Shows the output of Claude's long-running background Bash commands live in a pane beside the chat, including the log files they write to, and tells Claude to run long jobs that way |
| [`worklog`](plugins/worklog) | Book your working time per session: the `wl` command, a band above the prompt to switch or stop, activity stamps so a stop never bills idle time, and `/worktime` to turn the log, commits and your keystrokes into billable intervals (clients and categories configured per user) |

## Install

Type at the prompt of a Claude Code terminal session:

```
/plugin install inline-images --marketplace https://gitlab.com/zoones.net/oss/claude.git
/plugin install inline-mermaid --marketplace https://gitlab.com/zoones.net/oss/claude.git
/plugin install time-sense --marketplace https://gitlab.com/zoones.net/oss/claude.git
/plugin install autostart --marketplace https://gitlab.com/zoones.net/oss/claude.git
/plugin install live-log --marketplace https://gitlab.com/zoones.net/oss/claude.git
/plugin install worklog --marketplace https://gitlab.com/zoones.net/oss/claude.git
```

Answer `y` to add the marketplace, then pick a scope (user: all your sessions). The mod is active
right away. Updates: `/plugin marketplace update zoones`.

### For a whole team

Add the marketplace and the plugin to the project's `.claude/settings.json`; everyone who opens the
project is offered the install:

```json
{
  "extraKnownMarketplaces": {
    "zoones": { "source": { "source": "git", "url": "https://gitlab.com/zoones.net/oss/claude.git" } }
  },
  "enabledPlugins": { "inline-images@zoones": true, "inline-mermaid@zoones": true, "time-sense@zoones": true, "autostart@zoones": true, "live-log@zoones": true }
}
```

## Develop

```bash
claude plugin validate .
claude plugin test plugins/inline-images
claude plugin test plugins/inline-mermaid
claude plugin test plugins/time-sense
claude plugin test plugins/autostart
claude plugin test plugins/live-log
claude plugin test plugins/worklog
plugins/worklog/tests/wl.tests.sh
```

To try a change before pushing, load the folder directly instead of the installed copy:
`claude --plugin-dir plugins/inline-images` (uninstall the marketplace copy first, or every picture
shows twice).

## License

[MIT](LICENSE)
