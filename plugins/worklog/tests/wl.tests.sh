#!/usr/bin/env bash
# Tests for wl + its hooks — run directly: plugins/worklog/tests/wl.tests.sh
#
# Everything runs against a throwaway log and activity dir (WL_LOG / WL_ACTIVITY_DIR), so the
# real worklog is never touched. The focus is the stop timestamp: that value goes into billing
# unchallenged, so every branch that can produce it is pinned here.
set -uo pipefail

BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../bin" && pwd)"
WL="$BIN/wl"
HOOK="$BIN/wl-activity-hook"
CONTEXT_HOOK="$BIN/wl-context-hook"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export WL_LOG="$tmp/worklog.log"
export WL_ACTIVITY_DIR="$tmp/activity"
export WL_SESSION="testsess"
# The categories the tests below book to — the scripts themselves know none.
export WL_CONFIG="$tmp/config.json"
cat > "$WL_CONFIG" <<'JSON'
{
  "scopes": ["ACME", "BETA", "OWN"],
  "categories": {
    "ACME": { "shares": { "ACME": 1 } },
    "BETA": { "shares": { "BETA": 1 } },
    "CLIENTS": { "shares": { "ACME": 1, "BETA": 1 } },
    "CLIENTS+OWN": { "aliases": ["C+O", "cl+own"], "shares": { "ACME": 1, "BETA": 1, "OWN": 1 } },
    "OWN": { "shares": { "OWN": 1 } }
  }
}
JSON

pass=0
fail=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s\n        expected: %s\n        actual:   %s\n' "$name" "$expected" "$actual"
  fi
}

# Substring check as a function: a `case` pattern inside $( ) would close the substitution
# on its own `)`.
contains() {
  case "$1" in
    *"$2"*) printf 'yes' ;;
    *) printf 'no (%s)' "$1" ;;
  esac
}

# "stamped now" assertions straddle a minute boundary every now and then — accept the minute
# before and after, so the suite fails on behaviour and not on the clock.
checkNow() {
  local name="$1" actual="$2" before="$3" after
  after=$(date +%H:%M)
  if [ "$actual" = "$before" ] || [ "$actual" = "$after" ]; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s\n        expected: %s or %s\n        actual:   %s\n' "$name" "$before" "$after" "$actual"
  fi
}

# The timestamp of the last STOP line of the test session, as HH:MM.
lastStopTime() {
  awk -F'|' -v s="$WL_SESSION" '$2==s && $3=="STOP" {t=$1} END {print substr(t,12,5)}' "$WL_LOG"
}

# HH:MM <minutes> ago (negative = in the future) — for explicit --at times, where the test itself
# chooses the time and no stamp is involved
clockAgo() {
  local epoch=$(( $(date +%s) - $1 * 60 ))
  date -r "$epoch" +%H:%M 2>/dev/null || date -d "@$epoch" +%H:%M
}

# HH:MM of <seconds> after the last stamp written by stampActivity — expected stops are derived
# from the stamp's own epoch, like wl does, so a minute rolling over mid-test cannot split them.
afterStamp() {
  local epoch=$(( stampEpoch + $1 ))
  date -r "$epoch" +%H:%M 2>/dev/null || date -d "@$epoch" +%H:%M
}

stampEpoch=0
stampActivity() {  # stampActivity <secondsAgo> — call WITHOUT $( ) so stampEpoch is kept
  mkdir -p "$WL_ACTIVITY_DIR"
  local epoch iso
  epoch=$(( $(date +%s) - $1 ))
  stampEpoch=$epoch
  iso=$(date -r "$epoch" +%FT%T%z 2>/dev/null || date -d "@$epoch" +%FT%T%z)
  printf '%s|%s\n' "$epoch" "$iso" > "$WL_ACTIVITY_DIR/$WL_SESSION"
  printf '%s' "${iso:11:5}"
}

# Opens an interval that started <minutesAgo> ago (default 2h) for <session> (default the test
# session). Written directly, because wl can only stamp "now" — and an interval that started this
# second would make every backdated stop look like it precedes its own start.
reset() {
  local minutesAgo="${1:-120}" session="${2:-$WL_SESSION}" epoch iso
  rm -rf "$WL_ACTIVITY_DIR"
  epoch=$(( $(date +%s) - minutesAgo * 60 ))
  iso=$(date -r "$epoch" +%FT%T%z 2>/dev/null || date -d "@$epoch" +%FT%T%z)
  printf '%s|%s|OWN|test entry\n' "$iso" "$session" > "$WL_LOG"
}

echo "wl tests"

# --- the bug this exists for: an idle tail must not be booked ------------------------------
# The stop lands on the last activity plus at most the reading tail (default 3 min — reading the
# last answer is work); everything beyond is dropped.
reset
stampActivity 3600 > /dev/null
out=$("$WL" stop)
check "idle tail is cut back to the last activity plus the reading tail" "$(afterStamp 180)" "$(lastStopTime)"
check "the dropped idle time is reported" "yes" "$(contains "$out" "57 min idle not booked")"

# --- a gap just under the old 10-minute threshold is not booked whole -------------------------
# What happened on 2026-10-06: last answer 09:52, /wl stop at 10:01. A threshold booked the
# whole 9 minutes because they were under it; one minute more and it booked none — the cap has
# no such jump.
reset
stampActivity 540 > /dev/null
"$WL" stop > /dev/null
check "a 9-minute gap books only the reading tail" "$(afterStamp 180)" "$(lastStopTime)"

