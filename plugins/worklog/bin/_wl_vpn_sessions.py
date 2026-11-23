#!/usr/bin/env python3
"""VPN sessions from Drawbridge's worktime log, per day — section 9 of gather-worktime.sh.

Usage: _wl_vpn_sessions.py FROM TO        (YYYY-MM-DD, both inclusive)

Reads the worklog configuration (WL_CONFIG, default ~/.claude/worklog/config.json), key "vpn":
  "vpn": {
    "logDir":   "<folder with worktime-YYYY-MM.jsonl>",          default: Drawbridge's own folder
    "profiles": { "<VPN name glob | VPN id>": "<CATEGORY>" }      which VPN is booked to which category
  }
A profile key matches the VPN's id exactly, or its name as a case-insensitive glob ("Acme*"); ids win over
names, then the first matching glob in the order written.

Format of the log: Drawbridge's docs/worktime-log.md, v1. Per session this prints, clipped to each day:
  - the span the VPN was up, per reason (a `reason` line applies from its `since`: a new reason splits the
    session, a correction replaces the reason it corrects),
  - "work" = minutes with payload through the tunnel (`active`) while someone was at the Mac (`present`),
  - `active` minutes in which the app did not run (`unobserved`: presence unknown) separately,
  - the connections launched through it.
Sessions without an `end` are counted up to the `to` of their last checkpoint and marked open.
"""

import fnmatch
import glob
import json
import os
import sys
from datetime import date, datetime, timedelta

FORMAT_VERSION = 1
DEFAULT_LOG_DIR = "~/Library/Application Support/Drawbridge/Worktime"


def parseTime(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).astimezone()
    except (TypeError, ValueError):
        return None


def parseIntervals(value):
    ret = []
    for pair in value or []:
        if isinstance(pair, list) and len(pair) == 2:
            a, b = parseTime(pair[0]), parseTime(pair[1])
            if a and b and a < b:
                ret.append((a, b))
    return merge(ret)


def merge(intervals):
    ret = []
    for a, b in sorted(intervals):
        if ret and a <= ret[-1][1]:
            ret[-1] = (ret[-1][0], max(ret[-1][1], b))
        else:
            ret.append((a, b))
    return ret


def intersect(xs, ys):
    ret = []
    i = j = 0
    while i < len(xs) and j < len(ys):
        a, b = max(xs[i][0], ys[j][0]), min(xs[i][1], ys[j][1])
        if a < b:
            ret.append((a, b))
        if xs[i][1] < ys[j][1]:
            i += 1
        else:
            j += 1
    return ret


def clip(intervals, a, b):
    return intersect(intervals, [(a, b)]) if a < b else []


def minutes(intervals):
    return round(sum((b - a).total_seconds() for a, b in intervals) / 60)


def hm(t):
    # Nearest minute: an end at 12:41:57 reads 12:42.
    return (t + timedelta(seconds=30)).strftime("%H:%M")


def spans(intervals):
    return ", ".join(f"{hm(a)}–{hm(b)}" for a, b in intervals) or "—"


def expandHome(path):
    return os.path.expanduser(path) if path else path


def loadConfig():
    path = expandHome(os.environ.get("WL_CONFIG") or "~/.claude/worklog/config.json")
    try:
        with open(path, encoding="utf-8") as f:
            ret = json.load(f).get("vpn") or {}
    except (OSError, ValueError):
        ret = {}
    return ret


def categoryOf(vpn, profiles):
    vid, name = vpn.get("id") or "", (vpn.get("name") or "").lower()
    if vid in profiles:
        return str(profiles[vid]).upper()
    for key, cat in profiles.items():
        if fnmatch.fnmatchcase(name, key.lower()):
            return str(cat).upper()
    return None


def readLines(logDir):
    """Every valid v1 line of every month file — sessions can span months, the files are small."""
    ret = []
    for path in sorted(glob.glob(os.path.join(logDir, "worktime-*.jsonl"))):
        with open(path, encoding="utf-8", errors="replace") as f:
            for raw in f:
                try:
                    line = json.loads(raw)
                except ValueError:
                    continue  # a line cut off by a crash
                if not isinstance(line, dict) or not isinstance(line.get("v"), int) or line["v"] > FORMAT_VERSION:
                    continue
                ret.append(line)
    return ret


