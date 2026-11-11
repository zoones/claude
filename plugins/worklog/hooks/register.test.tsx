import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { findRunning, parseConfig } from './register'

const TODAY = '2026-10-09'
const TAG = 'abcdef12'
const BAND = {
  plugin: 'worklog',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 40 } as unknown as RenderPropsOf['AbovePrompt'],
} as const
/** The band runs the plugin's own wl — wherever the plugin is installed. */
const isWl = (argv0: string | undefined) => argv0 !== undefined && argv0.endsWith('/bin/wl')
const OPTIONS = { options: {} } as const
/** The worklog configuration wl reads too, at its default place. */
const CONFIG_PATH = '/home/me/.claude/worklog/config.json'
const CONFIG = JSON.stringify({
  log: '~/.worklog.log',
  scopes: ['ACME', 'BETA', 'OWN'],
  categories: {
    ACME: { shares: { ACME: 1 } },
    BETA: { shares: { BETA: 1 } },
    CLIENTS: { label: 'Clients (Acme+Beta)', short: 'Clients' },
    'CLIENTS+OWN': { label: 'Clients + own', short: 'C+O' },
    OWN: { label: 'Own' },
  },
})

test('parseConfig reads the categories in hotkey order, label and short falling back to the name', async () => {
  const parsed = parseConfig(JSON.stringify({
    log: '~/my.log',
    categories: { acme: {}, OWN: { label: 'Own' }, BOTH: { label: 'Both of them', short: 'Both' }, NONE: null },
  }))
  expect(parsed.log).toBe('~/my.log')
  expect(parsed.categories).toEqual([
    { value: 'ACME', label: 'ACME', short: 'ACME', hotkey: '1' },
    { value: 'OWN', label: 'Own', short: 'Own', hotkey: '2' },
    { value: 'BOTH', label: 'Both of them', short: 'Both', hotkey: '3' },
    { value: 'NONE', label: 'NONE', short: 'NONE', hotkey: '4' },
  ])
  expect(parseConfig('{}')).toEqual({ log: '~/.claude/worklog/worklog.log', categories: [] })
  const many = parseConfig(JSON.stringify({ categories: Object.fromEntries('ABCDEFGHIJ'.split('').map(k => [k, {}])) }))
  expect(many.categories.map(c => c.hotkey)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', undefined])
  expect(() => parseConfig('not json')).toThrow()
})

test('findRunning reads only today\'s last line of the own session', async () => {
  const log = [
    `2026-10-08T19:00:00+0200|${TAG}|ACME|yesterday`,
    `${TODAY}T08:00:00+0200|${TAG}|OWN|tooling|with pipe`,
    `${TODAY}T08:30:00+0200|other123|BETA|other tab`,
  ].join('\n')
  expect(findRunning(log, TAG, TODAY)).toEqual({ category: 'OWN', comment: 'tooling|with pipe', since: '08:00' })
  expect(findRunning(`${log}\n${TODAY}T09:00:00+0200|${TAG}|STOP|`, TAG, TODAY)).toBeNull()
  expect(findRunning(`2026-10-08T19:00:00+0200|${TAG}|ACME|yesterday`, TAG, TODAY)).toBeNull()
  expect(findRunning('', TAG, TODAY)).toBeNull()
})

/**
 * A host with the plugin's wl and a worklog in memory, answering wl as it writes the log:
 * `stop` appends a STOP line, `amend <cat>` rewrites the last line's category, `<cat> <comment>`
 * appends a new interval. `reads` collects the paths the plugin read. `env.WL_CONFIG` stands for
 * that variable in the environment; `isWlExecutable: false` for a plugin whose wl cannot run.
 */
function host(on: On, initialLog: string, config: string | null = CONFIG,
              env: { WL_CONFIG?: string; isWlExecutable?: boolean } = {}) {
  const calls: { argv: readonly string[]; env?: Record<string, string> }[] = []
  const toasts: string[] = []
  const reads: string[] = []
  let log = initialLog
  const clock = mock.clock(on)
  // The engine's own band, drawn when the plugin passes.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.root', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: `${TAG}-0000-0000-0000-000000000000` }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    if (e.path.endsWith('.json')) {
      if (config === null) {
        throw new Error(`ENOENT: ${e.path}`)
      }
      return { value: config }
    }
    return { value: log }
  })
  on('process.run', (_$, e) => {
    calls.push({ argv: e.argv, env: e.init?.env })
    const ok = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    switch (e.argv[0]) {
      case 'date':
        return { value: { ...ok, stdout: `${TODAY}\n` } }
      case 'printenv': {
        const value = e.argv[1] === 'HOME' ? '/home/me' : e.argv[1] === 'WL_CONFIG' ? env.WL_CONFIG : undefined
        return { value: { ...ok, exitCode: value === undefined ? 1 : 0, stdout: value === undefined ? '' : `${value}\n` } }
      }
      case 'test':
        return { value: { ...ok, exitCode: isWl(e.argv[2]) && env.isWlExecutable !== false ? 0 : 1, stdout: '' } }
      default: {
        const [, verb = '', arg = '', comment = ''] = e.argv
        if (verb === 'stop') {
          log += `\n${TODAY}T10:00:00+0200|${TAG}|STOP|`
          return { value: { ...ok, stdout: 'wl: stopped OWN at 10:00\n' } }
        }
        if (verb === 'amend') {
          const lines = log.split('\n')
          const [ts, sid, , ...rest] = (lines.at(-1) ?? '').split('|')
          lines[lines.length - 1] = [ts, sid, arg, ...rest].join('|')
          log = lines.join('\n')
          return { value: { ...ok, stdout: `wl: amended to ${arg}\n` } }
        }
        log += `\n${TODAY}T10:00:00+0200|${TAG}|${verb}|${arg}`
        return { value: { ...ok, stdout: `wl: ${verb} — ${arg}${comment}\n` } }
      }
    }
  })
  return { calls, toasts, reads, clock }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