# --- the stop request itself must not count as activity ---------------------------------------
# The context hook fires BEFORE the turn that runs `wl stop`. If it stamped the activity file,
# the idle gap would always be ~0 and the clip could never engage — the whole feature would be
# dead on the one path everybody uses (/wl stop).
reset
stampActivity 3600 > /dev/null
printf '{"session_id":"%s-aaaa"}' "$WL_SESSION" | "$CONTEXT_HOOK" > /dev/null
"$WL" stop > /dev/null
check "a prompt right before the stop does not defeat the clip" "$(afterStamp 180)" "$(lastStopTime)"

# --- a gap within the reading tail is booked in full --------------------------------------------
reset
stampActivity 120 > /dev/null
"$WL" stop > /dev/null
checkNow "gap within the reading tail stamps now" "$(lastStopTime)" "$(date +%H:%M)"

# --- the reading tail is configurable -----------------------------------------------------------
reset
stampActivity 300 > /dev/null
WL_READ_TAIL=60 "$WL" stop > /dev/null
check "WL_READ_TAIL shortens the booked tail" "$(afterStamp 60)" "$(lastStopTime)"

reset
stampActivity 300 > /dev/null
out=$(WL_READ_TAIL=abc "$WL" stop 2>&1)
check "a non-numeric WL_READ_TAIL falls back to 180s" "$(afterStamp 180)" "$(lastStopTime)"
check "and says so" "yes" "$(contains "$out" "WL_READ_TAIL must be seconds")"

# --- explicit overrides -----------------------------------------------------------------------
reset
stampActivity 3600 > /dev/null
"$WL" stop --now > /dev/null
checkNow "--now overrides the activity stamp" "$(lastStopTime)" "$(date +%H:%M)"

# A fixed clock time would make this test pass or fail depending on the hour it runs at.
reset 600
pastTime=$(date -r "$(( $(date +%s) - 5400 ))" +%H:%M 2>/dev/null || date -d '90 minutes ago' +%H:%M)
"$WL" stop --at "$pastTime" > /dev/null
check "--at takes an explicit time" "$pastTime" "$(lastStopTime)"

# --- an end in the future would over-book ------------------------------------------------------
reset
futureTime=$(date -r "$(( $(date +%s) + 5400 ))" +%H:%M 2>/dev/null || date -d '90 minutes' +%H:%M)
out=$("$WL" stop --at "$futureTime")
checkNow "--at in the future is pulled back to now" "$(lastStopTime)" "$(date +%H:%M)"
check "and it says why" "yes" "$(contains "$out" "future")"

reset
expected=$(date -r "$(( $(date +%s) - 1800 ))" +%H:%M 2>/dev/null || date -d '30 minutes ago' +%H:%M)
"$WL" stop --ago 30m > /dev/null
check "--ago counts back from now" "$expected" "$(lastStopTime)"

# --- a missing stamp must be visible, not silently "now" --------------------------------------
reset
out=$("$WL" stop)
check "no activity data is reported" "yes" "$(contains "$out" "no activity data")"
checkNow "no activity data still stamps now" "$(lastStopTime)" "$(date +%H:%M)"

# --- work outside the session (IDE, phone) must not be clipped away ----------------------------
# The hook only sees this session. An activity stamp older than the interval start therefore
# means "nothing happened IN here", not "work ended then" — over-booking is visible and
# amendable, silently swallowing hours of IDE work is not.
reset 60
stampActivity 7200 > /dev/null
out=$("$WL" stop)
checkNow "a stamp older than the interval start does not clip" "$(lastStopTime)" "$(date +%H:%M)"
check "and it says why" "yes" "$(contains "$out" "precedes")"

# ...also when the stamp is only a minute before the start — the usual case, since the call that
# opened the interval sits right after the previous turn's stamp. Checked on the stamp itself: with
# the reading tail added it would land after the start and book the interval as 0-3 minutes.
reset 60
stampActivity 3660 > /dev/null
out=$("$WL" stop)
checkNow "a stamp just before the interval start does not clip either" "$(lastStopTime)" "$(date +%H:%M)"
check "and it says why" "yes" "$(contains "$out" "precedes")"

# --- a stop must never precede this session's own last entry ----------------------------------
reset
out=$("$WL" stop --at 00:01)
checkNow "end before the session start falls back to now" "$(lastStopTime)" "$(date +%H:%M)"
check "the fallback says why" "yes" "$(contains "$out" "precedes")"

# --- an unwritable timestamp must never reach the log -------------------------------------------
# WorklogParser aborts the whole import on the first unparseable line, so one bad entry makes
# the entire log unpushable — and `amend --at` only re-times lines of the own session, so a bad
# stamp must never be written in the first place.
# Exit 1, not 2: the refusal happens at the single validation choke point in front of the
# write, not at the argument parser. (A corrupt activity stamp is caught earlier: only its epoch
# is used, and a non-numeric one reports "no activity data".)
reset
"$WL" stop --at 19:99 > /dev/null 2>&1
check "an out-of-range time is rejected" "1" "$?"
check "and nothing was logged" "" "$(awk -F'|' '$3=="STOP"' "$WL_LOG")"

reset
mkdir -p "$WL_ACTIVITY_DIR"
printf '%s|\n' "$(( $(date +%s) - 3600 ))" > "$WL_ACTIVITY_DIR/$WL_SESSION"   # truncated stamp
"$WL" stop > /dev/null 2>&1
check "a truncated activity stamp writes no empty timestamp" "" \
  "$(awk -F'|' '$1=="" {print "EMPTY TIMESTAMP WRITTEN"}' "$WL_LOG")"

