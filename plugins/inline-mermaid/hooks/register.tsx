// Tested via: claude plugin test plugins/inline-mermaid (hooks/register.test.tsx)
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

const MAX_COLUMNS = 100
const MAX_ROWS = 40
/** Diagrams drawn under one row at most; a Read of a big Markdown file names the rest. */
const MAX_PER_ROW = 4
/** mmdc renders at this pixel ratio, so a diagram stays sharp on a Retina screen. */
const SCALE = 2
const THEMES = ['dark', 'default', 'forest', 'neutral']
/** How often the macOS appearance is looked at again, so diagrams follow a switch to light or dark. */
const APPEARANCE_EVERY_MS = 60_000
/** Cached diagrams older than this are deleted at session start. */
const CACHE_DAYS = 30

export type TerminalEnv = {
  override?: string
  termProgram?: string
  term?: string
  kittyWindowId?: string
  tmux?: string
}

/**
 * Whether the terminal draws pictures (kitty graphics protocol): Ghostty, kitty, WezTerm, never
 * through tmux. CLAUDE_INLINE_MERMAID=1 / 0 overrides the guess. (Same rule as inline-images.)
 */
export function isGraphicsTerminal(env: TerminalEnv) {
  if (env.override === '1' || env.override === '0') {
    return env.override === '1'
  }
  if (env.tmux) {
    return false
  }
  const ret =
    env.termProgram === 'ghostty' ||
    env.termProgram === 'WezTerm' ||
    env.term === 'xterm-kitty' ||
    env.term === 'xterm-ghostty' ||
    Boolean(env.kittyWindowId)
  return ret
}

/**
 * The mmdc theme matching the terminal: CLAUDE_INLINE_MERMAID_THEME when it names one, else the
 * macOS appearance, which Ghostty with `theme = light:…,dark:…`, kitty and WezTerm follow:
 * `defaults read -g AppleInterfaceStyle` says `Dark` in dark mode and fails in light mode, where the
 * key is unset ("Could not find key …", on older macOS "… does not exist"). Anything else (Linux, no `defaults`) is taken as dark. `appearance` is that call's
 * result, or null when it could not run.
 */
export function themeFor(override: string | undefined, appearance: { exitCode: number; stdout: string; stderr: string } | null) {
  if (override !== undefined && THEMES.includes(override)) {
    return override
  }
  const isLight = appearance !== null && appearance.exitCode !== 0 && /could not find key|does not exist/i.test(appearance.stderr)
  const ret = isLight ? 'default' : 'dark'
  return ret
}

export type Block = { source: string; start: number; end: number }

