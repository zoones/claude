import { expect, mock, test } from 'claude-code/testing'

import type { FoundElement } from 'claude-code/testing'

import { logFiles, pickTabs } from './register'

import type { LogTask } from '../types'

test('finds the files a command writes its output to', async () => {
  expect(logFiles('./gradlew build > build.log 2>&1', '/p')).toEqual(['/p/build.log'])
  expect(logFiles('cd sub && npm test 2>&1 | tee -a "test out.log"', '/p')).toEqual([
    '/p/sub/test out.log',
  ])
  expect(logFiles('make &>> /var/tmp/make.log', '/p')).toEqual(['/var/tmp/make.log'])
  expect(logFiles('sleep 60 > /dev/null 2>&1', '/p')).toEqual([])
  expect(logFiles('npm run dev', '/p')).toEqual([])
})

/** A prompt as the person types it, or as a background task's notice arrives. */
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } as const })
const notice = (text: string) => ({
  text,
  wait: false,
  origin: { kind: 'task-notification' } as const,
})

test('the guidance rides along the first prompt only', async ($, on) => {
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_$, e) => {
    contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  await $.prompt.submit(typed('hi'))
  await $.prompt.submit(typed('and again'))

  expect(contexts[0]?.join('\n')).toContain('run_in_background: true')
  expect(contexts[1] ?? []).toHaveLength(0)
})

const PANE = {
  plugin: 'live-log',
  component: 'Pane',
  requestId: 'live-log',
  props: {
    title: 'Live log',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('a background command gets a tab, and its completion notice ends it', async ($, on) => {
  // Nothing sits beneath the plugin: each hook here stands for the engine.
  mock.clock(on, { now: 0 })
  on('command.register', () => ({ value: { command: 'live-log' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/p' }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b123' } }))

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'make > build.log 2>&1', description: 'Build', run_in_background: true })
  await $.prompt.submit(
    notice(
      '<task-notification>\n<task-id>b123</task-id>\n<status>failed</status>\n' +
        '<summary>Background command "Build" failed with exit code 1</summary>\n</task-notification>',
    ),
  )

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /exit code 1/ }))?.text).toContain('build.log')
  await ui.unmount()
})

/** The elements of `type` whose key starts with `prefix`, in document order. */
async function keyed(
  ui: { findAll: (query: { type: string }) => Promise<FoundElement[]> },
  type: string,
  prefix: string,
) {
  return (await ui.findAll({ type })).filter(one => String(one.key).startsWith(prefix))
}

const task = (id: string, status: LogTask['status']): LogTask => ({
  id,
  title: id,
  status,
  startedAt: 0,
  files: [],
  lines: [],
  current: '',
})

test('tabs go to the chosen task, then the running ones, in the order they started', async () => {
  const list = [
    task('a', 'completed'),
    task('b', 'running'),
    task('c', 'failed'),
    task('d', 'completed'),
    task('e', 'running'),
    task('f', 'completed'),
  ]

  expect(pickTabs(list, 'a', 4).tabs.map(one => one.id)).toEqual(['a', 'b', 'e', 'f'])
  expect(pickTabs(list, 'a', 4).hidden).toBe(2)
  expect(pickTabs(list, null, 4).tabs.map(one => one.id)).toEqual(['b', 'd', 'e', 'f'])
  expect(pickTabs(list.slice(0, 2), null, 4)).toEqual({ tabs: list.slice(0, 2), hidden: 0 })
})

test('seven commands: four tabs within the pane width, and × closes an ended one', async ($, on) => {
  mock.clock(on, { now: 0 })
  let next = 0
  on('command.register', () => ({ value: { command: 'live-log' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/p' }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `b${++next}` },
  }))

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  for (let i = 1; i <= 7; i++) {
    await $.tool.call({
      tool: 'Bash',
      command: 'make',
      description: `A rather long description of command number ${i}`,
      run_in_background: true,
    })
  }
  // b1, b2, b3 and b7 ended; b4, b5 and b6 still run.
  for (const id of ['b1', 'b2', 'b3', 'b7']) {
    await $.prompt.submit(
      notice(`<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>`),
    )
  }

  const columns = 60
  const ui = await $.ui.mount({
    ...PANE,
    surface: 'terminal',
    props: { ...PANE.props, bodyColumns: columns },
  })
  const tabs = await keyed(ui, 'Button', 'task-')
  expect(tabs.map(one => one.key)).toEqual(['task-b4', 'task-b5', 'task-b6', 'task-b7'])
  expect((await ui.find({ type: 'Text', text: /^ \+3$/ }))?.text).toBe(' +3')

  const slots = await keyed(ui, 'Box', 'slot-')
  const used = slots.reduce((sum, one) => sum + Number(one.props.width), 0)
  expect(used + ' +3'.length).toBeLessThanOrEqual(columns)
  for (const one of tabs) {
    expect(String(one.props.label).length + 4).toBeLessThanOrEqual(Number(slots[0]?.props.width))
  }

  // Only the ended b7 has a ×; closing it lets b3 back in.
  expect((await keyed(ui, 'Button', 'close-')).map(one => one.key)).toEqual(['close-b7'])
  await ui.press({ key: 'close-b7' })
  const after = await keyed(ui, 'Button', 'task-')
  expect(after.map(one => one.key)).toEqual(['task-b3', 'task-b4', 'task-b5', 'task-b6'])
  await ui.unmount()
})
