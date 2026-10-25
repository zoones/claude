// Tested via: claude plugin test plugins/inline-images (hooks/register.test.tsx)
import type { EngineInterface, Register } from 'claude-code'

const MAX_COLUMNS = 90
const MAX_ROWS = 36

export type TerminalEnv = {
  override?: string
  termProgram?: string
  term?: string
  kittyWindowId?: string
  tmux?: string
}

/**
 * Whether the terminal draws pictures (kitty graphics protocol): Ghostty, kitty, WezTerm, never
 * through tmux. Elsewhere the Image element would only draw its alt text under every picture, so
 * the mod stays out of the way. CLAUDE_INLINE_IMAGES=1 / 0 overrides the guess.
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

/** Width and height from the IHDR chunk of a PNG given as base64 (bytes 16-23, big endian); null when it is no PNG. */
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
 * Cells for a picture: about 8 pixels a column, at most MAX_COLUMNS x MAX_ROWS and the room the row
 * has, aspect kept (a cell is about twice as tall as wide).
 */
export function cellsFor(size: { width: number; height: number }, room = MAX_COLUMNS) {
  const maxColumns = Math.max(8, Math.min(MAX_COLUMNS, room))
  let columns = Math.min(maxColumns, Math.max(8, Math.round(size.width / 8)))
  let rows = Math.round((columns * size.height) / size.width / 2)
  if (rows > MAX_ROWS) {
    columns = Math.max(1, Math.round((MAX_ROWS * 2 * size.width) / size.height))
    rows = MAX_ROWS
  }
  const ret = { columns, rows: Math.max(1, rows) }
  return ret
}