/** Every closed ```mermaid fence in `text`, with where it stands; a fence still streaming is left out. */
export function mermaidBlocks(text: string) {
  const fence = /^[ \t]{0,3}```mermaid[ \t]*\r?\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$/gm
  const ret: Block[] = [...text.matchAll(fence)]
    .map(m => ({ source: (m[1] ?? '').trimEnd(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
    .filter(b => b.source.trim() !== '')
  return ret
}

export function isMermaidFile(path: string) {
  return /\.(mmd|mermaid)$/i.test(path)
}

export function isMarkdownFile(path: string) {
  return /\.(md|markdown)$/i.test(path)
}

/** The character range of lines `offset` (1-based) through `offset + limit - 1` of `text`, as Read reads them. */
export function lineRange(text: string, offset?: number, limit?: number) {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    starts.push(i + 1)
  }
  const first = Math.max(1, offset ?? 1)
  const last = limit === undefined ? starts.length : first + limit - 1
  const ret = { start: starts[first - 1] ?? text.length, end: last >= starts.length ? text.length : (starts[last] ?? text.length) }
  return ret
}

const overlaps = (b: Block, start: number, end: number) => b.start < end && start < b.end

/**
 * The diagrams of a Markdown file worth drawing under a tool row: those Read read (its lines), those
 * Write wrote (all), those Edit touched (blocks overlapping each place `new_string` now stands; the
 * fences of `new_string` itself when the file has moved on). An unrelated block of a big file is
 * left out, so editing one step of a long process document shows that one diagram.
 */
export function markdownBlocksFor(tool: string, input: Record<string, unknown>, file: string | null) {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const num = (k: string) => (typeof input[k] === 'number' ? (input[k] as number) : undefined)
  if (tool === 'Write') {
    return mermaidBlocks(str('content'))
  }
  if (tool === 'Read') {
    if (file === null) {
      return []
    }
    const { start, end } = lineRange(file, num('offset'), num('limit'))
    return mermaidBlocks(file).filter(b => overlaps(b, start, end))
  }
  const changed = str('new_string')
  if (changed === '') {
    return []
  }
  const blocks = file === null ? [] : mermaidBlocks(file)
  const hits = new Set<Block>()
  for (let at = file?.indexOf(changed) ?? -1; at !== -1; at = file?.indexOf(changed, at + 1) ?? -1) {
    blocks.filter(b => overlaps(b, at, at + changed.length)).forEach(b => hits.add(b))
  }
  const ret = hits.size > 0 ? blocks.filter(b => hits.has(b)) : mermaidBlocks(changed)
  return ret
}

/** The gist of mmdc's stderr: the `Error:` line and what follows, without the code excerpt and stack. */
export function errorGist(stderr: string) {
  const lines = stderr.split('\n').map(l => l.trim())
  const from = lines.findIndex(l => l.startsWith('Error:'))
  const kept: string[] = []
  for (const line of from === -1 ? lines : lines.slice(from)) {
    if (/^at\s|^\S+\s\(.*:\d+:\d+\)$/.test(line)) {
      break
    }
    if (line === '' || /^\.\.\.|^-*\^$/.test(line)) {
      continue
    }
    kept.push(line.replace(/^Error:\s*/, ''))
  }
  const ret = kept.join(' ').slice(0, 200) || 'mmdc failed'
  return ret
}

/** Width and height from the IHDR chunk of a PNG given as base64; null when it is no PNG. */
export function pngSize(base64: string) {
  const head = (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64(base64.slice(0, 32))
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && head.length >= 24
  if (!isPng) {
    return null
  }
  const be = (i: number) => (((head[i] ?? 0) << 24) | ((head[i + 1] ?? 0) << 16) | ((head[i + 2] ?? 0) << 8) | (head[i + 3] ?? 0)) >>> 0
  const ret = { width: be(16), height: be(20) }
  return ret.width > 0 && ret.height > 0 ? ret : null
}

/**
 * Cells for a diagram rendered at SCALE: about 6 CSS pixels a column (a little larger than the
 * browser draws it), within MAX_COLUMNS x MAX_ROWS and the room the row has; aspect kept.
 */
export function cellsFor(size: { width: number; height: number }, room = MAX_COLUMNS) {
  const maxColumns = Math.max(8, Math.min(MAX_COLUMNS, room))
  let columns = Math.min(maxColumns, Math.max(8, Math.round(size.width / SCALE / 6)))
  let rows = Math.round((columns * size.height) / size.width / 2)
  if (rows > MAX_ROWS) {
    columns = Math.max(1, Math.round((MAX_ROWS * 2 * size.width) / size.height))
    rows = MAX_ROWS
  }
  const ret = { columns, rows: Math.max(1, rows) }
  return ret
}

/** A short hex digest of the theme and diagram text: the cache key. */
export async function digest(theme: string, source: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${theme}\n${source}`)))
  const ret = [...bytes.slice(0, 10)].map(b => b.toString(16).padStart(2, '0')).join('')
  return ret
}

export function cacheDirFor(uid: string) {
  return `/tmp/claude-inline-mermaid-${uid}`
}

