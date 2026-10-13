import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { humanGap, isoWeek, timeContext, utcOffset, wallClock } from './register'

/** Tue 2026-10-13 14:32 in Vienna (UTC+02:00, summer time). */
const TUESDAY = Date.UTC(2026, 9, 13, 12, 32)
const MIN = 60 * 1000
const SESSION = 'abcdef12-0000-0000-0000-000000000000'

/** A prompt typed at the terminal. */
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } as const })

test('isoWeek follows ISO 8601 across year ends', async () => {
  expect(isoWeek(2026, 10, 13)).toBe(42)
  expect(isoWeek(2026, 1, 1)).toBe(1)
  expect(isoWeek(2027, 1, 1)).toBe(53)
  expect(isoWeek(2024, 12, 30)).toBe(1)
})

test('utcOffset and humanGap', async () => {
  expect(utcOffset(120)).toBe('+02:00')
  expect(utcOffset(-330)).toBe('-05:30')
  expect(utcOffset(0)).toBe('+00:00')
  expect(humanGap(20 * 1000)).toBe('less than a minute')
  expect(humanGap(4 * MIN)).toBe('4 min')
  expect(humanGap(120 * MIN)).toBe('2 h')
  expect(humanGap(135 * MIN)).toBe('2 h 15 min')
  expect(humanGap(25 * 60 * MIN)).toBe('1 day 1 h')
  expect(humanGap(3 * 24 * 60 * MIN)).toBe('3 days')
})

test('wallClock reads the zone, summer and winter time', async () => {
  expect(wallClock(TUESDAY, 'Europe/Vienna')).toMatchObject({ hour: 14, minute: 32, weekday: 2, offsetMinutes: 120 })
  expect(wallClock(Date.UTC(2026, 11, 24, 23, 30), 'Europe/Vienna')).toMatchObject({ day: 25, hour: 0, offsetMinutes: 60 })
  expect(wallClock(TUESDAY, 'America/New_York')).toMatchObject({ hour: 8, offsetMinutes: -240 })
})

test('timeContext names weekday, date, time, zone, week and the gap', async () => {
  expect(timeContext(TUESDAY, null, 'Europe/Vienna')).toContain(
    'Current local time: Tuesday, 2026-10-13 14:32 (Europe/Vienna, UTC+02:00), ISO week 42; this is the first prompt of the session.',
  )
  expect(timeContext(TUESDAY, TUESDAY - 4 * MIN, 'Europe/Vienna')).toContain('previous prompt 4 min ago.')
})

/** A host at `now` whose `prompt.submit` bottom echoes what entered; returns the contexts that reached it. */
function host(on: On, now: number, env: Record<string, string> = { CLAUDE_TIME_SENSE_TZ: 'Europe/Vienna' }) {
  const contexts: (readonly string[] | undefined)[] = []
  const clock = mock.clock(on, { now })
  mock.store(on)
  mock.env(on, env)
  on('session.id', () => ({ value: SESSION }))
  on('prompt.submit', (_$, e) => {
    contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  return { clock, contexts }
}

test('every prompt carries the time; the second one also how long since the first', async ($, on) => {
  const { clock, contexts } = host(on, TUESDAY)
  await $.prompt.submit(typed('hi'))
  await clock.advance(4 * MIN)
  await $.prompt.submit(typed('and now?'))

  expect(contexts[0]?.[0]).toContain('Tuesday, 2026-10-13 14:32')
  expect(contexts[0]?.[0]).toContain('first prompt of the session')
  expect(contexts[1]?.[0]).toContain('14:36')
  expect(contexts[1]?.[0]).toContain('previous prompt 4 min ago')
})

test('a failing store leaves the prompt as typed instead of blocking it', async ($, on) => {
  const contexts: (readonly string[] | undefined)[] = []
  mock.clock(on, { now: TUESDAY })
  mock.env(on, {})
  on('session.id', () => ({ value: SESSION }))
  on('store.get', () => {
    throw new Error('store unavailable')
  })
  on('prompt.submit', (_$, e) => {
    contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  const entered = await $.prompt.submit(typed('hi'))
  expect(entered).toMatchObject({ text: 'hi' })
  expect(contexts).toEqual([undefined])
})

test('an unknown CLAUDE_TIME_SENSE_TZ falls back to the machine zone instead of failing the prompt', async ($, on) => {
  const { contexts } = host(on, TUESDAY, { CLAUDE_TIME_SENSE_TZ: 'Mars/Olympus' })
  await $.prompt.submit(typed('hi'))
  expect(contexts[0]?.[0]).toContain('Current local time')
})