# --- everything wl writes has to parse back ------------------------------------------------------
reset
stampActivity 3600 > /dev/null
"$WL" stop > /dev/null
written=$(awk -F'|' '$3=="STOP" {print $1}' "$WL_LOG")
check "the written stamp round-trips through date" "yes" \
  "$( (date -j -f '%Y-%m-%dT%H:%M:%S%z' "$written" +%s > /dev/null 2>&1 || date -d "$written" +%s > /dev/null 2>&1) && echo yes || echo "no ($written)")"

# --- bad arguments are rejected, not guessed --------------------------------------------------
reset
"$WL" stop --at 25h > /dev/null 2>&1
check "--at rejects garbage" "2" "$?"
"$WL" stop --ago 5x > /dev/null 2>&1
check "--ago rejects garbage" "2" "$?"
"$WL" stop -now > /dev/null 2>&1
check "a mistyped flag is refused, not logged as a comment" "2" "$?"
check "and nothing was logged" "" "$(awk -F'|' '$3=="STOP"' "$WL_LOG")"

# --- a stop for yesterday needs the date, not just the time -------------------------------------
reset
yesterday=$(date -r "$(( $(date +%s) - 86400 ))" +%F 2>/dev/null || date -d 'yesterday' +%F)
printf '%sT08:00:00%s|%s|OWN|yesterday\n' "$yesterday" "$(date +%z)" "$WL_SESSION" > "$WL_LOG"
"$WL" stop --at "$yesterday 17:00" > /dev/null
check "--at accepts an explicit date" "${yesterday}T17:00:00" \
  "$(awk -F'|' '$3=="STOP" {print substr($1,1,19)}' "$WL_LOG")"

# --- the comment argument still works (old signature) -----------------------------------------
reset
"$WL" stop "feierabend" > /dev/null
check "comment is kept" "feierabend" "$(awk -F'|' '$3=="STOP" {c=$4} END {print c}' "$WL_LOG")"

# --- sessions stay independent -----------------------------------------------------------------
reset
stampActivity 3600 > /dev/null
WL_SESSION=othersess "$WL" stop > /dev/null
check "another session does not consume this session's stamp" "" "$(lastStopTime)"

# --- an explicit share split goes into the category field ----------------------------------------
# The import takes either a category or explicit shares per billing scope; the log carries the
# split in the category field so every line keeps its four fields.
lastCategory() {
  awk -F'|' -v s="$WL_SESSION" '$2==s {c=$3} END {print c}' "$WL_LOG"
}
reset
"$WL" acme=60,own=40 "migration" > /dev/null
check "shares are written upper-case in the given order" "ACME=60,OWN=40" "$(lastCategory)"
check "the comment stays the fourth field" "migration" "$(awk -F'|' -v s="$WL_SESSION" '$2==s {c=$4} END {print c}' "$WL_LOG")"
"$WL" acme=33.5,beta=33.5,own=33 > /dev/null
check "decimal percentages are accepted" "ACME=33.5,BETA=33.5,OWN=33" "$(lastCategory)"
"$WL" acme=060,own=40.0 > /dev/null
check "percentages are written in canonical form" "ACME=60,OWN=40" "$(lastCategory)"
"$WL" acme,own > /dev/null
check "scopes without percentages mean an even split" "ACME,OWN" "$(lastCategory)"

reset
before=$(cat "$WL_LOG")
"$WL" acme=60,own=30 > /dev/null 2>&1
check "shares not adding up to 100 are refused" "2" "$?"
"$WL" acme=60,own > /dev/null 2>&1
check "a mix of set and unset percentages is refused" "2" "$?"
"$WL" acme=60,acme=40 > /dev/null 2>&1
check "a scope named twice is refused" "2" "$?"
"$WL" acme=50,clients=50 > /dev/null 2>&1
check "a category is not a billing scope" "2" "$?"
"$WL" acme=100 > /dev/null 2>&1
check "a single scope is a category, not a split" "2" "$?"
"$WL" acme=60,own=40, > /dev/null 2>&1
check "a trailing comma is refused" "2" "$?"
"$WL" acme,,own > /dev/null 2>&1
check "an empty part is refused" "2" "$?"
"$WL" "acme beta,own" > /dev/null 2>&1
check "whitespace inside a scope is refused" "2" "$?"
"$WL" acme=50,own=50.001 > /dev/null 2>&1
check "a sum just off 100 is refused" "2" "$?"
"$WL" acme=50,own=50.00000000001 > /dev/null 2>&1
check "more than two decimals are refused" "2" "$?"
# Unquoted word splitting would also glob: `ACM?` matched a file named ACME and passed as a scope.
(cd "$tmp" && touch ACME && "$WL" 'acm?,own' > /dev/null 2>&1)
check "a glob pattern is not expanded into a scope" "2" "$?"
"$WL" acme=100,own=0 > /dev/null 2>&1
check "a zero share is refused" "2" "$?"
"$WL" acme=abc,own=40 > /dev/null 2>&1
check "a non-numeric share is refused" "2" "$?"
check "and none of them was logged" "$before" "$(cat "$WL_LOG")"

reset
"$WL" amend acme=60,own=40 > /dev/null
check "amend accepts shares" "ACME=60,OWN=40" "$(lastCategory)"
check "and keeps the comment" "test entry" "$(awk -F'|' -v s="$WL_SESSION" '$2==s {c=$4} END {print c}' "$WL_LOG")"
"$WL" amend acme=60,own=50 > /dev/null 2>&1
check "amend refuses invalid shares" "2" "$?"
check "and leaves the line alone" "ACME=60,OWN=40" "$(lastCategory)"

