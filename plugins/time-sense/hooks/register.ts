// Tested via: claude plugin test plugins/time-sense (hooks/register.test.ts)
import type { EngineInterface, Register } from 'claude-code'

const STORE_KEY = 'lastPromptAt'
/** Sessions not prompted for this long are dropped from the store. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const pad = (n: number) => String(n).padStart(2, '0')

/** ISO 8601 week number of a calendar date (weeks start Monday, week 1 holds the first Thursday). */
export function isoWeek(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day))
  const weekday = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - weekday)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const ret = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7)
  return ret
}

/** `+02:00` for minutes east of UTC. */
export function utcOffset(minutesEast: number) {
  const sign = minutesEast < 0 ? '-' : '+'
  const abs = Math.abs(minutesEast)
  const ret = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return ret
}

/** The wall clock of `ms` in `timeZone` (the machine's own when absent), read through Intl. */
export function wallClock(ms: number, timeZone?: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms))
  const part = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
  const year = part('year')
  const month = part('month')
  const day = part('day')
  const hour = part('hour')
  const minute = part('minute')
  const asUtc = Date.UTC(year, month - 1, day, hour, minute)
  const ret = {
    year,
    month,
    day,
    hour,
    minute,
    weekday: new Date(asUtc).getUTCDay(),
    offsetMinutes: Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000),
    timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
  return ret
}

/** `4 min`, `2 h 15 min`, `3 days 4 h`: a gap rounded to what matters at its size. */
export function humanGap(ms: number) {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) {
    return 'less than a minute'
  }
  if (minutes < 60) {
    return `${minutes} min`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
  }
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  const ret = `${days} ${days === 1 ? 'day' : 'days'}${rest === 0 ? '' : ` ${rest} h`}`
  return ret
}

/** The line the model reads beside each prompt; `previousAt` null on a session's first prompt. */
export function timeContext(now: number, previousAt: number | null, timeZone?: string) {
  const c = wallClock(now, timeZone)
  const date = `${c.year}-${pad(c.month)}-${pad(c.day)}`
  const time = `${pad(c.hour)}:${pad(c.minute)}`
  const zone = `${c.timeZone}, UTC${utcOffset(c.offsetMinutes)}`
  const since = previousAt === null ? 'this is the first prompt of the session' : `previous prompt ${humanGap(now - previousAt)} ago`
  const ret =
    `Current local time: ${WEEKDAYS[c.weekday]}, ${date} ${time} (${zone}), ISO week ${isoWeek(c.year, c.month, c.day)}; ${since}. ` +
    'Use this for relative dates ("today", "yesterday", "next week") and for how long ago earlier messages in this conversation were.'
  return ret
}

/** The line for this prompt, and the session's prompt time remembered for the next one. */
async function lineFor($: EngineInterface) {
  const [now, sessionId, zoneOverride] = await Promise.all([$.clock.now(), $.session.id(), $.env.get('CLAUDE_TIME_SENSE_TZ')])
  const seen = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, number>
  const previousAt = seen[sessionId] ?? null

  let ret: string
  try {
    ret = timeContext(now, previousAt, zoneOverride || undefined)
  } catch {
    // An unknown CLAUDE_TIME_SENSE_TZ: fall back to the machine's own zone.
    ret = timeContext(now, previousAt)
  }

  const kept = Object.fromEntries(Object.entries(seen).filter(([, at]) => now - at < KEEP_MS))
  await $.store.set(STORE_KEY, { ...kept, [sessionId]: now })
  return ret
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    // The time is a nicety: whatever fails here, the prompt still goes through, just without it.
    const line = await lineFor($).catch(() => null)
    if (line === null) {
      return next(e)
    }
    return next({ ...e, context: [...(e.context ?? []), line] })
  })
}