class Session:
    def __init__(self, sid):
        self.sid = sid
        self.start = None
        self.end = None
        self.reasons = []
        self.checkpoints = []
        self.runs = []  # [start, end] of the connections through it whose end Drawbridge saw (RDP, …)
        self.lastSign = None  # the newest moment any line shows it alive

    def seen(self, t):
        if t and (self.lastSign is None or t > self.lastSign):
            self.lastSign = t

    def base(self):
        return self.end or self.start or (self.checkpoints[0] if self.checkpoints else None) or (self.reasons[0] if self.reasons else {})

    def build(self):
        base = self.base()
        self.vpn = base.get("vpn") or {}
        self.device = base.get("device") or ""
        self.protocol = (self.end or self.start or {}).get("protocol") or ""
        cps = sorted(self.checkpoints, key=lambda c: c.get("to") or "")
        self.begin = parseTime((self.end or self.start or {}).get("start")) or (parseTime(cps[0].get("from")) if cps else None)
        self.dataUntil = None
        if self.end:
            self.finish = parseTime(self.end.get("end"))
            source = [self.end]
            self.open = False
        else:
            # Activity data reaches the last checkpoint; the span reaches the last sign of life — a reason
            # change or a connection run ending after it shows the VPN was still up.
            tos = [parseTime(c.get("to")) for c in cps if parseTime(c.get("to"))]
            self.dataUntil = max(tos) if tos else None
            self.finish = max(t for t in (self.begin, self.dataUntil, self.lastSign) if t) if self.begin else None
            source = cps
            self.open = True
        self.runs = merge(self.runs)
        self.active = merge([i for s in source for i in parseIntervals(s.get("active"))])
        self.present = merge([i for s in source for i in parseIntervals(s.get("present"))])
        self.unobserved = merge([i for s in source for i in parseIntervals(s.get("unobserved"))])
        # Reason timeline: the start's reason from `start`; then each `reason` line in `ts` order sets its reason
        # from its `since` on (a correction reaches back, a new reason starts at `ts`; lines without `since`
        # came from builds before it and count from `ts`), replacing whatever applied from there before.
        changes = sorted((parseTime(r.get("ts")), parseTime(r.get("since")) or parseTime(r.get("ts")), r.get("reason"))
                         for r in self.reasons if parseTime(r.get("ts")))
        if self.start:
            first = self.start.get("reason")
        elif changes:
            first = None  # the start line is lost: the reason before the first change is unknown
        else:
            first = (self.end or {}).get("reason")
        self.segments = []
        if self.begin and self.finish:
            points = [(self.begin, first)]
            for _, since, reason in changes:
                since = max(since, self.begin)
                if since < self.finish:
                    points = [p for p in points if p[0] < since] + [(since, reason)]
            for k, (t, r) in enumerate(points):
                nxt = points[k + 1][0] if k + 1 < len(points) else self.finish
                if t < nxt:
                    self.segments.append((t, nxt, r))
        return self


