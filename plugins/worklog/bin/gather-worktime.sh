#!/usr/bin/env bash
# =============================================================================
# gather-worktime.sh — Collect evidence for worktime booking analysis (/worktime)
#
# Usage:
#   gather-worktime.sh                          # current Mon–Sun week
#   gather-worktime.sh 2026-03-23               # seven days starting on the given date
#   gather-worktime.sh 2026-03-23 2026-03-28    # explicit range
#
# What it looks at comes from the worklog configuration (~/.claude/worklog/config.json, override
# WL_CONFIG — see `wl config`), so it works for any set of projects:
#   "author"                     whose commits count (default: git config user.name)
#   "repos": [{ "path", "name", "pathHints": {"<path part>": "<CATEGORY>"}, "buildLogs": ["<glob>"] }]
#                                the repos to scan; `name` tags work without a path hint (default: the
#                                folder name); pathHints tag files by path; buildLogs are activity logs
#   "categories": { "<CAT>": { "keywords": ["word", ...] } }
#                                commit subjects naming one of these words are tagged with the category
# Without "repos" the git repo of the current directory is scanned; REPO_DIR scans just that one.
#
# Output is written to /tmp/worktime-YYYY-WNN.txt and also printed to stdout.
# =============================================================================

set -euo pipefail

# shellcheck source=_wl_session.sh
. "${BASH_SOURCE[0]%/*}/_wl_session.sh"
CONFIG=$(wlConfigPath)

# A jq query against the configuration; empty when there is none.
cfg() {
  if [ -r "$CONFIG" ]; then
    jq -r "$1" "$CONFIG" 2>/dev/null || true
  fi
}

expandHome() {
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s' "$HOME/${1#\~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# ---------------------------------------------------------------------------
# The repos to scan: parallel arrays (bash 3.2 has no associative ones)
# ---------------------------------------------------------------------------
REPO_PATHS=()
REPO_NAMES=()
REPO_HINTS=()   # "part=TAG,part=TAG" — the first matching part tags a file
BUILD_GLOBS=""
REPO_ROOTS=" "  # root commits of the repos taken: a second clone of one of them is skipped

addRepo() {  # addRepo <path> <name> <hints> <globs>
  local path name root
  path=$(expandHome "$1")
  if ! git -C "$path" rev-parse --git-dir > /dev/null 2>&1; then
    echo "[gather] skipping $path — not a git repo" >&2
    return
  fi
  # Two clones of one repo list the same commits — with --all every one of them twice.
  root=$(git -C "$path" rev-list --max-parents=0 --all 2>/dev/null | sort | head -1)
  case "$REPO_ROOTS" in
    *" $root "*)
      echo "[gather] skipping $path — another clone of a repo already scanned" >&2
      return
      ;;
  esac
  REPO_ROOTS="$REPO_ROOTS$root "
  name="${2:-$(basename "$path")}"
  REPO_PATHS+=("$path")
  REPO_NAMES+=("$name")
  REPO_HINTS+=("$3")
  BUILD_GLOBS="$BUILD_GLOBS $4"
}

configuredRepos=$(cfg '.repos // [] | .[] | [.path, (.name // ""), ((.pathHints // {}) | to_entries | map(.key + "=" + (.value | ascii_upcase)) | join(",")), ((.buildLogs // []) | join(" "))] | @tsv')
if [ -n "${REPO_DIR:-}" ]; then
  # One repo asked for explicitly — with its configured hints when the configuration knows it.
  match=""
  if [ -n "$configuredRepos" ]; then
    while IFS=$'\t' read -r path name hints globs; do
      [ "$(expandHome "$path")" = "${REPO_DIR%/}" ] && match="$name"$'\t'"$hints"$'\t'"$globs"
    done <<< "$configuredRepos"
  fi
  IFS=$'\t' read -r name hints globs <<< "${match:-}" || true
  addRepo "$REPO_DIR" "${name:-}" "${hints:-}" "${globs:-}"