test('a resumed session (no session.start) still shows the band after its first draw', OPTIONS, async ($, on) => {
  const { clock } = host(on, `${TODAY}T08:00:00+0200|${TAG}|OWN|mod tooling`)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await clock.advance(0)
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'category' })).toMatchObject({ text: 'Own ▾' })
  await ui.unmount()
})

test('the band reads the worklog configuration wl reads, then the log it names, ~ expanded', OPTIONS, async ($, on) => {
  const { reads } = host(on, `${TODAY}T08:00:00+0200|${TAG}|OWN|mod tooling`)
  await start($)
  expect(reads.slice(0, 2)).toEqual([CONFIG_PATH, '/home/me/.worklog.log'])
})

test('WL_CONFIG points the band at another configuration, as it points wl', OPTIONS, async ($, on) => {
  const { reads } = host(on, `${TODAY}T08:00:00+0200|${TAG}|OWN|mod tooling`, CONFIG, { WL_CONFIG: '~/elsewhere/wl.json' })
  await start($)
  expect(reads).toContain('/home/me/elsewhere/wl.json')
})

test('without a log in the configuration the band reads the default one', OPTIONS, async ($, on) => {
  const { reads } = host(on, `${TODAY}T08:00:00+0200|${TAG}|OWN|mod tooling`, JSON.stringify({ categories: { OWN: {} } }))
  await start($)
  expect(reads).toContain('/home/me/.claude/worklog/worklog.log')
})

test('no band without a worklog configuration — wl takes no category then either', OPTIONS, async ($, on) => {
  const { calls } = host(on, `${TODAY}T08:00:00+0200|${TAG}|OWN|mod tooling`, null)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  expect(wlCalls(calls)).toEqual([])
  await ui.unmount()
})

test('no band with a broken configuration', OPTIONS, async ($, on) => {
  host(on, `${TODAY}T08:00:00+0200|${TAG}|OWN|mod tooling`, 'not json')
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await ui.unmount()
})

test('the band shows the running interval and Stop runs wl stop for this session', OPTIONS, async ($, on) => {
  const { calls, toasts } = host(on, `${TODAY}T08:00:00+0200|${TAG}|OWN|mod tooling`)
  await start($)
  // Stopping is shared state, so every surface is checked before the press ends the interval.
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // Controls only, quiet at rest: the status line already carries comment and start time.
    expect(await ui.find({ type: 'Button', key: 'category' })).toMatchObject({
      text: 'Own ▾',
      // autoFocus: ctrl+x tab lands here, so Enter opens the project row at once.
      props: { plain: true, dimColor: true, autoFocus: true },
    })
    expect(await ui.find({ type: 'Button', key: 'stop' })).toMatchObject({ props: { plain: true, dimColor: true } })
    expect(await ui.find({ type: 'Text', text: /mod tooling|seit/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /─/ })).toBeUndefined()
    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { marginTop: 1, alignItems: 'flex-end' } })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'stop' })
  const stop = calls.find(c => isWl(c.argv[0]))
  expect(stop?.argv.slice(1)).toEqual(['stop'])
  expect(stop?.env).toEqual({ CLAUDE_CODE_SESSION_ID: TAG })
  expect(toasts).toEqual(['wl: stopped OWN at 10:00'])
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