def main():
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    first, last = date.fromisoformat(sys.argv[1]), date.fromisoformat(sys.argv[2])
    config = loadConfig()
    profiles = config.get("profiles") or {}
    logDir = expandHome(config.get("logDir") or DEFAULT_LOG_DIR)

    print(f"Log       : {logDir}")
    if profiles:
        print("Profiles  : " + ", ".join(f"{k} → {str(v).upper()}" for k, v in profiles.items()))
    else:
        print('Profiles  : (none — map VPN names to categories in "vpn.profiles" of the worklog configuration)')
    if not os.path.isdir(logDir):
        print("\n(no Drawbridge worktime log — Drawbridge ▸ Settings ▸ Worktime Tracking, and Log to Worktime per VPN)")
        return 0
    print()

    sessions, runs, launches = {}, {}, []
    for line in readLines(logDir):
        kind, event, sid = line.get("kind"), line.get("event"), line.get("session")
        if not sid:
            continue
        if kind == "vpn":
            s = sessions.setdefault(sid, Session(sid))
            if event == "start":
                s.start = line
            elif event == "end":
                s.end = line
            elif event == "reason":
                s.reasons.append(line)
            elif event == "checkpoint":
                s.checkpoints.append(line)
        elif kind == "connection":
            if event == "launch":
                launches.append(line)
            elif event in ("start", "end"):
                runs.setdefault(sid, {})[event] = line
    for s in sessions.values():
        for line in s.reasons + s.checkpoints:
            s.seen(parseTime(line.get("ts")))
    conns = []  # (time, end | None, line, vpn session id)
    for line in launches:
        t = parseTime(line.get("ts"))
        if t:
            conns.append((t, None, line, line.get("vpnSession")))
            if line.get("vpnSession") in sessions:
                sessions[line["vpnSession"]].seen(t)
    for run in runs.values():
        line = run.get("end") or run.get("start")
        t, end = parseTime(line.get("start")) or parseTime(line.get("ts")), parseTime(line.get("end"))
        if not t:
            continue
        conns.append((t, end, line, line.get("vpnSession")))
        owner = sessions.get(line.get("vpnSession"))
        if owner:
            owner.seen(end or t)
            if end and t < end:
                owner.runs.append((t, end))
    conns.sort(key=lambda c: c[0])
    built = [s.build() for s in sessions.values()]
    built = [s for s in built if s.begin and s.finish]
    devices = {s.device for s in built}
    byId = {s.sid: s for s in built}
    conns = [(t, end, line, byId.get(sid)) for t, end, line, sid in conns]

    day = first
    while day <= last:
        dayStart = datetime(day.year, day.month, day.day).astimezone()
        nxt = day + timedelta(days=1)
        dayEnd = datetime(nxt.year, nxt.month, nxt.day).astimezone()
        print(f"── {day.isoformat()} ({day.strftime('%A')}) ──")
        todays = sorted((s for s in built if s.begin < dayEnd and s.finish > dayStart), key=lambda s: s.begin)
        totals = {}
        for s in todays:
            cat = categoryOf(s.vpn, profiles)
            a, b = max(s.begin, dayStart), min(s.finish, dayEnd)
            head = f"  {s.vpn.get('name') or '?'} [{cat or '?'}]"
            if len(devices) > 1:
                head += f" @{s.device}"
            notes = []
            if s.begin < dayStart:
                notes.append(f"since {s.begin.strftime('%Y-%m-%d %H:%M')}")
            if s.open:
                notes.append("OPEN — no end yet; activity data "
                             + (f"up to {s.dataUntil.strftime('%Y-%m-%d %H:%M')} (last checkpoint)" if s.dataUntil
                                else "none yet (first checkpoint at the next full hour)")
                             + f"; last sign of life {s.finish.strftime('%Y-%m-%d %H:%M')}")
            elif s.finish > dayEnd:
                notes.append(f"until {s.finish.strftime('%Y-%m-%d %H:%M')}")
            if s.end:
                outcome = s.end.get("outcome")
                if outcome and outcome != "connected":
                    notes.append(f"{outcome}, never connected")
                notes.append(f"end: {s.end.get('endReason') or '?'}")
                if s.end.get("endEstimated"):
                    notes.append("end ESTIMATED")
            print(f"{head} {s.protocol} {hm(a)}–{hm(b)}" + (f"  ({'; '.join(notes)})" if notes else ""))
            for segA, segB, reason in s.segments:
                x, y = max(segA, a), min(segB, b)
                if x >= y:
                    continue
                # A remote desktop open while someone is at the Mac is work even when its screen is still and
                # the tunnel carries little: runs count like active minutes.
                busy = merge(s.active + s.runs)
                work = clip(intersect(busy, s.present), x, y)
                blind = clip(intersect(busy, s.unobserved), x, y)
                line = (f"    {hm(x)}–{hm(y)}  work {minutes(work):>3}m = {spans(work)}"
                        f" · active {minutes(clip(s.active, x, y))}m · present {minutes(clip(s.present, x, y))}m")
                if clip(s.runs, x, y):
                    line += f" · connections open {minutes(clip(s.runs, x, y))}m"
                if blind:
                    line += f" · app not running, active {minutes(blind)}m = {spans(blind)} (presence unknown)"
                line += f" · {json.dumps(reason, ensure_ascii=False) if reason else '(no reason)'}"
                print(line)
                if work:
                    totals[cat or "?"] = totals.get(cat or "?", 0) + minutes(work)
            for t, end, line, owner in conns:
                if owner is s and dayStart <= t < dayEnd:
                    c = line.get("connection") or {}
                    # a launch is a moment, not a span end: its minute, not the nearest one
                    when = f"{hm(t)}–{hm(end)}" if end else t.strftime("%H:%M")
                    print(f"    {c.get('type') or '?'} {json.dumps(c.get('name') or '?', ensure_ascii=False)} {when}"
                          + ("" if end or line.get("event") == "launch" else " (still running)"))
        for t, end, line, owner in conns:
            if owner is None and dayStart <= t < dayEnd:
                c = line.get("connection") or {}
                print(f"  {c.get('type') or '?'} {json.dumps(c.get('name') or '?', ensure_ascii=False)} {hm(t)}"
                      + (f"–{hm(end)}" if end else "") + " (its VPN session is not in the log)")
        if not todays:
            print("  (no VPN sessions)")
        elif totals:
            print("  Σ work: " + " | ".join(f"{k} {v}m" for k, v in sorted(totals.items())))
        print()
        day = nxt
    return 0


if __name__ == "__main__":
    sys.exit(main())