elif [ -n "$configuredRepos" ]; then
  while IFS=$'\t' read -r path name hints globs; do
    addRepo "$path" "$name" "$hints" "$globs"
  done <<< "$configuredRepos"
else
  top=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [ -z "$top" ]; then
    echo "gather-worktime: no \"repos\" in $CONFIG and not inside a git repo — nothing to scan" >&2
    exit 2
  fi
  addRepo "$top" "" "" ""
fi
if [ "${#REPO_PATHS[@]}" -eq 0 ]; then
  echo "gather-worktime: none of the configured repos is a git repo — nothing to scan" >&2
  exit 2
fi

# Subject keywords per category: "CAT=word|word;CAT=word" — the first category matching wins.
KEYWORDS=$(cfg '.categories // {} | to_entries | map(select((.value.keywords // []) | length > 0) | (.key | ascii_upcase) + "=" + (.value.keywords | join("|"))) | join(";")')

GIT_AUTHOR="${GIT_AUTHOR:-$(cfg '.author // empty')}"
GIT_AUTHOR="${GIT_AUTHOR:-$(git -C "${REPO_PATHS[0]}" config user.name 2>/dev/null || true)}"

# IntelliJ logs: every JetBrains product folder that has an idea.log, newest first.
IDEA_LOG_DIRS=()
while IFS= read -r dir; do
  [ -n "$dir" ] && IDEA_LOG_DIRS+=("$dir")
done < <(ls -dt "$HOME/Library/Logs/JetBrains/"*/ 2>/dev/null | sed 's|/$||')