const wlCalls = (calls: { argv: readonly string[] }[]) =>
  calls.filter(c => isWl(c.argv[0])).map(c => c.argv.slice(1))

/** The project buttons currently drawn. */
async function pickRow(ui: { findAll: (q: { type: string }) => Promise<{ text?: string; props: Record<string, unknown> }[]> }) {
  const ret = (await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key).startsWith('pick-'))
  return ret
}

test('the project button opens a row of the other projects, each with its digit', OPTIONS, async ($, on) => {
  host(on, `${TODAY}T08:00:00+0200|${TAG}|OWN|mod tooling`)
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'pick-ACME' })).toBeUndefined()
    await ui.press({ key: 'category' })
    const row = await pickRow(ui)
    // Plain buttons: the terminal draws the hotkey itself (`1: ACME`).
    expect(row.map(b => [b.text, b.props.hotkey, b.props.plain])).toEqual([
      ['ACME', '1', true],
      ['BETA', '2', true],
      ['Clients', '3', true],
      ['C+O', '4', true],
    ])
    expect(await ui.find({ key: 'cancel' })).toMatchObject({ props: { hotkey: 'a' } })
    // Pressing the project button again closes the row.
    await ui.press({ key: 'category' })
    expect(await ui.find({ key: 'pick-ACME' })).toBeUndefined()
    await ui.unmount()
  }
})

test('picking a project asks first; "Zeit umbuchen" amends the running entry', OPTIONS, async ($, on) => {
  const { calls } = host(on, `${TODAY}T08:00:00+0200|${TAG}|OWN|mod tooling`)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'category' })
  await ui.press({ key: 'pick-ACME' })
  expect(wlCalls(calls)).toEqual([])
  expect(await ui.find({ key: 'pick-BETA' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'rebook' })).toMatchObject({
    text: 'Zeit umbuchen (ab 08:00)',
    props: { hotkey: 'u', plain: true },
  })

  await ui.press({ key: 'rebook' })
  expect(wlCalls(calls)).toEqual([['amend', 'ACME']])
  expect(await ui.find({ type: 'Button', key: 'category' })).toMatchObject({ text: 'ACME ▾' })
  expect(await ui.find({ key: 'rebook' })).toBeUndefined()
  await ui.unmount()
})

test('"Ab jetzt fortsetzen" opens a new interval in the picked project with the same comment', OPTIONS, async ($, on) => {
  const { calls } = host(on, `${TODAY}T08:00:00+0200|${TAG}|OWN|mod tooling`)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'category' })
  await ui.press({ key: 'pick-CLIENTS+OWN' })
  expect(await ui.find({ key: 'continue' })).toMatchObject({ props: { hotkey: 'f' } })
  await ui.press({ key: 'continue' })
  expect(wlCalls(calls)).toEqual([['CLIENTS+OWN', 'mod tooling']])
  expect(await ui.find({ type: 'Button', key: 'category' })).toMatchObject({ text: 'Clients + own ▾' })
  await ui.unmount()
})

test('"Abbrechen" in the row and in the question books nothing', OPTIONS, async ($, on) => {
  const { calls } = host(on, `${TODAY}T08:00:00+0200|${TAG}|OWN|mod tooling`)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'category' })
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'pick-ACME' })).toBeUndefined()

  await ui.press({ key: 'category' })
  await ui.press({ key: 'pick-BETA' })
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'rebook' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'category' })).toMatchObject({ text: 'Own ▾' })
  expect(wlCalls(calls)).toEqual([])
  await ui.unmount()
})

test('an explicit split shows as written and every project is offered', OPTIONS, async ($, on) => {
  host(on, `${TODAY}T08:00:00+0200|${TAG}|ACME=60,OWN=40|cutover`)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'category' })).toMatchObject({ text: 'ACME=60,OWN=40 ▾' })
  await ui.press({ key: 'category' })
  expect(await pickRow(ui)).toHaveLength(5)
  await ui.unmount()
})

test('no band when this session has nothing running', OPTIONS, async ($, on) => {
  host(on, `${TODAY}T08:00:00+0200|other123|ACME|other tab`)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

test('no band where the plugin\'s own wl is not executable, and wl is never run', OPTIONS, async ($, on) => {
  const { calls } = host(on, `${TODAY}T08:00:00+0200|${TAG}|OWN|mod tooling`, CONFIG, { isWlExecutable: false })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  // the plugin's own bin/wl, not one of the project
  expect(calls.some(c => c.argv[0] === 'test' && isWl(c.argv[2]))).toBe(true)
  expect(wlCalls(calls)).toEqual([])
  await ui.unmount()
})