# --- amend --at re-times an entry already written ---------------------------------------------
# A stop written too late (the old idle threshold) is the reason this exists: the only other way
# to correct it was editing the log by hand, where one unparseable stamp makes it unpushable.
reset
"$WL" stop --at "$(clockAgo 60)" "feierabend" > /dev/null
"$WL" amend --at "$(clockAgo 90)" > /dev/null
check "amend --at moves the line" "$(clockAgo 90)" "$(lastStopTime)"
check "and keeps it a STOP with its comment" "STOP|feierabend" \
  "$(awk -F'|' -v s="$WL_SESSION" '$2==s {l=$3"|"$4} END {print l}' "$WL_LOG")"

before=$(cat "$WL_LOG")
"$WL" amend --at "$(clockAgo -3600)" > /dev/null 2>&1
check "amend --at refuses the future" "2" "$?"
"$WL" amend --at "$(clockAgo 180)" > /dev/null 2>&1
check "amend --at refuses a time before the session's previous entry" "2" "$?"
"$WL" amend --at 19:99 > /dev/null 2>&1
check "amend --at refuses an invalid time" "2" "$?"
check "and none of them changed the log" "$before" "$(cat "$WL_LOG")"

# the entry before a later one cannot be moved past it — the later one written 70 min ago
# directly, since wl itself only stamps "now"
nextEpoch=$(( $(date +%s) - 70 * 60 ))
printf '%s|%s|OWN|next\n' "$(date -r "$nextEpoch" +%FT%T%z 2>/dev/null || date -d "@$nextEpoch" +%FT%T%z)" \
  "$WL_SESSION" >> "$WL_LOG"
"$WL" amend -2 --at "$(clockAgo 60)" > /dev/null 2>&1
check "amend --at refuses a time after the session's next entry" "2" "$?"

# with a category the line is rebooked AND re-timed in one go
reset
"$WL" amend --at "$(clockAgo 100)" acme "moved" > /dev/null
check "amend --at with a category rebooks too" "ACME|moved" \
  "$(awk -F'|' -v s="$WL_SESSION" '$2==s {l=$3"|"$4} END {print l}' "$WL_LOG")"
check "and re-times it" "$(clockAgo 100)" \
  "$(awk -F'|' -v s="$WL_SESSION" '$2==s {t=substr($1,12,5)} END {print t}' "$WL_LOG")"

# --- a new entry may start earlier than now, never before the session's last entry ---------------
# "since 14:00 this is ACME": without --at the only way was a new entry now plus amend --at, which
# cannot move it past nothing — or a hand edit of the log.
reset
"$WL" acme --at "$(clockAgo 30)" "cutover" > /dev/null
check "an entry --at starts at the given time" "$(clockAgo 30)|ACME|cutover" \
  "$(awk -F'|' -v s="$WL_SESSION" '$2==s {l=substr($1,12,5)"|"$3"|"$4} END {print l}' "$WL_LOG")"

before=$(cat "$WL_LOG")
# Appended at the end, an earlier stamp would make it the session's "last line" while a later
# entry exists — every reader takes the last line as the open interval.
"$WL" beta --at "$(clockAgo 60)" > /dev/null 2>&1
check "an entry --at refuses a time before the session's last entry" "2" "$?"
"$WL" beta --at "$(clockAgo -60)" > /dev/null 2>&1
check "an entry --at refuses the future" "2" "$?"
"$WL" beta --at 25:61 > /dev/null 2>&1
check "an entry --at refuses an invalid time" "2" "$?"
check "and none of them was logged" "$before" "$(cat "$WL_LOG")"

# --- parallel: sessions open in a window share its time --------------------------------------------
# Two tabs at once are one person: /worktime must not book that wall-clock time twice. The window is
# its own line under the pseudo-session `parallel`, so it is nobody's open interval.
reset
"$WL" parallel --from "$(clockAgo 90)" --to "$(clockAgo 30)" "VPN" > /dev/null
check "a parallel window is written under its own pseudo-session, naming the declaring one" \
  "$(clockAgo 90)|parallel|PARALLEL|$(clockAgo 30)|$WL_SESSION|VPN" \
  "$(awk -F'|' '$2=="parallel" {print substr($1,12,5)"|"$2"|"$3"|"substr($4,12,5)"|"$5"|"$6}' "$WL_LOG")"
check "the session's open interval is still its own entry" "OWN" "$(lastCategory)"
check "the context hook still sees the session's own entry" "yes" \
  "$(contains "$(printf '{"session_id":"%s-aaaa"}' "$WL_SESSION" | "$CONTEXT_HOOK")" "OWN")"
"$WL" amend acme > /dev/null
check "amend still reaches the session's own entry" "ACME" "$(lastCategory)"
check "and leaves the window alone" "PARALLEL" "$(awk -F'|' '$2=="parallel" {print $3}' "$WL_LOG")"

reset
before=$(date +%H:%M)
"$WL" parallel --from "$(clockAgo 10)" > /dev/null
checkNow "--to defaults to now" "$(awk -F'|' '$2=="parallel" {print substr($4,12,5)}' "$WL_LOG")" "$before"

reset
before=$(cat "$WL_LOG")
"$WL" parallel --to "$(clockAgo 10)" > /dev/null 2>&1
check "parallel refuses a window without --from" "2" "$?"
"$WL" parallel --from "$(clockAgo 10)" --to "$(clockAgo 20)" > /dev/null 2>&1
check "parallel refuses a window running backwards" "2" "$?"
"$WL" parallel --from "$(clockAgo 10)" --to "$(clockAgo -60)" > /dev/null 2>&1
check "parallel refuses a window into the future" "2" "$?"
"$WL" parallel --from 14:61 > /dev/null 2>&1
check "parallel refuses an invalid time" "2" "$?"
"$WL" parallel -from "$(clockAgo 10)" > /dev/null 2>&1
check "parallel refuses a mistyped flag" "2" "$?"
check "and none of them was logged" "$before" "$(cat "$WL_LOG")"