# ---------------------------------------------------------------------------
# Date range calculation
# ---------------------------------------------------------------------------
if [[ $# -ge 2 ]]; then
  WEEK_START="$1"
  WEEK_END="$2"
elif [[ $# -eq 1 ]]; then
  # Seven days, both ends inclusive: weekend work is booked on its own day, so a window that stops
  # on Saturday silently loses every Sunday.
  WEEK_START="$1"
  WEEK_END=$(date -j -v+6d -f "%Y-%m-%d" "$WEEK_START" +"%Y-%m-%d" 2>/dev/null || \
             date -d "$WEEK_START + 6 days" +"%Y-%m-%d")
else
  # Auto-detect the current week Mon–Sun
  TODAY=$(date +%Y-%m-%d)
  DOW=$(date +%u)  # 1=Mon … 7=Sun
  DAYS_SINCE_MON=$(( DOW - 1 ))
  WEEK_START=$(date -j -v-${DAYS_SINCE_MON}d +"%Y-%m-%d" 2>/dev/null || \
               date -d "$TODAY - $DAYS_SINCE_MON days" +"%Y-%m-%d")
  WEEK_END=$(date -j -v+$((6 - DAYS_SINCE_MON))d +"%Y-%m-%d" 2>/dev/null || \
             date -d "$TODAY + $((6 - DAYS_SINCE_MON)) days" +"%Y-%m-%d")
fi

# Git uses "until" as exclusive; add 1 day to include the end date fully
GIT_UNTIL=$(date -j -v+1d -f "%Y-%m-%d" "$WEEK_END" +"%Y-%m-%d" 2>/dev/null || \
            date -d "$WEEK_END + 1 day" +"%Y-%m-%d")

WEEK_NUM=$(date -j -f "%Y-%m-%d" "$WEEK_START" +"%V" 2>/dev/null || \
           date -d "$WEEK_START" +"%V")
YEAR=$(date -j -f "%Y-%m-%d" "$WEEK_START" +"%Y" 2>/dev/null || \
       date -d "$WEEK_START" +"%Y")
WEEK_START_DAY=$(date -j -f "%Y-%m-%d" "$WEEK_START" +"%A" 2>/dev/null || \
                 date -d "$WEEK_START" +"%A")
WEEK_END_DAY=$(date -j -f "%Y-%m-%d" "$WEEK_END" +"%A" 2>/dev/null || \
               date -d "$WEEK_END" +"%A")

OUTPUT_FILE="/tmp/worktime-${YEAR}-W${WEEK_NUM}.txt"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
hr() { printf '%0.s─' {1..80}; echo; }

section() {
  echo
  hr
  echo "### $1"
  hr
}

# The author's commits of one repo in the range, in git log's own format arguments.
repoLog() {  # repoLog <repo> <git log args...>
  local repo="$1"
  shift
  git -C "$repo" log --all \
    --author="$GIT_AUTHOR" \
    --since="$WEEK_START" \
    --until="$GIT_UNTIL" \
    "$@" 2>/dev/null || true
}

# Shared awk functions: tags from the configuration instead of names in the script.
#   fileTag(path)   the category of the first path hint the file matches, "" for none
#   subjectTag(s)   the category of the first keyword the subject names as a word, "" for none
#   filesTag(name)  "[A+B]" for the categories with counted files (cnt[]), "[<repo name>]" for none
AWK_TAGS='
  BEGIN {
    nh = split(hints, h, ",")
    for (i = 1; i <= nh; i++) { eq = index(h[i], "="); hp[i] = substr(h[i], 1, eq - 1); ht[i] = substr(h[i], eq + 1) }
    nk = split(keywords, k, ";")
    for (i = 1; i <= nk; i++) {
      eq = index(k[i], "=")
      kt[i] = substr(k[i], 1, eq - 1)
      kr[i] = "(^|[^a-z0-9])(" tolower(substr(k[i], eq + 1)) ")([^a-z0-9]|$)"
    }
  }
  function fileTag(path,   i) { for (i = 1; i <= nh; i++) if (index(path, hp[i]) > 0) return ht[i]; return "" }
  function subjectTag(s,   i, low) { low = tolower(s); for (i = 1; i <= nk; i++) if (low ~ kr[i]) return kt[i]; return "" }
  function filesTag(name,   i, t, seen) {
    t = ""
    for (i = 1; i <= nh; i++) if (cnt[ht[i]] > 0 && !(ht[i] in seen)) { seen[ht[i]] = 1; t = t (t == "" ? "" : "+") ht[i] }
    return "[" (t == "" ? name : t) "]"
  }
  function resetCounts(   i) { for (i = 1; i <= nh; i++) cnt[ht[i]] = 0; other = 0 }
  function countsText(name,   i, t, seen) {
    t = ""
    for (i = 1; i <= nh; i++) if (!(ht[i] in seen)) { seen[ht[i]] = 1; t = t tolower(ht[i]) "=" cnt[ht[i]] " " }
    return t tolower(name) "=" other
  }
'

# ---------------------------------------------------------------------------
# Start output
# ---------------------------------------------------------------------------
exec > >(tee "$OUTPUT_FILE")

echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║           WORKTIME EVIDENCE REPORT — ${YEAR} Week ${WEEK_NUM}                         ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo "Generated : $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Range     : ${WEEK_START} (${WEEK_START_DAY}) → ${WEEK_END} (${WEEK_END_DAY})"
echo "Author    : ${GIT_AUTHOR}"
echo "Config    : ${CONFIG}$([ -r "$CONFIG" ] || echo ' (none)')"
for i in "${!REPO_PATHS[@]}"; do
  echo "Repo      : ${REPO_NAMES[$i]} — ${REPO_PATHS[$i]}${REPO_HINTS[$i]:+ (path hints: ${REPO_HINTS[$i]})}"
done
[ -z "$KEYWORDS" ] || echo "Keywords  : ${KEYWORDS}"
echo

# ---------------------------------------------------------------------------
# SECTION 1: Git commits with file-level category context
# ---------------------------------------------------------------------------
section "GIT COMMITS (with changed-file context)"
echo "Format: TIMESTAMP|HASH|SUBJECT|[TAGS] counts"
echo "[TAG] = files under a path hint of that category; [<repo name>] = no hint matched"
echo

for i in "${!REPO_PATHS[@]}"; do
  echo "── Repo: ${REPO_NAMES[$i]} ──"
  repoLog "${REPO_PATHS[$i]}" --format="COMMIT|%ai|%h|%s" --name-only --diff-filter=ACMRT | \
    awk -v hints="${REPO_HINTS[$i]}" -v keywords="$KEYWORDS" -v name="${REPO_NAMES[$i]}" "$AWK_TAGS"'
    function flush() {
      if (cur_ts == "") return
      if (files > 0) printf "%s|%s|%s|%s %s\n", cur_ts, cur_hash, cur_subj, filesTag(name), countsText(name)
      else printf "%s|%s|%s|[%s] (no-file-change)\n", cur_ts, cur_hash, cur_subj, name
    }
    /^COMMIT\|/ {
      flush()
      sub(/^COMMIT\|/, "")
      n = split($0, parts, "|")
      cur_ts = parts[1]; cur_hash = parts[2]; cur_subj = parts[3]
      for (j = 4; j <= n; j++) cur_subj = cur_subj "|" parts[j]
      resetCounts(); files = 0
      next
    }
    /^$/ { next }
    { files++; t = fileTag($0); if (t != "") cnt[t]++; else other++ }
    END { flush() }
  '
  echo
done

# ---------------------------------------------------------------------------
# SECTION 2: Raw commit timeline over all repos (for gap analysis)
# ---------------------------------------------------------------------------
section "GIT COMMIT TIMELINE (chronological, for gap analysis)"
echo "Format: TIMESTAMP | REPO | CATEGORY (subject keywords) | TYPE | SUBJECT"
echo

for i in "${!REPO_PATHS[@]}"; do
  repoLog "${REPO_PATHS[$i]}" --format="%ai|${REPO_NAMES[$i]}|%s"
done | sort | awk -v keywords="$KEYWORDS" "$AWK_TAGS"'
  {
    n = split($0, p, "|")
    subj = p[3]; for (j = 4; j <= n; j++) subj = subj "|" p[j]
    cat = subjectTag(subj); if (cat == "") cat = p[2]
    type = (tolower(subj) ~ /^fix:|^chore:|maintenance|hotfix|bugfix/) ? "MAINT" : "DEV"
    printf "%-26s | %-12s | %-7s | %-5s | %s\n", p[1], p[2], cat, type, subj
  }
'

# ---------------------------------------------------------------------------
# SECTION 3: Daily first/last commit times over all repos
# ---------------------------------------------------------------------------
section "DAILY GIT ACTIVITY SUMMARY"
echo "First commit = earliest possible work start"
echo "Last commit  = latest confirmed work moment"
echo

for i in "${!REPO_PATHS[@]}"; do
  repoLog "${REPO_PATHS[$i]}" --format="%ai"
done | sort | awk '
  {
    day = $1; time = $2
    if (!(day in first)) { first[day] = time; days[day] = day }
    last[day] = time
    count[day]++
  }
  END {
    for (d in days)
      printf "%s  first=%s  last=%s  commits=%d\n", d, first[d], last[d], count[d]
  }
' | sort

# ---------------------------------------------------------------------------
# SECTION 4: IntelliJ IDEA log (IDE open/close = best proxy for work hours)
# ---------------------------------------------------------------------------
section "INTELLIJ IDEA LOG (startup/shutdown events)"
echo "IDEA log entries give the most accurate start/end of work session"
echo

idea_found=0
for idea_dir in ${IDEA_LOG_DIRS[@]+"${IDEA_LOG_DIRS[@]}"}; do
  if [[ ! -d "$idea_dir" ]]; then continue; fi

  # Try idea.log and rotated logs (IntelliJ uses idea.N.log rotation)
  for logfile in "$idea_dir/idea.log" "$idea_dir"/idea.*.log; do
    [[ -f "$logfile" ]] || continue

    # Filter to this week's date range — only key IDE lifecycle events
    matched=$(grep -hE "^202[0-9]-[0-9]{2}-[0-9]{2}" "$logfile" 2>/dev/null | \
      awk -v start="$WEEK_START" -v end="$WEEK_END" '
        { day=substr($0,1,10); if (day >= start && day <= end) print }
      ' | grep -iE "IDE STARTED|IDE SHUTDOWN|IDE OPENED|will be closed|Restarting" 2>/dev/null || true)

    if [[ -n "$matched" ]]; then
      echo "── $logfile ──"
      echo "$matched"
      idea_found=1
      echo
    fi
  done
done

if [[ $idea_found -eq 0 ]]; then
  echo "(No IntelliJ log entries found for this range — logs may have rotated)"
  echo "Log dirs checked:"
  for d in ${IDEA_LOG_DIRS[@]+"${IDEA_LOG_DIRS[@]}"}; do
    echo "  $d ($(ls "$d" 2>/dev/null | wc -l | tr -d ' ') files)"
  done
fi

# ---------------------------------------------------------------------------
# SECTION 5: macOS system log — Java process starts (work session anchors)
# ---------------------------------------------------------------------------
section "MACOS SYSTEM LOG — Java process launches"
echo "Each java launch = likely backend start (morning) or restart after changes"
echo "Times are local. Only showing first event per hour to reduce noise."
echo

log show \
  --predicate 'processImagePath ENDSWITH "java" AND subsystem == "com.apple.SkyLight" AND eventMessage CONTAINS "New connection"' \
  --style compact \
  --start "$WEEK_START 00:00:00" \
  --end   "$GIT_UNTIL 00:00:00" \
  2>/dev/null | \
  grep -E "^202[0-9]" | \
  awk '{
    # Deduplicate: keep first event per (day, hour)
    key = substr($1,1,10) " " substr($2,1,2)
    if (!(key in seen)) { seen[key]=1; print }
  }' || echo "(system log query failed — try running with sudo or check log permissions)"

# ---------------------------------------------------------------------------
# SECTION 6: Build / test logs (the repos' buildLogs globs)
# ---------------------------------------------------------------------------
section "BUILD LOGS (compile/test activity timestamps)"
echo

seenLogs=" "
# shellcheck disable=SC2086 # the globs are meant to expand here
for logfile in $BUILD_GLOBS; do
  [[ -f "$logfile" ]] || continue
  case "$seenLogs" in *" $logfile "*) continue ;; esac
  seenLogs="$seenLogs$logfile "

  # Check if log was modified within the range
  mod_date=$(stat -f "%Sm" -t "%Y-%m-%d" "$logfile" 2>/dev/null || \
             stat -c "%y" "$logfile" 2>/dev/null | cut -d' ' -f1)
  if [[ "$mod_date" < "$WEEK_START" ]] || [[ "$mod_date" > "$WEEK_END" ]]; then
    continue
  fi

  echo "── $logfile (modified: $mod_date) ──"
  # Show first and last line with timestamps
  first_line=$(grep -m1 "202[0-9]-[0-9]" "$logfile" 2>/dev/null || head -1 "$logfile")
  last_line=$(grep "202[0-9]-[0-9]" "$logfile" 2>/dev/null | tail -1 || tail -1 "$logfile")
  mod_full=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$logfile" 2>/dev/null || \
             stat -c "%y" "$logfile" 2>/dev/null | cut -d'.' -f1)
  echo "  File modified : $mod_full"
  echo "  First match   : $first_line"
  echo "  Last match    : $last_line"
  echo
done

# ---------------------------------------------------------------------------
# SECTION 7: File modification activity (broad sweep for edge days)
# ---------------------------------------------------------------------------
section "RECENTLY MODIFIED SOURCE FILES (by day)"
echo "Useful to confirm activity on days with few commits"
echo

refStart=$(mktemp)
refEnd=$(mktemp)
trap 'rm -f "$refStart" "$refEnd"' EXIT
day="$WEEK_START"
# Every day of the range — the weekend included (a fixed five-day loop used to drop it).
while [[ ! "$day" > "$WEEK_END" ]]; do
  day_name=$(date -j -f "%Y-%m-%d" "$day" +"%A" 2>/dev/null || date -d "$day" +"%A")
  next_day=$(date -j -v+1d -f "%Y-%m-%d" "$day" +"%Y-%m-%d" 2>/dev/null || \
             date -d "$day + 1 day" +"%Y-%m-%d")
  echo "── $day ($day_name) ──"

  # Reference timestamp files for find -newer
  touch -t "$(echo "$day" | tr -d '-')0000"      "$refStart" 2>/dev/null
  touch -t "$(echo "$next_day" | tr -d '-')0000" "$refEnd"   2>/dev/null

  any=0
  for i in "${!REPO_PATHS[@]}"; do
    files=$(find "${REPO_PATHS[$i]}" \
      -not -path "*/.git/*" \
      -not -path "*/node_modules/*" \
      -not -path "*/target*/*" \
      -not -path "*/.worktrees/*" \
      -newer "$refStart" \
      ! -newer "$refEnd" \
      -type f \( -name "*.java" -o -name "*.ts" -o -name "*.tsx" -o -name "*.html" -o -name "*.groovy" \
                 -o -name "*.scss" -o -name "*.kt" -o -name "*.py" -o -name "*.sh" -o -name "*.md" \) \
      2>/dev/null || true)
    count=$(printf '%s\n' "$files" | grep -c . || true)
    [[ "$count" -gt 0 ]] || continue
    any=1
    echo "  ${REPO_NAMES[$i]}: $count source files modified"
    printf '%s\n' "$files" | sed "s|${REPO_PATHS[$i]}/||" | \
      awk -v hints="${REPO_HINTS[$i]}" -v keywords="" -v name="${REPO_NAMES[$i]}" "$AWK_TAGS"'
        BEGIN { resetCounts() }
        /.+/ { t = fileTag($0); if (t != "") cnt[t]++; else other++ }
        END { print "    " countsText(name) }
      '
  done
  [[ $any -eq 1 ]] || echo "  (no source files modified on this day)"
  echo
  day="$next_day"
done

# ---------------------------------------------------------------------------
# SECTION 8: Commit classification hints (subject keywords first, then path hints)
# ---------------------------------------------------------------------------
section "COMMIT CLASSIFICATION HINTS"
echo "Auto-detected category/type assignments for each commit:"
echo "Format: DATE TIME | DAY | REPO | CATEGORY | TYPE | HASH | SUBJECT"
echo

for i in "${!REPO_PATHS[@]}"; do
  repoLog "${REPO_PATHS[$i]}" --format="COMMIT|%ai|%h|%s" --reverse --name-only --diff-filter=ACMRT | \
    awk -v hints="${REPO_HINTS[$i]}" -v keywords="$KEYWORDS" -v name="${REPO_NAMES[$i]}" "$AWK_TAGS"'
    function classifyType(subj,   s) {
      s = tolower(subj)
      if (s ~ /^fix:|^chore:|maintenance|hotfix|bugfix|fixed test|fixed tool|fixed guard|fixed build|^fix |reviewer finding|address review/) return "MAINT"
      return "DEV"
    }
    function flush(   c, tparts, cmd, dayname) {
      if (cur_ts == "") return
      c = subjectTag(cur_subj)
      if (c == "") { c = filesTag(name); gsub(/^\[|\]$/, "", c) }
      split(cur_ts, tparts, " ")
      cmd = "date -j -f %Y-%m-%d " tparts[1] " +%A 2>/dev/null || date -d " tparts[1] " +%A"
      cmd | getline dayname; close(cmd)
      printf "%-10s %-8s | %-9s | %-12s | %-7s | %-5s | %s | %s\n", tparts[1], tparts[2], dayname, name, c, classifyType(cur_subj), cur_hash, cur_subj
    }
    /^COMMIT\|/ {
      flush()
      sub(/^COMMIT\|/, "")
      n = split($0, p, "|")
      cur_ts = p[1]; cur_hash = p[2]; cur_subj = p[3]
      for (j = 4; j <= n; j++) cur_subj = cur_subj "|" p[j]
      resetCounts()
      next
    }
    /^$/ { next }
    { t = fileTag($0); if (t != "") cnt[t]++; else other++ }
    END { flush() }
  '
done | sort

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo
hr
echo "✓ Report complete → $OUTPUT_FILE"
hr