/** Whether diagrams are drawn and this machine's uid; null until resolved. */
let host: { isOn: boolean; uid: string } | null = null
/** The mmdc theme now; null until session.start looked, and no diagram is drawn before. */
let theme: string | null = null
/** Diagrams waiting for mmdc, by digest; a draw only queues, the session.start worker runs them. */
const queue = new Map<string, { dir: string; theme: string; source: string }>()
/** Diagrams queued or being drawn by mmdc now, by digest. */
const running = new Set<string>()
/** Whether the worker started; a draw before it (or with none) queues nothing. */
let hasWorker = false
/** Why mmdc could not run at all (not installed, …), by digest; kept so a redraw does not retry it. */
const unrunnable = new Map<string, string>()

/** Resolves `host` once per load, kept only once it succeeded (a call of an abandoned draw rejects). */
async function resolveHost($: EngineInterface) {
  if (host !== null) {
    return host
  }
  const isOn = isGraphicsTerminal({
    override: await $.env.get('CLAUDE_INLINE_MERMAID'),
    termProgram: await $.env.get('TERM_PROGRAM'),
    term: await $.env.get('TERM'),
    kittyWindowId: await $.env.get('KITTY_WINDOW_ID'),
    tmux: await $.env.get('TMUX'),
  })
  const uid = isOn ? (await $.process.run(['id', '-u'])).stdout.trim() : ''
  host = { isOn, uid }
  return host
}

async function hostForDraw($: EngineInterface) {
  try {
    const ret = await resolveHost($)
    return ret
  } catch {
    return null
  }
}

/** The theme matching the terminal now (themeFor); `dark` when even that cannot be asked. */
async function currentTheme($: EngineInterface) {
  try {
    const override = await $.env.get('CLAUDE_INLINE_MERMAID_THEME')
    let appearance: { exitCode: number; stdout: string; stderr: string } | null = null
    try {
      appearance = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'])
    } catch {
      appearance = null
    }
    return themeFor(override, appearance)
  } catch {
    return 'dark'
  }
}

/** Looks at the appearance again and redraws with the other theme once it changed. */
async function followAppearance($: EngineInterface) {
  const now = await currentTheme($)
  if (now !== theme) {
    theme = now
    $.ui.invalidate('ui.render')
  }
}