/** The N of every `[Image #N]` placeholder a prompt carries for a pasted picture, in order. */
export function pastedImageNumbers(text: string) {
  const ret = [...text.matchAll(/\[Image #(\d+)\]/g)].map(m => m[1] ?? '').filter(n => n !== '')
  return ret
}

/**
 * Where Claude Code keeps a session's pasted pictures (`[Image #N]` = `images/N.png`): its temp
 * folder, `<tmp>/claude-<uid>/<project root with '/' as '-'>/<session id>/images`. The API does not
 * hand plugins the pasted bytes, so the folder is derived; macOS resolves /tmp under /private.
 */
export function pastedDirCandidates(uid: string, root: string, sessionId: string) {
  const slug = root.replaceAll('/', '-')
  const ret = ['/private/tmp', '/tmp'].map(tmp => `${tmp}/claude-${uid}/${slug}/${sessionId}/images`)
  return ret
}

/** Picture files the mod shows; all but PNG are converted to PNG first (the terminal draws PNG only). */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'tif', 'tiff', 'bmp']

export function isImagePath(path: string) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const ret = path.includes('.') && IMAGE_EXTENSIONS.includes(ext)
  return ret
}

/** Where the PNG converted from `path` is kept: one flat cache folder per user, the path flattened into the name. */
export function cachePathFor(uid: string, path: string) {
  const ret = `/tmp/claude-inline-images-${uid}/${path.replace(/[^A-Za-z0-9._-]/g, '_')}.png`
  return ret
}

/** Whether pictures are drawn at all, and this machine's uid; null until resolved. */
let host: { isOn: boolean; uid: string } | null = null

/**
 * Resolves `host` once per load, kept only once it succeeded: a call of an abandoned draw rejects
 * (`aborted, the call interrupted`), and the next draw has to try again rather than go on with no uid.
 */
async function resolveHost($: EngineInterface) {
  if (host !== null) {
    return host
  }
  const isOn = isGraphicsTerminal({
    override: await $.env.get('CLAUDE_INLINE_IMAGES'),
    termProgram: await $.env.get('TERM_PROGRAM'),
    term: await $.env.get('TERM'),
    kittyWindowId: await $.env.get('KITTY_WINDOW_ID'),
    tmux: await $.env.get('TMUX'),
  })
  const uid = isOn ? (await $.process.run(['id', '-u'])).stdout.trim() : ''
  host = { isOn, uid }
  return host
}

/** The resolved host for a draw, or null when this draw could not resolve it (it then stays plain). */
async function hostForDraw($: EngineInterface) {
  try {
    const ret = await resolveHost($)
    return ret
  } catch {
    return null
  }
}

async function mtimeOf($: EngineInterface, path: string) {
  try {
    const ret = (await $.fs.stat(path)).mtimeMs
    return ret
  } catch {
    return null
  }
}

/**
 * A PNG of the picture at `path`: the file itself when it is one, else a copy converted by `sips`
 * (macOS) into the cache, redone when the source is newer. Null when that fails (e.g. no `sips`).
 */
async function asPng($: EngineInterface, path: string, uid: string) {
  if (path.toLowerCase().endsWith('.png')) {
    return path
  }
  const sourceTime = await mtimeOf($, path)
  if (sourceTime === null) {
    return null
  }
  const cache = cachePathFor(uid, path)
  const cacheTime = await mtimeOf($, cache)
  if (cacheTime !== null && cacheTime >= sourceTime) {
    return cache
  }
  try {
    await $.process.run(['mkdir', '-p', cache.slice(0, cache.lastIndexOf('/'))])
    const res = await $.process.run(['sips', '-s', 'format', 'png', path, '--out', cache])
    const ret = res.exitCode === 0 ? cache : null
    return ret
  } catch {
    return null
  }
}

/**
 * The picture at `path` as a PNG with the cells to draw it in (within `room` columns), or null when
 * it is missing or unreadable; `source` is the file itself, which the link under it opens.
 */
async function picture($: EngineInterface, path: string, uid: string, room: number) {
  try {
    const png = await asPng($, path, uid)
    if (png === null) {
      return null
    }
    const { base64 } = await $.fs.read(png, { as: 'bytes' })
    const size = pngSize(base64)
    const ret = size === null ? null : { path: png, source: path, ...cellsFor(size, room) }
    return ret
  } catch {
    return null
  }
}

export const register: Register = on => {
  // Resolve the host outside any draw, which the engine may abandon midway; rows drawn before it was
  // known (an install into a running session) are drawn again.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if ((await hostForDraw($))?.isOn) {
      $.ui.invalidate('ui.render')
    }
    return started
  })

  // A Read of a picture shows it right under its transcript row.
  on('ui.render', { component: 'ToolUse', props: { tool: 'Read' } }, async ($, e, next) => {
    const row = await next(e)
    const input = e.props.input as { file_path?: unknown } | null
    const path = typeof input?.file_path === 'string' ? input.file_path : ''
    const elements = $.ui.resolve(e)
    if (e.props.isRunning || e.props.isErrored || !isImagePath(path) || !('Image' in elements)) {
      return row
    }
    const resolved = await hostForDraw($)
    const room = (e.viewport?.columns ?? MAX_COLUMNS) - 7
    const shown = resolved?.isOn ? await picture($, path, resolved.uid, room) : null
    if (shown === null) {
      return row
    }
    const { Box, Image, Link } = elements

    // The link opens the file in the system viewer (Preview on macOS): Ghostty and kitty on a cmd-click.
    return (
      <Box flexDirection="column">
        {row}
        <Box marginLeft={5} flexDirection="column">
          <Image source={{ file: shown.path, format: 'png' }} columns={shown.columns} rows={shown.rows} alt={`[${shown.path}]`} />
          <Link href={`file://${shown.source}`} label="↗ open large" />
        </Box>
      </Box>
    )
  })

  // Pictures pasted or dropped into a prompt (`[Image #N]`) show under that prompt's row.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const row = await next(e)
    const numbers = pastedImageNumbers(e.props.text)
    const elements = $.ui.resolve(e)
    if (numbers.length === 0 || !('Image' in elements)) {
      return row
    }
    const resolved = await hostForDraw($)
    if (!resolved?.isOn) {
      return row
    }
    const dirs = pastedDirCandidates(resolved.uid, await $.session.root(), await $.session.id())
    // Claude Code keeps a pasted file's own format (`4.jpg` for a dropped JPEG), so probe each extension.
    const room = (e.viewport?.columns ?? MAX_COLUMNS) - 4
    const shown: { path: string; source: string; columns: number; rows: number }[] = []
    for (const n of numbers) {
      const candidates = dirs.flatMap(dir => IMAGE_EXTENSIONS.map(ext => `${dir}/${n}.${ext}`))
      for (const path of candidates) {
        if ((await mtimeOf($, path)) === null) {
          continue
        }
        const found = await picture($, path, resolved.uid, room)
        if (found !== null) {
          shown.push(found)
        }
        break
      }
    }
    if (shown.length === 0) {
      return row
    }
    const { Box, Image, Link } = elements

    return (
      <Box flexDirection="column">
        {row}
        {shown.map(p => (
          <Box marginLeft={2} flexDirection="column">
            <Image key={p.path} source={{ file: p.path, format: 'png' }} columns={p.columns} rows={p.rows} alt={`[${p.path}]`} />
            <Link href={`file://${p.source}`} label="↗ open large" />
          </Box>
        ))}
      </Box>
    )
  })
}
