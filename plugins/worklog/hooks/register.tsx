// Tested via: claude plugin test plugins/worklog (hooks/register.test.tsx)
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Running } from '../types'

const running = atom({ plugin: 'worklog', key: 'running' } as const, null)
const isBusy = atom({ plugin: 'worklog', key: 'isBusy' } as const, false)
const isPicking = atom({ plugin: 'worklog', key: 'isPicking' } as const, false)
const pending = atom({ plugin: 'worklog', key: 'pending' } as const, null)

const REFRESH_MS = 15_000

/** A category `wl` takes, as it writes it to the log; `hotkey` is the digit that picks it, if any. */
export type Category = { value: string; label: string; short: string; hotkey: string | undefined }

/** Where the worklog configuration lives unless the `config` option says otherwise — shared with wl. */
const DEFAULT_CONFIG = '~/.claude/worklog/config.json'
/** The log wl writes when the configuration names none. */
const DEFAULT_LOG = '~/.claude/worklog/worklog.log'

/**
 * The worklog configuration as far as the band needs it — the same file wl reads, so the band
 * offers exactly the categories wl accepts: `log`, and `categories` in hotkey order, each with an
 * optional `label` (the band's button) and `short` (the picker row). Only the first nine get a digit.
 */
export function parseConfig(json: string): { log: string; categories: Category[] } {
  const data = JSON.parse(json) as { log?: unknown; categories?: Record<string, { label?: unknown; short?: unknown } | null> }
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const categories = Object.entries(data.categories ?? {}).map(([key, c], i) => {
    const value = key.trim().toUpperCase()
    const label = text(c?.label) || value
    return { value, label, short: text(c?.short) || label, hotkey: i < 9 ? String(i + 1) : undefined }
  })
  const ret = { log: text(data.log) || DEFAULT_LOG, categories }
  return ret
}

/** The categories of the worklog configuration, re-read on every refresh. */
let categories: Category[] = []

/**
 * Where wl and its configuration live; resolved once per load by the first refresh. wl is the
 * plugin's own (bin/wl); null = not executable, then the band stays hidden. The configuration is
 * where wl looks for it: WL_CONFIG, else ~/.claude/worklog/config.json. Not tied to session.start
 * alone: a resumed session may never raise it.
 */
const where = { isResolved: false, wl: null as string | null, home: '', configPath: '', tag: '' }

/**
 * The open interval of `tag` in the worklog: today's last line of that session, unless it is a
 * STOP. Line format: ISO_TIMESTAMP|SESSION|CATEGORY|comment
 */
export function findRunning(log: string, tag: string, today: string): Running | null {
  const last = log
    .split('\n')
    .filter(line => line.startsWith(today) && line.split('|')[1] === tag)
    .at(-1)
  if (last === undefined) {
    return null
  }
  const [ts = '', , category = '', ...comment] = last.split('|')
  if (category === 'STOP') {
    return null
  }
  const ret: Running = { category, comment: comment.join('|'), since: ts.slice(11, 16) }
  return ret
}

/** An explicit split (`ACME=60,OWN=40`) is not a category and shows as written. */
function labelOf(category: string) {
  const ret = categories.find(c => c.value === category)?.label ?? category
  return ret
}

/** `~` and `~/…` lead to the home folder; any other path stays as given. */
function expandHome(path: string, home: string) {
  const ret = path === '~' || path.startsWith('~/') ? `${home}${path.slice(1)}` : path
  return ret
}

async function resolveWhere($: EngineInterface) {
  where.isResolved = true
  const home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
  const wlPath = `${$.plugin.root}/bin/wl`
  const hasWl = (await $.process.run(['test', '-x', wlPath])).exitCode === 0
  where.wl = hasWl ? wlPath : null
  where.home = home
  const configEnv = await $.process.run(['printenv', 'WL_CONFIG'])
  const configured = configEnv.exitCode === 0 ? configEnv.stdout.trim() : ''
  where.configPath = expandHome(configured || DEFAULT_CONFIG, home)
  if (hasWl) {
    $.clock.every(REFRESH_MS, () => refresh($))
  }
}

async function refresh($: EngineInterface) {
  if (!where.isResolved) {
    await resolveWhere($)
  }
  if (where.wl === null) {
    return
  }
  // Read every time: /clear and a resume go on under another session id, and an edited
  // configuration counts from the next refresh on.
  where.tag = (await $.session.id()).slice(0, 8)
  let logPath: string
  try {
    const parsed = parseConfig(await $.fs.read(where.configPath))
    categories = parsed.categories
    logPath = expandHome(parsed.log, where.home)
  } catch {
    // No configuration, or a broken one: wl takes no category then either — no band.
    categories = []
    await update($, running, () => null)
    return
  }
  const today = (await $.process.run(['date', '+%F'])).stdout.trim()
  let log = ''
  try {
    log = await $.fs.read(logPath)
  } catch {
    // No log yet: nothing is running.
  }
  const found = findRunning(log, where.tag, today)
  await update($, running, () => found)
}

