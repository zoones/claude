import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import {
  cachePathFor,
  cellsFor,
  isGraphicsTerminal,
  isImagePath,
  pastedDirCandidates,
  pastedImageNumbers,
  pngSize,
} from './register'

/** The first 32 bytes of a real 867 x 602 PNG (an 8x1kg label), base64. */
const LABEL_HEAD = 'iVBORw0KGgoAAAANSUhEUgAAA2MAAAJaCAIAAAAtUQg='
const GHOSTTY = { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' }
const ITERM = { TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' }
const ROOT = '/Users/me/project'
const SESSION = 'abcdef12-0000-0000-0000-000000000000'

test('isGraphicsTerminal: Ghostty, kitty and WezTerm yes; iTerm2 and anything in tmux no; override wins', async () => {
  expect(isGraphicsTerminal({ termProgram: 'ghostty' })).toBe(true)
  expect(isGraphicsTerminal({ term: 'xterm-kitty' })).toBe(true)
  expect(isGraphicsTerminal({ kittyWindowId: '1' })).toBe(true)
  expect(isGraphicsTerminal({ termProgram: 'WezTerm' })).toBe(true)
  expect(isGraphicsTerminal({ termProgram: 'iTerm.app', term: 'xterm-256color' })).toBe(false)
  expect(isGraphicsTerminal({ termProgram: 'ghostty', tmux: '/tmp/tmux-501/default,1,0' })).toBe(false)
  expect(isGraphicsTerminal({ termProgram: 'iTerm.app', override: '1' })).toBe(true)
  expect(isGraphicsTerminal({ termProgram: 'ghostty', override: '0' })).toBe(false)
})

test('pngSize reads the IHDR size and refuses anything that is no PNG', async () => {
  expect(pngSize(LABEL_HEAD)).toEqual({ width: 867, height: 602 })
  expect(pngSize('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgH')).toBeNull()
  expect(pngSize('')).toBeNull()
})

test('cellsFor keeps the aspect within 60 x 24 cells', async () => {
  expect(cellsFor({ width: 867, height: 602 })).toEqual({ columns: 60, rows: 21 })
  expect(cellsFor({ width: 2000, height: 312 })).toEqual({ columns: 60, rows: 5 })
  expect(cellsFor({ width: 64, height: 64 })).toEqual({ columns: 8, rows: 4 })
  const tall = cellsFor({ width: 400, height: 4000 })
  expect(tall.rows).toBe(24)
  expect(tall.columns).toBeLessThanOrEqual(5)
})

test('pastedImageNumbers and pastedDirCandidates', async () => {
  expect(pastedImageNumbers('see [Image #1] and [Image #12]')).toEqual(['1', '12'])
  expect(pastedImageNumbers('no picture, just [Image] text')).toEqual([])
  expect(pastedDirCandidates('501', ROOT, SESSION)).toEqual([
    `/private/tmp/claude-501/-Users-me-project/${SESSION}/images`,
    `/tmp/claude-501/-Users-me-project/${SESSION}/images`,
  ])
})

/**
 * A host whose files are `files` (path -> base64); every other read or stat fails like a missing
 * file. `sips … <src> --out <dst>` "converts" by writing a PNG to `dst`, and is recorded.
 */
function host(on: On, env: Record<string, string>, files: Record<string, string>) {
  const reads: string[] = []
  const converts: string[] = []
  mock.env(on, env)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SESSION }))
  on('process.run', (_$, e) => {
    const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === 'id') {
      return { value: { ...ok, stdout: '501\n' } }
    }
    if (e.argv[0] === 'sips') {
      const source = e.argv[4] ?? ''
      const out = e.argv[6] ?? ''
      converts.push(source)
      if (files[source] === undefined) {
        return { value: { ...ok, exitCode: 1, stderr: 'Error: file not found' } }
      }
      files[out] = LABEL_HEAD
    }
    return { value: ok }
  })
  on('fs.stat', (_$, e) => {
    if (files[e.path] === undefined) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: { kind: 'file', size: 100, mtimeMs: 1000, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    const base64 = files[e.path]
    if (base64 === undefined) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: { base64 } }
  })
  return { reads, converts }
}

const readRow = (filePath: string, extra: Partial<Record<string, unknown>> = {}) => ({
  plugin: 'inline-images',
  component: 'ToolUse',
  props: {
    tool: 'Read',
    input: { file_path: filePath },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    ...extra,
  } as unknown as RenderPropsOf['ToolUse'],
}) as const

const userRow = (text: string) => ({
  plugin: 'inline-images',
  component: 'UserMessage',
  props: { text, origin: { kind: 'user' }, isExpanded: false } as unknown as RenderPropsOf['UserMessage'],
}) as const

