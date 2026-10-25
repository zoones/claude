import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { cacheDirFor, cellsFor, digest, errorGist, lineRange, markdownBlocksFor, mermaidBlocks, themeFor } from './register'

/** The first 32 bytes of a real 172 x 596 PNG (an mmdc state diagram at scale 2), base64. */
const DIAGRAM_HEAD = 'iVBORw0KGgoAAAANSUhEUgAAAKwAAAJUCAYAAACVNM8='
const GHOSTTY = { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' }
const ITERM = { TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' }
const DIR = cacheDirFor('501')
const STATES = 'stateDiagram-v2\n  [*] --> Offen\n  Offen --> Bezahlt'
const BROKEN = 'stateDiagram-v2\n  [*] -->\n  --> ---'
const MMDC_STDERR = [
  'Generating single mermaid chart',
  '',
  'Error: Parse error on line 2:',
  '...ram-v2  [*] -->   --> ---',
  '---------------------^',
  "Expecting 'ID', 'EDGE_STATE', got '-->'",
  'Parser3.parseError (/opt/homebrew/lib/node_modules/mermaid/dist/mermaid.js:136920:28)',
  '    at #evaluate (file:///opt/homebrew/lib/ExecutionContext.js:388:19)',
].join('\n')

const fence = (source: string) => '```mermaid\n' + source + '\n```'

test('mermaidBlocks finds closed fences only, with their place', async () => {
  const text = `Vorschlag:\n\n${fence(STATES)}\n\nund\n\n${fence('flowchart LR\n  A --> B')}\n\n\`\`\`mermaid\nflowchart TD\n  X -->`
  const blocks = mermaidBlocks(text)
  expect(blocks.map(b => b.source)).toEqual([STATES, 'flowchart LR\n  A --> B'])
  expect(text.slice(blocks[0]?.start, blocks[0]?.end)).toBe(fence(STATES))
  expect(mermaidBlocks('```ts\nconst a = 1\n```')).toEqual([])
})

test('lineRange follows Read offset and limit', async () => {
  const text = 'a\nb\nc\nd\n'
  expect(lineRange(text)).toEqual({ start: 0, end: text.length })
  expect(text.slice(lineRange(text, 2, 2).start, lineRange(text, 2, 2).end)).toBe('b\nc\n')
  expect(text.slice(lineRange(text, 4).start, lineRange(text, 4).end)).toBe('d\n')
})

test('markdownBlocksFor: Read its lines, Write all, Edit only the blocks it touched', async () => {
  const doc = ['# Prozesse', '', fence('flowchart LR\n  A --> B'), '', '## Auftrag', '', fence(STATES), ''].join('\n')
  const lineOf = (needle: string) => doc.slice(0, doc.indexOf(needle)).split('\n').length
  expect(markdownBlocksFor('Write', { content: doc }, null)).toHaveLength(2)
  expect(markdownBlocksFor('Read', {}, doc)).toHaveLength(2)
  expect(markdownBlocksFor('Read', { offset: lineOf('## Auftrag') }, doc).map(b => b.source)).toEqual([STATES])
  expect(markdownBlocksFor('Read', { offset: 1, limit: 2 }, doc)).toEqual([])
  expect(markdownBlocksFor('Edit', { old_string: 'Offen --> Storno', new_string: 'Offen --> Bezahlt' }, doc).map(b => b.source)).toEqual([STATES])
  expect(markdownBlocksFor('Edit', { new_string: '## Auftrag' }, doc)).toEqual([])
  // The file moved on since: the fences of new_string itself.
  expect(markdownBlocksFor('Edit', { new_string: fence('flowchart TD\n  C --> D') }, doc).map(b => b.source)).toEqual(['flowchart TD\n  C --> D'])
  expect(markdownBlocksFor('Edit', { new_string: '' }, doc)).toEqual([])
})

test('errorGist keeps the parse error, drops excerpt and stack', async () => {
  expect(errorGist(MMDC_STDERR)).toBe("Parse error on line 2: Expecting 'ID', 'EDGE_STATE', got '-->'")
  expect(errorGist('')).toBe('mmdc failed')
})

test('cellsFor keeps the aspect within the room and 100 x 40 cells', async () => {
  expect(cellsFor({ width: 172, height: 596 })).toEqual({ columns: 14, rows: 24 })
  expect(cellsFor({ width: 2400, height: 600 })).toEqual({ columns: 100, rows: 13 })
  expect(cellsFor({ width: 2400, height: 600 }, 60)).toEqual({ columns: 60, rows: 8 })
  expect(cellsFor({ width: 400, height: 6000 }).rows).toBe(40)
})

const DARK = { exitCode: 0, stdout: 'Dark\n', stderr: '' }
const LIGHT = { exitCode: 1, stdout: '', stderr: "Could not find key 'AppleInterfaceStyle' in domain 'kCFPreferencesAnyApplication'." }

test('themeFor: a named theme wins, else the macOS appearance, else dark', async () => {
  expect(themeFor('forest', LIGHT)).toBe('forest')
  expect(themeFor('rainbow', DARK)).toBe('dark')
  expect(themeFor(undefined, DARK)).toBe('dark')
  expect(themeFor(undefined, LIGHT)).toBe('default')
  expect(themeFor(undefined, { ...LIGHT, stderr: 'The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist' })).toBe('default')
  expect(themeFor(undefined, { exitCode: 127, stdout: '', stderr: 'defaults: command not found' })).toBe('dark')
  expect(themeFor(undefined, null)).toBe('dark')
})

/**
 * A host whose files are `files` (path -> base64 for a PNG, text otherwise); `mmdc` "renders" a
 * diagram into its `-o` path unless its stdin is BROKEN, and is recorded; `missingMmdc` makes it
 * reject as an absent program does.
 */
function host(on: On, env: Record<string, string>, files: Record<string, string>, { missingMmdc = false } = {}) {
  const mmdc: string[] = []
  const themes: string[] = []
  const finds: string[][] = []
  const look = { appearance: DARK }
  const reads: string[] = []
  mock.env(on, env)
  const clock = mock.clock(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', (_$, e) => {
    const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === 'id') {
      return { value: { ...ok, stdout: '501\n' } }
    }
    if (e.argv[0] === 'defaults') {
      return { value: { ...ok, ...look.appearance } }
    }
    if (e.argv[0] === 'find') {
      finds.push([...e.argv])
      return { value: ok }
    }
    if (e.argv[0] === 'mmdc') {
      themes.push(e.argv[e.argv.indexOf('-t') + 1] ?? '')
      if (missingMmdc) {
        throw new Error('spawn mmdc ENOENT')
      }
      const source = e.init?.stdin ?? ''
      mmdc.push(source)
      if (source === BROKEN) {
        return { value: { ...ok, exitCode: 1, stderr: MMDC_STDERR } }
      }
      files[e.argv[e.argv.indexOf('-o') + 1] ?? ''] = DIAGRAM_HEAD
    }
    return { value: ok }
  })
  on('fs.exists', (_$, e) => ({ value: files[e.path] !== undefined }))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    const content = files[e.path]
    if (content === undefined) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: e.as === 'bytes' ? { base64: content } : content }
  })
  return { mmdc, reads, clock, themes, finds, look }
}

