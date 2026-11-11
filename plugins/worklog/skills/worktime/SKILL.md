---
name: worktime
description: "Generate a per-day, per-category interval list for the time-tracking app. Runs gather-worktime.sh against a 7-day window (any start date, weekend included) over the configured repos and synthesises billable intervals from the worklog, your keystrokes, git activity, IDE sessions and build logs. Invoke with /worktime [YYYY-MM-DD]; without a date it catches up from the last day already booked to today."
---

# /worktime — Worktime Interval Synthesis

Produce a clean, paste-ready list of work intervals grouped **per day, per category**, plus a **booking view** that
fans generic work out to the billing scopes via the worklog configuration (`~/.claude/worklog/config.json` or
`$WL_CONFIG` — categories, their `shares`, `rounding`; `wl config` shows what applies), for the user to enter into
their time-tracking app — or to push there with `wl push` (Step 4b).

The examples below use the neutral names of `wl config`'s example — categories `ACME`, `BETA`, `CLIENTS` (both
clients), `CLIENTS+OWN`, `OWN` (not debitable); scopes `ACME`, `BETA`, `OWN`. The user's own names come from
their configuration.

**Two layers, never mix them:**

1. **Tracked intervals** = what actually happened (category from the evidence). This is the audit trail.
2. **Booking view** = tracked hours pushed through the categories' `shares` (generic product work is usable by all
   clients, so it is split across their scopes and the own one). Only this layer goes into the time-tracking app.

## Step 1 — Determine the start date

The argument (if any) is the start date of the range to analyse. **Any day is fine** — the script covers seven days
from there, both ends inclusive, so a week started on Monday includes its Sunday. For a different range pass both
dates: `gather-worktime.sh FROM TO`.

