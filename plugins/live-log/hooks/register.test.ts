import { expect, mock, test } from 'claude-code/testing'

import { logFiles } from './register'

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