const reply = (text: string, extra: Partial<Record<string, unknown>> = {}) => ({
  plugin: 'inline-mermaid',
  component: 'AssistantMessage',
  props: { text, isFirstOfReply: true, ...extra } as unknown as RenderPropsOf['AssistantMessage'],
}) as const

const toolRow = (tool: string, input: Record<string, unknown>, extra: Partial<Record<string, unknown>> = {}) => ({
  plugin: 'inline-mermaid',
  component: 'ToolUse',
  props: { tool_use_id: 'toolu_1', tool, input, isRunning: false, isErrored: false, isInterrupted: false, ...extra } as unknown as RenderPropsOf['ToolUse'],
}) as const

const START = { cwd: '/Users/me/wow14', surface: 'terminal', isInteractive: true } as const

test('a reply with a mermaid block draws a note, then the diagram once mmdc is done, with a link to open it large', async ($, on) => {
  const { mmdc, clock } = host(on, GHOSTTY, {})
  await $.session.start(START)
  const ui = await $.ui.mount({ ...reply(`So läuft es:\n\n${fence(STATES)}`), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /drawing diagram/ })).toBeDefined()
  await clock.advance(300)
  expect(mmdc).toEqual([STATES])
  const png = `${DIR}/${await digest('dark', STATES)}.png`
  expect(await ui.find({ type: 'Image' })).toMatchObject({ props: { source: { file: png, format: 'png' }, columns: 14, rows: 24 } })
  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: `file://${png}` } })
  await ui.unmount()
  // Drawn again (a scroll, a resize): from the cache, no second mmdc.
  const again = await $.ui.mount({ ...reply(fence(STATES)), surface: 'terminal' })
  await clock.advance(300)
  expect(await again.find({ type: 'Image' })).toBeDefined()
  expect(mmdc).toEqual([STATES])
  await again.unmount()
})

test('a syntax error shows as one dim line, cached, and mmdc is not run again', async ($, on) => {
  const { mmdc, clock } = host(on, GHOSTTY, {})
  await $.session.start(START)
  const ui = await $.ui.mount({ ...reply(fence(BROKEN)), surface: 'terminal' })
  await clock.advance(300)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Parse error on line 2/ })).toBeDefined()
  await ui.redraw()
  await clock.advance(300)
  expect(mmdc).toEqual([BROKEN])
  await ui.unmount()
})

test('without mmdc the row says so instead of drawing', async ($, on) => {
  const { clock } = host(on, GHOSTTY, {}, { missingMmdc: true })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...reply(fence(STATES)), surface: 'terminal' })
  await clock.advance(300)
  expect(await ui.find({ type: 'Text', text: /mmdc did not run/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await ui.unmount()
})

test('iTerm2 and a reply without diagrams stay as drawn', async ($, on) => {
  const { mmdc, clock } = host(on, ITERM, {})
  await $.session.start(START)
  for (const [row, surface] of [
    [reply(fence(STATES)), 'terminal'],
    [reply('kein Diagramm'), 'terminal'],
  ] as const) {
    const ui = await $.ui.mount({ ...row, surface })
    await clock.advance(300)
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /mermaid/ })).toBeUndefined()
    await ui.unmount()
  }
  expect(mmdc).toEqual([])
})

