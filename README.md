# Zoones Claude Code mods

A [Claude Code](https://claude.com/claude-code) plugin marketplace.

| Plugin | What it does |
|---|---|
| [`inline-images`](plugins/inline-images) | Shows pictures right in the transcript: under each `Read` of a picture and under prompts with pasted images (Ghostty, kitty, WezTerm) |
| [`time-sense`](plugins/time-sense) | Gives Claude a sense of time: every prompt carries the current date, time, weekday, time zone and how long ago the previous prompt was |

## Install

Type at the prompt of a Claude Code terminal session:

```
/plugin install inline-images --marketplace https://gitlab.com/zoones.net/oss/claude.git
/plugin install time-sense --marketplace https://gitlab.com/zoones.net/oss/claude.git
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
  "enabledPlugins": { "inline-images@zoones": true, "time-sense@zoones": true }
}
```

## Develop

```bash
claude plugin validate .
claude plugin test plugins/inline-images
claude plugin test plugins/time-sense
```

To try a change before pushing, load the folder directly instead of the installed copy:
`claude --plugin-dir plugins/inline-images` (uninstall the marketplace copy first, or every picture
shows twice).

## License

[MIT](LICENSE)