/** Runs mmdc for one diagram on the worker's `$`, leaving `<key>.png` or `<key>.err`, then redraws. */
async function render($: EngineInterface, dir: string, key: string, theme: string, source: string) {
  try {
    await $.process.run(['mkdir', '-p', dir])
    const res = await $.process.run(
      ['mmdc', '-i', '-', '-o', `${dir}/${key}.png`, '-b', 'transparent', '-t', theme, '-s', String(SCALE), '-q'],
      { stdin: source, timeoutMs: 60_000 },
    )
    if (res.exitCode !== 0 || !(await $.fs.exists(`${dir}/${key}.png`))) {
      await $.fs.write(`${dir}/${key}.err`, errorGist(res.stderr))
    }
  } catch (err) {
    unrunnable.set(key, `mmdc did not run: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    running.delete(key)
    $.ui.invalidate('ui.render')
  }
}

type Shown = { key: string } & ({ path: string; columns: number; rows: number } | { error: string } | { isPending: true })

/** What to draw for one diagram: its cached picture, its error, or a note while mmdc runs in the background. */
async function diagram($: EngineInterface, source: string, resolved: { uid: string; theme: string }, room: number): Promise<Shown> {
  const dir = cacheDirFor(resolved.uid)
  const key = await digest(resolved.theme, source)
  const png = `${dir}/${key}.png`
  if (unrunnable.has(key)) {
    return { key, error: unrunnable.get(key) ?? '' }
  }
  try {
    const size = pngSize((await $.fs.read(png, { as: 'bytes' })).base64)
    if (size !== null) {
      return { key, path: png, ...cellsFor(size, room) }
    }
  } catch {
    // not drawn yet
  }
  try {
    return { key, error: await $.fs.read(`${dir}/${key}.err`) }
  } catch {
    // no error either
  }
  if (!running.has(key) && hasWorker) {
    running.add(key)
    queue.set(key, { dir, theme: resolved.theme, source })
  }
  return { key, isPending: true }
}

/** The row with the diagrams of `sources` under it, or the row alone where none are drawn. */
async function withDiagrams($: EngineInterface, e: RenderInput, row: RenderElement, sources: string[], indent: number): Promise<RenderElement> {
  const elements = $.ui.resolve(e)
  if (e.surface !== 'terminal' || sources.length === 0 || !('Image' in elements)) {
    return row
  }
  const resolved = await hostForDraw($)
  const drawTheme = theme
  if (!resolved?.isOn || drawTheme === null) {
    return row
  }
  const room = (e.viewport?.columns ?? MAX_COLUMNS) - indent - 2
  const shown: Shown[] = []
  for (const source of sources.slice(0, MAX_PER_ROW)) {
    shown.push(await diagram($, source, { uid: resolved.uid, theme: drawTheme }, room))
  }
  const more = sources.length - shown.length
  const { Box, Image, Text, Link } = elements

  return (
    <Box flexDirection="column">
      {row}
      {shown.map(d => (
        <Box key={d.key} marginLeft={indent} flexDirection="column">
          {'path' in d ? (
            <>
              <Image key={d.key} source={{ file: d.path, format: 'png' }} columns={d.columns} rows={d.rows} alt="[mermaid diagram]" />
              <Link href={`file://${d.path}`} label="↗ open large" />
            </>
          ) : 'error' in d ? (
            <Text dimColor>mermaid: {d.error}</Text>
          ) : (
            <Text dimColor>mermaid: drawing diagram…</Text>
          )}
        </Box>
      ))}
      {more > 0 ? (
        <Box marginLeft={indent}>
          <Text dimColor>mermaid: {more} more diagram{more === 1 ? '' : 's'} not drawn</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const resolved = await hostForDraw($)
    if (resolved?.isOn) {
      theme = await currentTheme($)
      $.clock.every(APPEARANCE_EVERY_MS, () => void followAppearance($))
      // Old diagrams go; a missing folder (nothing drawn yet) is no error worth a word.
      $.process.run(['find', cacheDirFor(resolved.uid), '-type', 'f', '-mtime', `+${CACHE_DAYS}`, '-delete']).catch(() => undefined)
      // mmdc takes a second or two: it runs here, outside any draw, which then only waits on the cache.
      hasWorker = true
      $.clock.every(300, () => {
        for (const [key, job] of queue) {
          queue.delete(key)
          void render($, job.dir, key, job.theme, job.source)
        }
      })
      $.ui.invalidate('ui.render')
    }
    return started
  })

  // Diagrams Claude writes into a reply show right under that reply's text.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const row = await next(e)
    if (e.props.isSummary) {
      return row
    }
    const sources = mermaidBlocks(e.props.text).map(b => b.source)
    return withDiagrams($, e, row, sources, 2)
  })

  // Read, Write and Edit of a .mmd file, or of Markdown holding mermaid fences, show the diagrams they touched.
  for (const tool of ['Read', 'Write', 'Edit']) {
    on('ui.render', { component: 'ToolUse', props: { tool } }, async ($, e, next) => {
      const row = await next(e)
      const input = (e.props.input ?? {}) as Record<string, unknown>
      const path = typeof input.file_path === 'string' ? input.file_path : ''
      if (e.props.isRunning || e.props.isErrored || e.surface !== 'terminal' || !(isMermaidFile(path) || isMarkdownFile(path))) {
        return row
      }
      let file: string | null = null
      if (tool !== 'Write') {
        try {
          file = await $.fs.read(path)
        } catch {
          file = null
        }
      }
      let sources: string[]
      if (isMermaidFile(path)) {
        const whole = tool === 'Write' ? (typeof input.content === 'string' ? input.content : '') : (file ?? '')
        sources = whole.trim() === '' ? [] : [whole.trimEnd()]
      } else {
        sources = markdownBlocksFor(tool, input, file).map(b => b.source)
      }
      return withDiagrams($, e, row, sources, 5)
    })
  }
}