test('the desktop and a summary row draw no diagram in Ghostty either', async ($, on) => {
  const { mmdc, clock } = host(on, GHOSTTY, {})
  await $.session.start(START)
  for (const [row, surface] of [
    [reply(fence(STATES)), 'desktop'],
    [reply(fence(STATES), { isSummary: true }), 'terminal'],
  ] as const) {
    const ui = await $.ui.mount({ ...row, surface })
    await clock.advance(300)
    expect(await ui.find({ type: 'Text', text: /mermaid/ })).toBeUndefined()
    await ui.unmount()
  }
  expect(mmdc).toEqual([])
})

test('Read and Write of a .mmd file draw it; a running or failed call does not', async ($, on) => {
  const { mmdc, clock } = host(on, GHOSTTY, { '/p/ablauf.mmd': `${STATES}\n` })
  await $.session.start(START)
  for (const row of [toolRow('Read', { file_path: '/p/ablauf.mmd' }), toolRow('Write', { file_path: '/p/neu.mmd', content: 'flowchart LR\n  A --> B\n' })]) {
    const ui = await $.ui.mount({ ...row, surface: 'terminal' })
    await clock.advance(300)
    expect(await ui.find({ type: 'Image' })).toBeDefined()
    await ui.unmount()
  }
  expect(mmdc).toEqual([STATES, 'flowchart LR\n  A --> B'])
  for (const row of [toolRow('Read', { file_path: '/p/ablauf.mmd' }, { isRunning: true }), toolRow('Edit', { file_path: '/p/ablauf.mmd', new_string: 'x' }, { isErrored: true })]) {
    const ui = await $.ui.mount({ ...row, surface: 'terminal' })
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    await ui.unmount()
  }
})

test('an Edit of a big Markdown file draws only the diagram it changed', async ($, on) => {
  const blocks = Array.from({ length: 20 }, (_, i) => fence(`flowchart LR\n  S${i} --> E${i}`))
  const doc = blocks.join('\n\n')
  const { mmdc, clock } = host(on, GHOSTTY, { '/p/business-processes.md': doc })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...toolRow('Edit', { file_path: '/p/business-processes.md', old_string: 'S7 --> X7', new_string: 'S7 --> E7' }), surface: 'terminal' })
  await clock.advance(300)
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(1)
  expect(mmdc).toEqual(['flowchart LR\n  S7 --> E7'])
  await ui.unmount()
})

test('a Read of a Markdown file with many diagrams draws four and names the rest', async ($, on) => {
  const doc = Array.from({ length: 6 }, (_, i) => fence(`flowchart LR\n  S${i} --> E${i}`)).join('\n\n')
  const { clock } = host(on, GHOSTTY, { '/p/prozesse.md': doc })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...toolRow('Read', { file_path: '/p/prozesse.md' }), surface: 'terminal' })
  await clock.advance(300)
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(4)
  expect(await ui.find({ type: 'Text', text: /2 more diagrams not drawn/ })).toBeDefined()
  await ui.unmount()
})

test('diagrams follow the macOS appearance: a switch to light draws them again in the light theme', async ($, on) => {
  const { mmdc, themes, clock, look } = host(on, GHOSTTY, {})
  await $.session.start(START)
  const ui = await $.ui.mount({ ...reply(fence(STATES)), surface: 'terminal' })
  await clock.advance(300)
  expect(await ui.find({ type: 'Image' })).toMatchObject({ props: { source: { file: `${DIR}/${await digest('dark', STATES)}.png` } } })
  look.appearance = LIGHT
  await clock.advance(60_000)
  await clock.advance(300)
  expect(themes).toEqual(['dark', 'default'])
  expect(mmdc).toEqual([STATES, STATES])
  expect(await ui.find({ type: 'Image' })).toMatchObject({ props: { source: { file: `${DIR}/${await digest('default', STATES)}.png` } } })
  await ui.unmount()
})

test('CLAUDE_INLINE_MERMAID_THEME overrides the appearance', async ($, on) => {
  const { themes, clock, look } = host(on, { ...GHOSTTY, CLAUDE_INLINE_MERMAID_THEME: 'neutral' }, {})
  look.appearance = LIGHT
  await $.session.start(START)
  const ui = await $.ui.mount({ ...reply(fence(STATES)), surface: 'terminal' })
  await clock.advance(300)
  expect(themes).toEqual(['neutral'])
  await ui.unmount()
})

test('session start deletes cached diagrams older than 30 days', async ($, on) => {
  const { finds } = host(on, GHOSTTY, {})
  await $.session.start(START)
  expect(finds).toEqual([['find', DIR, '-type', 'f', '-mtime', '+30', '-delete']])
})