/** Runs `wl args` for this session and toasts its first line; one call at a time. */
async function runWl($: EngineInterface, args: string[]) {
  const wl = where.wl
  if (wl === null || (await read($, isBusy))) {
    return
  }
  await update($, isBusy, () => true)
  try {
    const res = await $.process.run([wl, ...args], { env: { CLAUDE_CODE_SESSION_ID: where.tag } })
    const out = (res.exitCode === 0 ? res.stdout : res.stderr || res.stdout).trim()
    $.ui.toast(out.split('\n')[0] || `wl ${args[0]} ${res.exitCode === 0 ? 'ok' : 'fehlgeschlagen'}`)
  } finally {
    await close($)
    await update($, isBusy, () => false)
    await refresh($)
  }
}

/** The project button opens the row of projects, or closes it (and any open question) again. */
async function togglePicking($: EngineInterface) {
  const open = (await read($, isPicking)) || (await read($, pending)) !== null
  if (open) {
    await close($)
  } else {
    await update($, isPicking, () => true)
  }
}

/** A project from the row: the question follows; the current project books nothing. */
async function pick($: EngineInterface, category: string) {
  const current = await read($, running)
  await update($, isPicking, () => false)
  const next = current === null || category === current.category ? null : category
  await update($, pending, () => next)
}

/** Books the time since the interval started to the picked category; the comment stays. */
async function rebook($: EngineInterface) {
  const category = await read($, pending)
  if (category !== null) {
    await runWl($, ['amend', category])
  }
}

/** Ends the interval now and opens a new one in the picked category with the same comment. */
async function continueAs($: EngineInterface) {
  const category = await read($, pending)
  const current = await read($, running)
  if (category !== null && current !== null) {
    await runWl($, [category, current.comment])
  }
}

async function close($: EngineInterface) {
  await update($, isPicking, () => false)
  await update($, pending, () => null)
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  // The model books via `wl` itself; show the new state as soon as its turn ends.
  on('turn.complete', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A resumed session may raise no session.start: the first draw sets things up instead.
    if (!where.isResolved) {
      $.clock.after(0, () => refresh($))
    }
    const current = await read($, running)
    if (e.props.hasSurvey || current === null || where.wl === null) {
      return next(e)
    }
    const busy = await read($, isBusy)
    const picking = await read($, isPicking)
    const picked = await read($, pending)
    const { Box, Button, Text } = $.ui.resolve(e)

    // Controls only, right-aligned and dim at rest: the status line already shows project, comment
    // and start. A blank row keeps the band apart from the chat; the prompt's own rule separates below.
    // Hotkeys act while the band holds the focus (ctrl+x tab): digits pick, u/f/a answer.
    return (
      <Box flexDirection="column" alignItems="flex-end" marginTop={1}>
        <Box>
          <Text dimColor>⏱ </Text>
          <Button key="category" plain dimColor autoFocus label={`${labelOf(current.category)} ▾`} onPress={() => togglePicking($)} />
          <Text dimColor>  ·  </Text>
          <Button key="stop" plain dimColor label={busy ? '…' : 'Stop'} onPress={() => runWl($, ['stop'])} />
        </Box>
        {picking && (
          <Box gap={2}>
            {categories.filter(c => c.value !== current.category).map(c => (
              <Button key={`pick-${c.value}`} plain hotkey={c.hotkey} label={c.short} onPress={() => pick($, c.value)} />
            ))}
            <Button key="cancel" plain role="dismiss" hotkey="a" label="Abbrechen" onPress={() => close($)} />
          </Box>
        )}
        {picked !== null && (
          <Box gap={2}>
            <Text>
              Auf <Text color="cyan">{labelOf(picked)}</Text>:
            </Text>
            <Button key="rebook" plain hotkey="u" label={`Zeit umbuchen (ab ${current.since})`} onPress={() => rebook($)} />
            <Button key="continue" plain hotkey="f" label="Ab jetzt fortsetzen" onPress={() => continueAs($)} />
            <Button key="cancel" plain role="dismiss" hotkey="a" label="Abbrechen" onPress={() => close($)} />
          </Box>
        )}
      </Box>
    )
  })
}