# --- the configuration names the categories, the scripts none ---------------------------------------
# One file for wl, hooks, status line, /worktime and the worklog band: another project with other
# clients needs another file, not another script.
reset
"$WL" c+o "alias" > /dev/null
check "an alias of the configuration books its category" "CLIENTS+OWN" "$(lastCategory)"
"$WL" cl+own > /dev/null
check "aliases are matched case-insensitively" "CLIENTS+OWN" "$(lastCategory)"
before=$(cat "$WL_LOG")
"$WL" gamma > /dev/null 2>&1
check "a category the configuration does not name is refused" "2" "$?"
"$WL" "acme beta" > /dev/null 2>&1
check "two names are not one category (the lists are space-separated)" "2" "$?"
check "and nothing was logged" "$before" "$(cat "$WL_LOG")"

cat > "$tmp/other.json" <<'JSON'
{ "scopes": ["GAMMA", "DELTA"], "categories": { "GAMMA": {}, "DELTA": {} } }
JSON
WL_CONFIG="$tmp/other.json" "$WL" gamma=60,delta=40 "other project" > /dev/null
check "another configuration brings its own categories and scopes" "GAMMA=60,DELTA=40" "$(lastCategory)"
WL_CONFIG="$tmp/other.json" "$WL" acme > /dev/null 2>&1
check "  and only those" "2" "$?"

reset
before=$(cat "$WL_LOG")
out=$(WL_CONFIG="$tmp/missing.json" "$WL" acme 2>&1)
check "without a configuration a category is refused" "yes" "$(contains "$out" "no configuration at $tmp/missing.json")"
check "  and nothing was logged" "$before" "$(cat "$WL_LOG")"
WL_CONFIG="$tmp/missing.json" "$WL" stop > /dev/null
check "  but stop still works" "STOP" "$(lastCategory)"
check "wl config shows an example when there is none" "yes" \
  "$(contains "$(WL_CONFIG="$tmp/missing.json" "$WL" config)" '"categories"')"

printf '{ "scopes": ["A"], "categories": { "A|B": {} } }' > "$tmp/bad.json"
WL_CONFIG="$tmp/bad.json" "$WL" a > /dev/null 2>&1
check "a name the log cannot carry is refused" "2" "$?"
printf 'not json' > "$tmp/broken.json"
WL_CONFIG="$tmp/broken.json" "$WL" a > /dev/null 2>&1
check "a broken configuration is refused" "2" "$?"

# The log file named in the configuration is where wl writes AND where the hooks read.
printf '{ "log": "%s", "scopes": ["OWN"], "categories": { "OWN": {} } }' "$tmp/sub/fromconfig.log" > "$tmp/withlog.json"
env -u WL_LOG WL_CONFIG="$tmp/withlog.json" "$WL" own "logged there" > /dev/null
check "wl writes to the log the configuration names (creating its folder)" "OWN|logged there" \
  "$(awk -F'|' -v s="$WL_SESSION" '$2==s {print $3"|"$4}' "$tmp/sub/fromconfig.log" 2>/dev/null)"
check "the context hook reads that log too" "yes" \
  "$(contains "$(printf '{"session_id":"%s-aaaa"}' "$WL_SESSION" | env -u WL_LOG WL_CONFIG="$tmp/withlog.json" "$CONTEXT_HOOK")" "OWN")"
check "wl config shows it" "yes" "$(contains "$(env -u WL_LOG WL_CONFIG="$tmp/withlog.json" "$WL" config)" "$tmp/sub/fromconfig.log")"
check "the status line reads that log too" "yes" \
  "$(contains "$(printf '{"session_id":"%s-aaaa"}' "$WL_SESSION" | env -u WL_LOG WL_CONFIG="$tmp/withlog.json" "$BIN/wl-statusline")" "OWN")"

echo "wl-statusline tests"

# --- the status line shows this session's interval, nothing of other sessions ------------------------
statusOf() {  # statusOf <session tag> — the status line without its colours
  printf '{"session_id":"%s-aaaa"}' "$1" | "$BIN/wl-statusline" | sed $'s/\033\\[[0-9;]*m//g'
}
reset
"$WL" acme "order export" > /dev/null
check "the running interval with its comment" "yes" "$(contains "$(statusOf "$WL_SESSION")" "ACME — order export")"
"$WL" parallel --from "$(clockAgo 30)" "other tab" > /dev/null
check "a parallel window line is nobody's interval" "yes" "$(contains "$(statusOf "$WL_SESSION")" "ACME — order export")"
check "another session sees nothing of it" "⏱ WL: —" "$(statusOf othersess)"
"$WL" stop > /dev/null
check "a stop shows as stopped" "yes" "$(contains "$(statusOf "$WL_SESSION")" "stopped")"

echo "wl-shims tests"

