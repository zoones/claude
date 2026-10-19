import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/Users/someone/Ablage'
const FILE_TEXT = 'Ask me: new document in 00_Eingang, scan from the flatbed, or nothing.'
const SESSION = 'abcdef12-0000-0000-0000-000000000000'

/** A host whose directory holds `files`; returns the prompts and toasts the mod sent. */
function host(on: On, files: Record<string, string>, session = SESSION) {
  const prompts: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 19, 10, 0) })
  on('session.id', () => ({ value: session }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: text }
  })
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, prompts, toasts }
}

const start = { cwd: CWD, surface: 'terminal', isInteractive: true } as const

test('an untrusted AUTOSTART.md only shows a toast', async ($, on) => {
  mock.store(on)
  const { prompts, toasts } = host(on, { [`${CWD}/AUTOSTART.md`]: FILE_TEXT })
  await $.session.start(start)
  expect(prompts).toEqual([])
  expect(toasts[0]).toContain('/autostart')
})

test('/autostart runs the file and trusts it for the next session', async ($, on) => {
  mock.store(on)
  const { clock, prompts } = host(on, { [`${CWD}/AUTOSTART.md`]: FILE_TEXT })
  const ran = await $.command.run({
    command: 'autostart',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(ran.text).toContain('trusted')
  await clock.advance(1)
  expect(prompts[0]).toContain(FILE_TEXT)
})

test('/autostart without a file starts writing one', async ($, on) => {
  mock.store(on)
  const { clock, prompts } = host(on, {})
  const ran = await $.command.run({
    command: 'autostart',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(ran.text).toContain("let's write one")
  await clock.advance(1)
  expect(prompts[0]).toContain(`There is no AUTOSTART.md in ${CWD} yet`)
})

test('a trusted, unchanged AUTOSTART.md runs once per session', async ($, on) => {
  mock.store(on, { trusted: { [CWD]: FILE_TEXT } })
  const { prompts } = host(on, { [`${CWD}/AUTOSTART.md`]: FILE_TEXT })
  await $.session.start(start)
  await $.session.start(start)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain(`Instructions from AUTOSTART.md in ${CWD}`)
})

test('a changed AUTOSTART.md needs a new approval', async ($, on) => {
  mock.store(on, { trusted: { [CWD]: 'older text' } })
  const { prompts, toasts } = host(on, { [`${CWD}/AUTOSTART.md`]: FILE_TEXT })
  await $.session.start(start)
  expect(prompts).toEqual([])
  expect(toasts).toHaveLength(1)
})

test('no AUTOSTART.md, or a -p run: nothing happens', async ($, on) => {
  mock.store(on, { trusted: { [CWD]: FILE_TEXT } })
  const { prompts, toasts } = host(on, {})
  await $.session.start(start)
  await $.session.start({ ...start, isInteractive: false, surface: null })
  expect([...prompts, ...toasts]).toEqual([])
})
