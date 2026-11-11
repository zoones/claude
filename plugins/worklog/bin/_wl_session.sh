#!/usr/bin/env bash
# Shared session-tag derivation for wl and its hooks. Sourced, not executed — the activity hook
# runs after every tool call, so this must not cost a fork.
#
# All three callers MUST agree on the tag: wl writes the log under it, the hooks write the
# activity stamp under it, and a disagreement would silently degrade `wl stop` to "no activity
# data" without anything looking broken.

# wlSessionTag [payload] — echoes the 8-char tag. Env first (no parsing needed), then the hook
# payload's .session_id, then `cli` for a plain shell.
wlSessionTag() {
  local tag="${WL_SESSION:-${CLAUDE_CODE_SESSION_ID:-}}"
  local payload="${1:-}"

  if [ -z "$tag" ] && [ -n "$payload" ]; then
    # Fast path: machine-written JSON, so the key is unambiguous. No fork.
    case "$payload" in
      *'"session_id"'*)
        tag="${payload#*\"session_id\"}"
        tag="${tag#*\"}"
        tag="${tag%%\"*}"
        ;;
    esac
    # Anything the fast path could not cleanly isolate (odd whitespace, escapes) goes to a real
    # parser rather than into a filename.
    case "$tag" in
      *[!0-9a-zA-Z-]* | '')
        tag=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null) || tag=""
        ;;
    esac
  fi

  tag="${tag:0:8}"
  printf '%s' "${tag:-cli}"
}

# The worklog configuration: categories, billing scopes, the log file. One file read by wl, its hooks,
# the status line, /worktime and the band — nothing about any customer lives in the scripts.
wlConfigPath() {
  printf '%s' "${WL_CONFIG:-$HOME/.claude/worklog/config.json}"
}

# Where the activity hook stamps each session's last activity and `wl stop` reads it. One place for
# both: a hook writing elsewhere than wl reads degrades every stop to "no activity data", silently.
# Fork-free — the activity hook sources this after every tool call.
wlActivityDir() {
  printf '%s' "${WL_ACTIVITY_DIR:-$HOME/.claude/worklog/activity}"
}

# wlLogPath — the worklog file: WL_LOG, else the config's "log", else ~/.claude/worklog/worklog.log.
# Every reader and writer MUST resolve it here: a reader looking at another file than wl writes shows
# "nothing logged" without anything looking broken. Costs one jq fork — not for the activity hook.
wlLogPath() {
  local path="${WL_LOG:-}" config
  if [ -z "$path" ]; then
    config=$(wlConfigPath)
    if [ -r "$config" ]; then
      path=$(jq -r '.log // empty' "$config" 2>/dev/null) || path=""
    fi
  fi
  path="${path:-$HOME/.claude/worklog/worklog.log}"
  case "$path" in
    "~") path="$HOME" ;;
    "~/"*) path="$HOME/${path#\~/}" ;;
  esac
  printf '%s' "$path"
}