# --- stable entry points outside Claude's Bash tool ------------------------------------------------------
# A status line and a plain terminal do not get the plugin's bin/ on their PATH, and the plugin's folder
# changes with every update: the SessionStart hook keeps shims in ~/.claude/worklog/bin pointing at it.
shimHome="$tmp/home"
mkdir -p "$shimHome"
HOME="$shimHome" CLAUDE_PLUGIN_ROOT="${BIN%/bin}" "$BIN/wl-shims"
check "the session start writes a wl shim" "yes" "$([ -x "$shimHome/.claude/worklog/bin/wl" ] && echo yes || echo no)"
check "and a status line shim" "yes" "$([ -x "$shimHome/.claude/worklog/bin/wl-statusline" ] && echo yes || echo no)"
check "the shim runs the plugin's wl" "yes" "$(contains "$("$shimHome/.claude/worklog/bin/wl" config)" "categories:")"
before=$(ls -l "$shimHome/.claude/worklog/bin/wl")
sleep 1
HOME="$shimHome" CLAUDE_PLUGIN_ROOT="${BIN%/bin}" "$BIN/wl-shims"
check "an unchanged shim is not rewritten" "$before" "$(ls -l "$shimHome/.claude/worklog/bin/wl")"
HOME="$shimHome" CLAUDE_PLUGIN_ROOT="$tmp/elsewhere" "$BIN/wl-shims"
check "a shim to a plugin folder without the command is left alone" "$before" "$(ls -l "$shimHome/.claude/worklog/bin/wl")"
mkdir -p "$tmp/newer/bin" && cp -p "$BIN"/* "$tmp/newer/bin/"
HOME="$shimHome" CLAUDE_PLUGIN_ROOT="$tmp/newer" "$BIN/wl-shims"
check "an update points the shim at the new folder" "yes" "$(contains "$(cat "$shimHome/.claude/worklog/bin/wl")" "$tmp/newer/bin/wl")"

echo "wl-context-hook tests"

# --- the context hook must NOT stamp activity ----------------------------------------------------
# It fires before the turn runs; stamping here is what silently disabled the clip (see the
# interaction test above). It still has to deliver its context JSON.
rm -rf "$WL_ACTIVITY_DIR"
out=$(printf '{"session_id":"11112222-3333-4444-5555-666677778888"}' | "$CONTEXT_HOOK")
check "a user prompt does NOT stamp activity" "no" \
  "$([ -e "$WL_ACTIVITY_DIR/11112222" ] && echo yes || echo no)"
check "the context hook still emits its context" "yes" "$(contains "$out" "additionalContext")"

echo "wl-activity-hook tests"

# --- the hook stamps the session from the payload ----------------------------------------------
# WL_SESSION is unset here on purpose: the payload path is what runs in production.
rm -rf "$WL_ACTIVITY_DIR"
printf '{"session_id":"abcdef12-3456-7890-abcd-ef1234567890","tool_name":"Bash"}' | \
  env -u WL_SESSION -u CLAUDE_CODE_SESSION_ID "$HOOK"
check "hook writes the session file" "yes" "$([ -r "$WL_ACTIVITY_DIR/abcdef12" ] && echo yes || echo no)"
check "hook writes epoch|iso" "yes" \
  "$(grep -qE '^[0-9]+\|[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$WL_ACTIVITY_DIR/abcdef12" && echo yes || echo no)"
check "hook leaves no temp file behind" "" "$(find "$WL_ACTIVITY_DIR" -name '.*' -type f | head -1)"

# --- whitespace in the payload must not corrupt the tag ----------------------------------------
rm -rf "$WL_ACTIVITY_DIR"
printf '{ "session_id" : "beef1234-0000-0000-0000-000000000000" }' | \
  env -u WL_SESSION -u CLAUDE_CODE_SESSION_ID "$HOOK"
check "hook survives whitespace around the key" "yes" \
  "$([ -r "$WL_ACTIVITY_DIR/beef1234" ] && echo yes || echo no)"

# --- the jq fallback must produce the same tag as the fast path ---------------------------------
# An escaped character is what the parameter-expansion path cannot resolve on its own.
rm -rf "$WL_ACTIVITY_DIR"
printf '{"other":"a\\"b","session_id":"0badf00d-1111"}' | \
  env -u WL_SESSION -u CLAUDE_CODE_SESSION_ID "$HOOK"
check "hook falls back to jq for awkward payloads" "yes" \
  "$([ -r "$WL_ACTIVITY_DIR/0badf00d" ] && echo yes || echo no)"

# --- the env var wins and needs no payload ------------------------------------------------------
rm -rf "$WL_ACTIVITY_DIR"
env -u WL_SESSION CLAUDE_CODE_SESSION_ID=cafebabe-1111 "$HOOK" < /dev/null
check "hook prefers CLAUDE_CODE_SESSION_ID" "yes" \
  "$([ -r "$WL_ACTIVITY_DIR/cafebabe" ] && echo yes || echo no)"

# --- wl and the hook must agree on the tag -------------------------------------------------------
# A disagreement would not look broken: wl would just report "no activity data" forever.
# The interval is opened first, then the stamp is written 30 min later — reset() clears the
# activity dir, so stamping before it would be wiped.
reset 120 feedface
mkdir -p "$WL_ACTIVITY_DIR"
stampEpoch=$(( $(date +%s) - 1800 ))
printf '{"session_id":"feedface-2222-3333-4444-555566667777"}' | \
  env -u WL_SESSION -u CLAUDE_CODE_SESSION_ID "$HOOK"
printf '%s|%s\n' "$stampEpoch" "$(date -r "$stampEpoch" +%FT%T%z 2>/dev/null || date -d "@$stampEpoch" +%FT%T%z)" \
  > "$WL_ACTIVITY_DIR/feedface"
check "hook and wl derive the same tag" "yes" \
  "$(contains "$(WL_SESSION=feedface "$WL" stop)" "last activity")"

# --- a hook must never break the tool call it follows -------------------------------------------
printf 'not json at all' | CLAUDE_CODE_SESSION_ID= "$HOOK" > /dev/null 2>&1
check "hook exits 0 on garbage input" "0" "$?"
WL_ACTIVITY_DIR=/proc/nonexistent/nope "$HOOK" < /dev/null > /dev/null 2>&1
check "hook exits 0 when the directory is unwritable" "0" "$?"

# --- push / test against a stubbed curl ------------------------------------------------------------
# The stub records the URL and the payload it was called with and answers with WL_TEST_STATUS /
# WL_TEST_BODY (default: a clean, empty import) in the shape `curl -w '\n%{http_code}'` produces.
mkdir -p "$tmp/stubbin"
cat > "$tmp/stubbin/curl" <<'STUB'
#!/usr/bin/env bash
cat > "$WL_TEST_CURL_DIR/payload"
for arg in "$@"; do last="$arg"; done
printf '%s' "$last" > "$WL_TEST_CURL_DIR/url"
printf '%s\n' "$@" > "$WL_TEST_CURL_DIR/args"
if [ -n "${WL_TEST_CURL_RC:-}" ]; then
  # an unreachable host: curl prints its error and the "000" of -w, and fails
  echo "curl: (7) Failed to connect" >&2
  printf '\n000'
  exit "$WL_TEST_CURL_RC"
fi
clean='{"created":0,"updated":0,"alreadyPresent":0,"skipped":[]}'
printf '%s\n%s' "${WL_TEST_BODY-$clean}" "${WL_TEST_STATUS:-200}"
STUB
chmod +x "$tmp/stubbin/curl"
printf 'export ZOONES_URL=https://own.example/\nexport ZOONES_API_TOKEN=test-token\n' > "$tmp/wl.env"
chmod 600 "$tmp/wl.env"

# Runs `wl <subcommand>` against the stub with the test config only — nothing from the caller's
# shell or ~/.wow leaks in. Prints the output; the exit code lands in $tmp/rc.
remote() {
  rm -f "$tmp/payload" "$tmp/url" "$tmp/args"
  env -u ZOONES_URL -u ZOONES_API_TOKEN -u ZOONES_ACTIVITY_TYPE \
      PATH="$tmp/stubbin:$PATH" WL_ENV_FILE="$tmp/wl.env" WL_TEST_CURL_DIR="$tmp" \
      "$WL" "$@" 2>&1
  echo "$?" > "$tmp/rc"
}

# What /worktime hands to `wl push`: one interval with a category, one with an explicit split.
cat > "$tmp/intervals.json" <<'JSON'
[
  {"start": "2026-10-01T08:00:00", "end": "2026-10-01T10:00:00", "category": "ACME", "comment": "synthesised entry", "source": "worktime"},
  {"start": "2026-10-01T10:00:00", "end": "2026-10-01T11:00:00", "shares": {"ACME": 60, "OWN": 40}, "comment": "split entry", "source": "worktime"}
]
JSON

# "https://host/" is how a URL gets copied out of a browser; joined naively it becomes "//ng_api/…",
# which the server answers with 400 — so the push failed on configuration that looks right.
reset
out=$(remote push "$tmp/intervals.json")
check "push strips a trailing slash from ZOONES_URL" \
  "https://own.example/ng_api/workTimeManager/entries/commands/importIntervals?activityTypeId=DEVELOPMENT" \
  "$(cat "$tmp/url" 2>/dev/null)"
check "and names the normalised target" "yes" "$(contains "$out" "pushing to https://own.example as")"
check "push sends the intervals file as is" "$(cat "$tmp/intervals.json")" "$(cat "$tmp/payload" 2>/dev/null)"
check "push reports the import counts" "yes" "$(contains "$out" "0 imported, 0 updated, 0 already there, 0 need review")"

# The raw log is never sent: it records moments, and "until the next line" is how overnight hours
# got invented. Without a synthesised file there is nothing to push — and no request at all.
reset
out=$(remote push)
check "push without a file is refused" "2" "$(cat "$tmp/rc")"
check "and points at /worktime" "yes" "$(contains "$out" "/worktime")"
check "and sends nothing" "no" "$([ -e "$tmp/url" ] && echo yes || echo no)"

printf '{"start": "not a list"}' > "$tmp/not-a-list.json"
out=$(remote push "$tmp/not-a-list.json")
check "a file that is not a JSON list is refused before any request" "no" "$([ -e "$tmp/url" ] && echo yes || echo no)"
check "and named" "yes" "$(contains "$out" "not-a-list.json is not a JSON list")"

out=$(remote push "$tmp/no-such-file.json")
check "a missing file is named" "yes" "$(contains "$out" "cannot read")"
check "and refused" "2" "$(cat "$tmp/rc")"

# `test` goes through the very same request with an empty list: proves URL, token scope and
# activity type without booking anything.
reset
out=$(remote test)
check "test sends an empty list" "[]" "$(cat "$tmp/payload" 2>/dev/null)"
check "test hits the import endpoint" "yes" \
  "$(contains "$(cat "$tmp/url" 2>/dev/null)" "/ng_api/workTimeManager/entries/commands/importIntervals?")"
check "test reports success" "yes" "$(contains "$out" "connection OK")"
check "test exits 0 on success" "0" "$(cat "$tmp/rc")"

: > "$WL_LOG"
remote test > /dev/null
check "test also runs with an empty log" "[]" "$(cat "$tmp/payload" 2>/dev/null)"

# A refused token used to surface as "unexpected answer from Zoones:" with nothing after it.
out=$(WL_TEST_STATUS=401 WL_TEST_BODY= remote test)
check "a refused token is named as such" "yes" "$(contains "$out" "token refused")"
check "and points at the scope" "yes" "$(contains "$out" "TIME_TRACKING")"
check "and fails" "1" "$(cat "$tmp/rc")"

reset
out=$(WL_TEST_STATUS=401 WL_TEST_BODY= remote push "$tmp/intervals.json")
check "push names a refused token too" "yes" "$(contains "$out" "token refused")"

out=$(WL_TEST_STATUS=400 WL_TEST_BODY='{"message":"bad things"}' remote test)
check "a server error carries status and message" "yes" "$(contains "$out" "(HTTP 400): bad things")"
check "and fails" "1" "$(cat "$tmp/rc")"

# The status is split off at the LAST newline — a pretty-printed body must stay whole.
out=$(WL_TEST_STATUS=400 WL_TEST_BODY=$'{\n  "message" : "bad things"\n}' remote test)
check "a multi-line body is parsed whole" "yes" "$(contains "$out" "(HTTP 400): bad things")"

# An unreachable host is the most likely thing `test` is run to find.
out=$(WL_TEST_CURL_RC=7 remote test)
check "an unreachable host is named" "yes" "$(contains "$out" "cannot reach https://own.example")"
check "and fails with 1, not curl's code" "1" "$(cat "$tmp/rc")"

# --- booked: what Zoones already has, hand entries included -----------------------------------------
# /worktime reads this before it proposes intervals, so a manual entry is left alone instead of
# coming back as a clash after the push.
booked='[
 {"workStart":"2026-10-05T08:00:00","workEnd":"2026-10-05T10:30:00","comment":"call with ACME","billed":true,"inactive":false,
  "shares":[{"scope":{"scopeId":"ACME"},"share":null}]},
 {"workStart":"2026-10-05T06:30:00","workEnd":"2026-10-05T08:00:00","comment":"cutover","externalId":"wl:2026-10-05T06:30:worktime",
  "billed":false,"inactive":false,"shares":[{"scope":{"scopeId":"ACME"},"share":50},{"scope":{"scopeId":"OWN"},"share":50}]},
 {"workStart":"2026-10-05T11:00:00","workEnd":"2026-10-05T12:00:00","comment":"typo entry","billed":false,"inactive":true,"shares":[]}
]'
out=$(WL_TEST_BODY="$booked" remote booked 2026-10-05 2026-10-06)
check "booked reads the entries endpoint" "https://own.example/ng_api/workTimeManager/entries" "$(cat "$tmp/url" 2>/dev/null)"
check "as a GET" "yes" "$(contains "$(cat "$tmp/args" 2>/dev/null)" "-G")"
check "from the first day's start" "yes" "$(contains "$(cat "$tmp/args" 2>/dev/null)" "from=2026-10-05T00:00:00")"
# the upper bound is exclusive on the server: midnight after the last day, not 23:59:59
check "to midnight after the last day" "yes" "$(contains "$(cat "$tmp/args" 2>/dev/null)" "to=2026-10-07T00:00:00")"
check "sends no body" "" "$(cat "$tmp/payload" 2>/dev/null)"
check "lists entries in start order" "yes" "$(contains "$(printf '%s' "$out" | sed -n 2p)" "06:30-08:00")"
check "names a hand entry as manual" "yes" "$(contains "$out" "call with ACME  [manual, billed]")"
check "names a pushed one as wl, with its split" "yes" "$(contains "$out" "ACME=50,OWN=50")"
check "and marks it" "yes" "$(contains "$out" "cutover  [wl]")"
check "shows a struck-out entry as such" "yes" "$(contains "$out" "[manual, struck out]")"
check "but does not count it" "yes" "$(contains "$out" "4.00h booked")"
check "booked exits 0" "0" "$(cat "$tmp/rc")"

# a timer started in Zoones has no end yet — it claims everything after it, so it has to say so
running='[
 {"workStart":"2026-10-05T13:00:00","workEnd":null,"comment":"timer","billed":false,"inactive":false,
  "shares":[{"scope":{"scopeId":"ACME"},"share":null}]}
]'
out=$(WL_TEST_BODY="$running" remote booked 2026-10-05)
check "marks a running entry" "yes" "$(contains "$out" "timer  [manual, running]")"

out=$(remote booked)
check "booked defaults to today" "yes" "$(contains "$(cat "$tmp/args" 2>/dev/null)" "from=$(date +%F)T00:00:00")"

out=$(WL_TEST_BODY='[]' remote booked 2026-10-05)
check "an empty period says so" "yes" "$(contains "$out" "nothing booked")"
check "a single day is from and to" "yes" "$(contains "$(cat "$tmp/args" 2>/dev/null)" "to=2026-10-06T00:00:00")"
out=$(WL_TEST_BODY='[]' remote booked 2026-10-31)
check "the day after crosses the month" "yes" "$(contains "$(cat "$tmp/args" 2>/dev/null)" "to=2026-11-01T00:00:00")"

for bad in "5.10." "2026-13-45" "2026-10-06 2026-10-05"; do
  # shellcheck disable=SC2086 # the reversed range is two words on purpose
  out=$(remote booked $bad)
  check "booked refuses '$bad'" "2" "$(cat "$tmp/rc")"
  check "  before any request" "no" "$([ -e "$tmp/url" ] && echo yes || echo no)"
done

out=$(WL_TEST_STATUS=500 WL_TEST_BODY='"oops"' remote booked 2026-10-05)
check "a non-object error body is reported, not a stack trace" "yes" "$(contains "$out" "reading entries failed (HTTP 500)")"

out=$(WL_TEST_STATUS=401 WL_TEST_BODY= remote booked 2026-10-05)
check "booked names a refused token" "yes" "$(contains "$out" "token refused")"

echo
if [ "$fail" -eq 0 ]; then
  echo "Result: $pass passed"
  exit 0
fi
echo "Result: $pass passed, $fail FAILED"
exit 1