- If the user passed a date (e.g. `/worktime 2026-04-27`), use it.
- If no date was provided, **catch up from what the time-tracking instance already holds** (needs the booking
  backend; without one, ask for the start date):
  1. `wl booked <today − 31 days> <today>` — the instance's entries of the last month.
  2. The **last synthesised day** = the latest date with a `[wl]` entry (struck-out entries don't count). `[manual]`
     entries do NOT mark a day as synthesised — a day with only hand entries still needs its synthesis around them.
  3. The range is **that day → today**, both inclusive: `gather-worktime.sh <last day> <today>`. On the last
     synthesised day itself, propose only blocks that start at or after the end of its latest `[wl]` entry — the
     earlier gaps of that day were already judged (breaks, absence) and are not re-proposed. All later days are
     synthesised in full.
  4. Say the derived range in one line before the output ("last booking 2026-10-12 07:45 → catching up to today").
     Today's sessions — this one included — may still be running: book them up to now and say so.
  - No `[wl]` entry in the last 31 days → ask the user for the start date ("Which day should I start from?
    (format: YYYY-MM-DD)") instead of guessing.

Validate the date format only (`YYYY-MM-DD`). Do not require Monday.

## Step 2 — Run gather-worktime.sh

`gather-worktime.sh` is the plugin's, on the Bash tool's PATH (outside Claude: `~/.claude/worklog/bin/gather-worktime.sh`).

```bash
gather-worktime.sh <YYYY-MM-DD> 2>&1 | tee /tmp/worktime-run.log            # 7 days from the given date
gather-worktime.sh <FROM> <TO> 2>&1 | tee /tmp/worktime-run.log             # catch-up range from Step 1
```

The script writes its full report to `/tmp/worktime-YYYY-WNN.txt`. Read that file once it finishes — it has more
structured sections than the stdout tee.

**What it scans comes from the worklog configuration**: `author`, the `repos` (each with a `name` that tags work no
path hint matched, `pathHints` path part → category, `buildLogs` globs) and the categories' `keywords` for commit
subjects. A second clone of a repo already listed is skipped (same commits twice otherwise); without `repos` the git
repo of the current directory is scanned. The header lists every repo scanned — check it: work in a repo that is
missing there is invisible to the whole synthesis.

**Sanity check the header:** the report's `Range` line shows the start date with weekday name (e.g. `2026-04-27
(Monday)`). Confirm it matches what the user asked for — if the date or weekday looks off, stop and clarify.

## Step 2b — Read what is already booked

```bash
wl booked <FROM> <TO>      # YYYY-MM-DD, the days you are about to synthesise
```

The user may also record time by hand in the time-tracking app. Those `[manual]` entries are **fixed**: the hours
they cover are already decided, so the synthesis never proposes an interval over them — cut the proposed block
around a manual entry (or drop it) and name the cut in the assumptions list. `[wl]` entries are earlier pushes of
this skill: a day that has them was synthesised before — re-sending the same blocks is a no-op, but MOVED blocks
would land as new entries and clash with the old ones, so show the user what is there and ask before
re-synthesising such a day. `struck out` entries count as not booked. Without this step a manual entry surfaces only
after the push, as an `OVERLAP` refusal.

## Step 3 — Synthesise intervals per day per category

Walk through the report and, **for each day in the range that has activity — weekends and holidays included** —
build a day block of the form:

```
Monday 2026-04-27
  09:00–12:30  CLIENTS+OWN  (3.5h)  — order list: search and paging
  13:00–15:00  ACME         (2.0h)  — cancellation handling
  15:00–17:30  OWN          (2.5h)  — build pipeline
                            Total: 8.0h
```

Rules for synthesis:

- **Worklog first**: read the worklog (`wl config` names its file) for the range. Two line formats coexist: new
  `ISO_TIMESTAMP|SESSION|CATEGORY|comment` (field-2 is an 8-char session tag) and legacy
  `ISO_TIMESTAMP|CATEGORY|comment` (field-2 is a category keyword — discriminate on that). Each entry opens an
  interval and closes the previous one **of the same session**; `STOP` closes without opening. Any 3-field line
  belongs to one global sequential timeline of its own.
- **Overlapping sessions — one person, never booked twice.** Reconstruct one timeline per session, then lay them on
  one wall clock. Wherever two or more sessions have an open interval at the same time:
    - **Inside a declared parallel window, split it.** `wl parallel --from 14:00 --to 15:12 "support"` writes
      `FROM_ISO|parallel|PARALLEL|TO_ISO|DECLARING_SESSION|comment` — pseudo-session `parallel`, never anybody's
      interval. The PARTIES are the declaring session plus every session that STARTS an interval within the window
      (a non-STOP entry — a STOP inside the window only ends the earlier work); each counts as present for the whole
      window (the parallel work is often stamped only in short bursts while it ran throughout), and a session merely
      still open at the window's start is NOT a party (that is the earlier work, not the parallel one). The window's
      wall-clock time is divided EVENLY among the parties, each part keeping its own session's category or split —
      when a party has several entries in the window, by their time-weighted categories (one ACME/OWN session + one
      BETA session over 72 min = 36 min ACME/OWN + 36 min BETA). Book it as one interval over the window with the
      split folded into `shares` (here ACME=25, OWN=25, BETA=50), which never clashes with itself; say so in the
      assumptions. The parties' own entries inside the window are consumed by it — not booked a second time.
    - **Undeclared overlap: do NOT split, ask.** List each one in the assumptions list with both sessions, their
      categories and the minutes, and let the user decide (split, one of them, or a `wl parallel` line for next
      time). Never pick silently — a guessed split is exactly the invented time this whole procedure exists to
      avoid.
  The parts of a window outside any overlap stay with the session that was open there alone.
  **Declared intervals are the highest-priority evidence and override all inference below.**
  Entries are written by `wl` and by Claude sessions in quasi-realtime. Two forgiveness rules for missing `STOP`s:
    - **Dangling interval** (day's last entry has no STOP): close it at the last OTHER activity evidence of that day
      (last commit / build log / IDE shutdown) — never at midnight, and **never past 21:00 of the day it started
      on**. An interval that would run into the next morning is the single biggest source of invented hours:
      deriving purely from the worklog produced entries of 25, 57 and 87 hours. Mark `(end inferred)` in the
      assumptions list.
    - **Breaks inside a long declared interval**: the worklog fixes the CATEGORY, not continuous presence — when the
      other evidence shows a ≥45 min idle gap (typically around lunch), cut the gap out of the interval and keep the
      category on both sides. Flag it for confirmation.
- **Explicit share split**: the CATEGORY field may instead hold a split the user stated with `wl acme=60,own=40` —
  `ACME=60,OWN=40` (percent per billing scope, adds up to 100) or `ACME,OWN` (even split). Such an interval keeps
  its split through every step: it is not mapped to one of the configured categories, Step 3b books it by its own
  weights instead of a category's `shares`, and Step 4b sends it as `shares`, never as `category`. A break cut out
  of it (rule above) leaves both halves with the same split.
- **Tracked category** is one of the config's `categories` (each with a `describe` saying what belongs there; the
  one marked `"default": true` is the fallback). Where no worklog entry exists, infer:
    - File-path evidence (Section 8 / Section 1): the tags come from the repos' `pathHints` (e.g. `clients/acme` →
      ACME); files of two categories → the category covering both (ACME+BETA → CLIENTS). Trust file-level tags over
      subject keywords when they conflict.
    - Work tagged with the repo name (no path hint matched): decide by the categories' `describe` texts — they say
      where core feature work goes (the `"default": true` category when nothing narrower applies) and what is not
      debitable (infrastructure, CI, tooling, test initiatives, refactoring chores, release engineering).
    - Core work clearly commissioned by ONE client → that client; flag it in the assumptions list. Every non-obvious
      classification goes into the assumptions list for correction.
- **PRESENCE beats every other anchor — the user's own keystrokes.** Claude session transcripts live in
  `~/.claude/projects/<project folder>/*.jsonl` — one folder per repo of the configuration (its path with `/` and
  `.` turned into `-`: `/home/me/projects/app` → `-home-me-projects-app`); each line has a `timestamp`, and a line
  with `type == "user"`, no `toolUseResult` and textual content is a message the PERSON typed. Everything else in
  this list — commits, build logs, modified files — can be produced by an agent working while nobody is there. A
  keystroke cannot.

  ```bash
  # per day: first/last input, how many, and the longest silence
  python3 - <<'PY'
  import json,glob,os,re
  from collections import defaultdict
  from datetime import datetime
  LOCAL=datetime.now().astimezone().tzinfo; byday=defaultdict(list)
  # the transcripts of every repo in the worklog configuration (else of the current directory)
  cfg=os.path.expanduser(os.environ.get("WL_CONFIG","~/.claude/worklog/config.json"))
  repos=[os.path.expanduser(r["path"]) for r in (json.load(open(cfg)).get("repos") or [])] if os.path.exists(cfg) else []
  dirs=[os.path.expanduser("~/.claude/projects/"+re.sub(r"[/.]","-",os.path.realpath(p))) for p in (repos or [os.getcwd()])]
  for f in [f for d in dirs for f in glob.glob(d+"/*.jsonl")]:
      for line in open(f):
          try: d=json.loads(line)
          except: continue
          if d.get("type")!="user" or "timestamp" not in d or d.get("toolUseResult") is not None: continue
          m=d.get("message") or {}; c=m.get("content")
          if isinstance(c,list):
              if not any(isinstance(x,dict) and x.get("type")=="text" for x in c): continue
          elif not isinstance(c,str): continue
          ts=datetime.fromisoformat(d["timestamp"].replace("Z","+00:00")).astimezone(LOCAL)
          byday[ts.date()].append(ts)
  for d in sorted(byday):
      ts=sorted(byday[d]); gaps=[(b-a).total_seconds()/3600 for a,b in zip(ts,ts[1:])]
      print(f"{d} {d:%a} {ts[0]:%H:%M}-{ts[-1]:%H:%M} {len(ts):>4} inputs, longest silence {max(gaps) if gaps else 0:.1f} h")
  PY
  ```

  **Rule: an interval counts only as far as the person typed in it.** Clip its end to the last input inside it plus
  ~15 min of grace. Measured over a month: this removed 16 h across three days where something ran unattended, and
  left a genuinely long 20-hour day almost untouched (90 inputs, longest silence 2.8 h) — it cuts absence, not
  effort.

  **But watching the agent IS work — don't clip too radically.** When the user works together with an agent, they
  usually sit there, follow what it does, review the result and test it, without typing. Only own keystrokes count
  as inputs (task notifications, messages from other sessions, "session is being continued" summaries and
  auto-loaded skill bodies are not keystrokes), but a silence between two own inputs counts as work when **the agent
  was working in it** (assistant messages in any session of the configured repos) **and the next own input came
  within ~25 min of the agent's last output** — that is the user reacting to the result after reviewing or testing
  it. Cut only the silences in which no agent was active, or the user came back long after the agent had finished.
  After the day's LAST input, an agent that kept running without any reaction is NOT counted beyond the grace — flag
  it as a question instead ("agent ran until 16:27, were you still on it?"). Spend the care on client-billable
  blocks: time on a not-debitable category is not invoiced, the user does not need it precise — don't raise
  borderline questions about it.
- **Anchors for start/end of work day**:
    - First commit of day (Section 3) = lower bound for "work started by then".
    - IntelliJ `IDE STARTED` (Section 4) = better start anchor when present.
    - Last commit + IDE shutdown / last build log entry (Sections 4 + 6) = end anchor.
    - Java process launches (Section 5) anchor mid-day session boundaries.
- **Lunch / breaks**: insert a 30–60 min gap around 12:00–13:00 if commit gaps support it; otherwise leave the day
  continuous.
- **Switching cost**: when consecutive commits flip between categories, attribute the gap minutes to the category of
  the **next** commit (you were preparing for it).
- **No-commit days**: if a weekday has zero commits but Section 4 (IDEA log) or Section 6 (build logs) shows
  activity, still produce an interval block citing the evidence; mark `(low confidence)`. If there's no evidence at
  all, output `Tuesday 2026-04-28: (no recorded activity)` — never invent hours.
- **Only the configured repos' work is booked** — their sessions, commits and the worklog. Activity in other
  folders (private projects, anything not in `repos`) is not time to record, even when it shows up in
  `~/.claude/projects/`; don't offer to synthesise it.
- **Weekend and holiday work is booked on the day it happened** — never move it to the preceding working day.
- **Summarise the texts to the level the invoice needs.** One entry per day and per category, not per worklog line:
  the client neither needs nor understands a class name or a search detail. Fold the day's lines of one category
  into a single plain description of the work ("Dangerous goods: transport documents"). The detail stays in the
  worklog, which remains the audit trail — this is the billing view, and it is a judgement, not a mechanical join.
- **The comment IS the invoice text — word it for the whole month, not the block.** A monthly invoice typically
  prints every DISTINCT comment of the period as one line of its position; only identical texts collapse. So:
    - **One fixed wording per topic, reused verbatim** on every block, every day of the month. Before writing
      comments, read the month so far (`wl booked <YYYY-MM-01> <today>`) and take over the texts already there. A
      second phrasing of the same topic is a second invoice line.
    - **Topic level, no block detail**: no "…, completion" / "continued" variants for a block that continues after a
      break, no per-day sub-steps in the text. Aim at a handful of topics per client and month.
    - **Client-facing wording**: no class/field names, no internal tool or interface names, no order/ticket/article
      numbers — single-case analyses go under one collective topic ("Support: analysis of individual cases").
  The detail a client may ask for later stays in the worklog.
- **Already booked time is fixed** (`wl booked` from Step 2b, which reads the instance's entries per day — hand
  entries included): build the day's intervals AROUND the `[manual]` entries, never across them, and show them in
  the day block as `[booked]` lines so the day total stays reconcilable with what the instance will hold. Their
  hours are not re-proposed and not pushed.
- **Round to 15 min**. Total per day must equal the sum of intervals.
- **Type column**: from Section 8 — `DEV` vs `MAINT`. Append it after the category when it isn't pure dev (e.g.
  `ACME/MAINT`).

## Step 3b — Apply the booking allocation

Read the worklog configuration (`wl config` shows what applies). For **each day**, take the per-category tracked
totals from Step 3 and expand them into booking buckets (the config's `scopes`):

- Each tracked category maps to bucket weights via its `shares` (normalized per category) — the config says it, not
  this file; never assume a split from memory.
- **Round per day per bucket to `rounding.granularityMinutes` with largest-remainder so the day's booking total
  equals the day's tracked total exactly.** When a leftover quarter-hour must land somewhere, give it to
  `rounding.leftoverTo` — the clients never pay the rounding.
- An interval the user explicitly declared as client-specific overrides the category-level rule (e.g. "that
  afternoon was Acme-only" → 100% ACME for that block).
- An interval with an explicit share split (`ACME=60,OWN=40` from `wl`) is booked by exactly those weights (an
  unweighted `ACME,OWN` = equal shares at whole percent rounded DOWN, as the instance books them: `ACME,BETA,OWN` is
  33/33/33 and 1% is billed to nobody), never by a category's `shares`.

## Step 4 — Output format

Print the full range as one fenced block so the user can paste it directly:

````
```
WORKTIME — 2026 Week 18 (Mon 2026-04-27 → Sun 2026-05-03)

Monday 2026-04-27
  09:00–12:30  CLIENTS+OWN   3.5h  — order list: search and paging
  13:00–15:00  ACME          2.0h  — cancellation handling
  15:00–17:30  OWN/MAINT     2.5h  — build pipeline
                            Total: 8.0h

Tuesday 2026-04-28
  …

Week total: CLIENTS+OWN 18.0h | ACME 12.5h | OWN 4.0h | (34.5h)

BOOKING VIEW (config shares: CLIENTS+OWN → 1/3 each · CLIENTS → 50/50 · OWN not debitable)

Monday 2026-04-27      ACME 3.25h | BETA 1.25h | OWN 1.0h   (tracked 5.5h: CLIENTS+OWN 3.5 + ACME 2.0)
Tuesday 2026-04-28     …

Booking total: ACME 18.5h | BETA 6.0h | OWN 10.0h | (34.5h)
```
````

The booking view shows **per-day durations per bucket** (most time-tracking apps take durations; if the app needs
intervals, slice each day's blocks proportionally on request). Always print the tracked total next to it so the two
layers stay reconcilable.

## Step 4b — Offer to push the intervals

Optional: `wl push` sends the tracked intervals of Step 3 to a time-tracking instance (a Zoones instance's work time
import), so the list does not have to be retyped anywhere. **Offer it, never do it unasked** — a push writes into a
live instance, and the synthesis is a proposal until the user has read it.

Write the file to the scratchpad and hand it to `wl` — it knows target, token and endpoint (its own configuration
file, see `wl help`), names the instance it pushes to, and prints the result. Never call the endpoint by hand:

```bash
wl test                      # optional: URL, token scope, activity type — books nothing
wl push <scratchpad>/intervals.json
```

`intervals.json` is a list of `{start, end, category | shares, comment, source}` — each interval carries exactly ONE
of `category` and `shares`:

- `start` / `end` are LOCAL wall-clock times WITHOUT an offset: `"2026-10-06T05:15:00"`. An ISO offset
  (`…T05:15:00+02:00`) fails the whole file and nothing is stored.
- `category` is the TRACKED category (one of the config's `categories`) — the instance owns the split into billing
  scopes, so do NOT apply the config's `shares` here. The booking view of Step 3b stays a report; sending it
  pre-split would encode the weights twice, in two places that then drift.
- `shares` only for an interval the USER split explicitly (`wl acme=60,own=40`, or stated in the conversation):
  percent per billing scope id, e.g. `{"ACME": 60, "OWN": 40}`, adding up to 100; `{"ACME": null, "OWN": null}`
  splits evenly. Never derive `shares` from the config's category `shares` — that is exactly the double encoding the
  `category` rule forbids.
- `comment` is the summarised text, not the worklog line — and it is printed on the invoice; see the month-wide
  wording rule in Step 3.
- `source` plus the start time form the entry's identity, which is what makes re-sending the same synthesis a no-op.
  Use a value that is stable for the same piece of work — `worktime` — and be aware that a re-run which MOVES an
  interval's start creates a second entry rather than correcting the first. Same source + start with a different
  end, comment or split CORRECTS the entry (`wl push` reports it as "updated") — that is how a month's texts are
  reworded before the invoice. The push wins: a `[wl]` entry the user edited by hand gets the pushed
  end/comment/split back, so take a hand-corrected `[wl]` text from `wl booked` into the file rather than re-sending
  the old one. Struck-out entries, entries whose start was moved by hand and entries in a settled period are not
  changed.

`wl push` prints what was stored, what was already known, and what was refused (implausible length, a clash with
time already recorded, a settled period). Read the refusals out to the user; they are the part that needs a person.
Then run `wl booked <FROM> <TO>` once more and check the day totals against the synthesis — that is the read-back of
what the instance actually holds.

After the block, list **assumptions / low-confidence calls** as a short bullet list so the user can sanity-check
before pasting:

- "Tuesday 13:00–14:00 attributed to ACME based on file paths only (subject was generic)."
- "Wednesday end time 17:00 inferred from last build log; no IDE shutdown event."

## Step 5 — Offer to refine

End with: "Want me to shift any block, split a category, or recompute with a different lunch window?"

## Notes

- Never call `gather-worktime.sh` without an explicit start date — the auto-detect mode picks the current Monday,
  which is rarely what's wanted. Without a `/worktime` argument the dates come from the instance (Step 1), not from
  the script.
- The script scans the configuration's `repos`. For a one-off look at a single other repo set `REPO_DIR=...`; for
  good, add it to `repos` — work in a repo that is not listed never reaches the booking.
- Don't paraphrase commit subjects; quote the meaningful keyword(s) so the time-tracking entry stays auditable.