test('a Read of a PNG shows the picture under its row in Ghostty', async ($, on) => {
  host(on, GHOSTTY, { '/shots/label.png': LABEL_HEAD })
  const ui = await $.ui.mount({ ...readRow('/shots/label.png'), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toMatchObject({
    props: { source: { file: '/shots/label.png', format: 'png' }, columns: 60, rows: 21 },
  })
  await ui.unmount()
})

test('iTerm2 keeps the plain row and reads no file', async ($, on) => {
  const { reads } = host(on, ITERM, { '/shots/label.png': LABEL_HEAD })
  const ui = await $.ui.mount({ ...readRow('/shots/label.png'), surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  expect(reads).toEqual([])
  await ui.unmount()
})

test('no picture for a running or failed Read, another file type, or a fake .png', async ($, on) => {
  host(on, GHOSTTY, { '/shots/label.png': LABEL_HEAD, '/shots/fake.png': 'aGVsbG8gd29ybGQsIG5vIHBuZyBoZXJlIGF0IGFsbCE=' })
  for (const row of [
    readRow('/shots/label.png', { isRunning: true }),
    readRow('/shots/label.png', { isErrored: true }),
    readRow('/shots/notes.md'),
    readRow('/shots/fake.png'),
  ]) {
    const ui = await $.ui.mount({ ...row, surface: 'terminal' })
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
    await ui.unmount()
  }
})

test('the desktop draws its own row (no Image element there)', async ($, on) => {
  host(on, GHOSTTY, { '/shots/label.png': LABEL_HEAD })
  const ui = await $.ui.mount({ ...readRow('/shots/label.png'), surface: 'desktop' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await ui.unmount()
})

test('pasted pictures show under the prompt, found in /private/tmp or /tmp', async ($, on) => {
  const linuxDir = `/tmp/claude-501/-Users-me-project/${SESSION}/images`
  host(on, GHOSTTY, { [`${linuxDir}/2.png`]: LABEL_HEAD })
  const ui = await $.ui.mount({ ...userRow('was ist das? [Image #2] und [Image #3]'), surface: 'terminal' })
  const images = await ui.findAll({ type: 'Image' })
  // #3 has no file: only #2 is drawn, from the second candidate folder.
  expect(images).toHaveLength(1)
  expect(images[0]).toMatchObject({ props: { source: { file: `${linuxDir}/2.png`, format: 'png' } } })
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await ui.unmount()
})

test('a prompt without pasted pictures stays as drawn', async ($, on) => {
  const { reads } = host(on, GHOSTTY, {})
  const ui = await $.ui.mount({ ...userRow('commit das'), surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(reads).toEqual([])
  await ui.unmount()
})

test('isImagePath and cachePathFor', async () => {
  expect(['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.heic'].every(isImagePath)).toBe(true)
  expect(['notes.md', 'png', '/dir.png/readme', 'archive.tar.gz'].some(isImagePath)).toBe(false)
  expect(cachePathFor('501', '/Users/me/Documents/bild/img 1.jpg')).toBe(
    '/tmp/claude-inline-images-501/_Users_me_Documents_bild_img_1.jpg.png',
  )
})

test('a dropped JPEG ([Image #4] stored as 4.jpg) is converted with sips and shown from the cache', async ($, on) => {
  const dir = `/private/tmp/claude-501/-Users-me-project/${SESSION}/images`
  const { converts } = host(on, GHOSTTY, { [`${dir}/4.jpg`]: '/9j/4AAQSkZJRgABAQAAAQABAAD' })
  const ui = await $.ui.mount({ ...userRow('[Image #4]'), surface: 'terminal' })
  expect(converts).toEqual([`${dir}/4.jpg`])
  expect(await ui.find({ type: 'Image' })).toMatchObject({
    props: { source: { file: cachePathFor('501', `${dir}/4.jpg`), format: 'png' } },
  })
  await ui.unmount()
})

test('a Read of a JPEG shows the converted picture; an up-to-date cache is not converted again', async ($, on) => {
  const cached = cachePathFor('501', '/shots/page.jpg')
  const { converts } = host(on, GHOSTTY, { '/shots/page.jpg': '/9j/4AAQ', '/shots/old.jpg': '/9j/4AAQ', [cachePathFor('501', '/shots/old.jpg')]: LABEL_HEAD })
  const ui = await $.ui.mount({ ...readRow('/shots/page.jpg'), surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toMatchObject({ props: { source: { file: cached, format: 'png' } } })
  await ui.unmount()
  const again = await $.ui.mount({ ...readRow('/shots/old.jpg'), surface: 'terminal' })
  expect(await again.find({ type: 'Image' })).toBeDefined()
  expect(converts).toEqual(['/shots/page.jpg'])
  await again.unmount()
})

test('a failed conversion (no sips) leaves the row as drawn', async ($, on) => {
  host(on, GHOSTTY, {})
  const ui = await $.ui.mount({ ...readRow('/shots/missing.jpg'), surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await ui.unmount()
})
