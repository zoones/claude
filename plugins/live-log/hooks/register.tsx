import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LogFile, LogTask } from '../types'

const PANE = 'live-log'
const TITLE = 'Live log'
const KEEP_LINES = 2000
const KEEP_TASKS = 20
const POLL_MS = 500
// How long an ended task is still read, for the lines it wrote last.
const LINGER_MS = 3000
const CHUNK_BYTES = 1024 * 1024

// Change the tag when LogTask's fields change: it declines what an earlier
// version stored, which outlives a reload.
const tasks = atom({ plugin: 'live-log', key: 'tasks' } as const, [], {
  shape: 'tasks-2',
})
const selected = atom({ plugin: 'live-log', key: 'selected' } as const, null)
const scrollBack = atom({ plugin: 'live-log', key: 'scrollBack' } as const, 0)
const isGuided = atom({ plugin: 'live-log', key: 'isGuided' } as const, false)
// The tabs above the output, and the info line with the End button below.
const FRAME_ROWS = 2

// Colour codes and other terminal escapes would print as garbage in the pane.
const ESCAPES = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

// A progress bar rewrites its line with \r: keep only what it shows last.
const lastSegment = (line: string) =>
  line.split('\r').filter(part => part !== '').pop() ?? ''

const encoder = new TextEncoder()

// Where the engine keeps a background command's output:
// <tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output
async function outputFile($: EngineInterface, id: string) {
  const script =
    'for d in "${CLAUDE_CODE_TMPDIR:-/tmp}" /tmp "${TMPDIR%/}"; do ' +
    'ls -d "$d"/claude-*/*/*/tasks/"$1".output; done 2>/dev/null | head -1'
  const found = await $.process
    .run(['sh', '-c', script, 'sh', id], { timeoutMs: 5000 })
    .catch(() => undefined)

  return found?.stdout.trim() || undefined
}

// The files a command sends its output to: `> build.log`, `2>&1 >> out.txt`,
// `&> run.log`, `| tee -a test.log`. Relative ones count from the `cd` the
// command starts with, else from the session's directory.
export function logFiles(command: string, cwd: string): string[] {
  const cd = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)/.exec(command)
  const base = (cd && (cd[1] ?? cd[2] ?? cd[3])) || cwd
  const dir = base.startsWith('/') ? base : `${cwd}/${base}`
  const found: string[] = []
  const redirect = /(?:^|[\s;|])(?:&>>?|[12]?>>?|>\|)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>()]+))/g
  const tee = /\btee\s+(?:-[a-z]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>()]+))/g
  for (const pattern of [redirect, tee]) {
    for (const match of command.matchAll(pattern)) {
      const file = match[1] ?? match[2] ?? match[3]
      if (!file || file.startsWith('&') || file.startsWith('/dev/')) continue
      const path = file.startsWith('/') ? file : `${dir}/${file.replace(/^\.\//, '')}`
      if (!found.includes(path)) found.push(path)
    }
  }

  return found
}

// Reads what a file gained since `file.offset`. Only whole lines move the
// offset: a line still being written is shown as `current` and read again.
async function readNew($: EngineInterface, file: LogFile) {
  const stat = await $.fs.stat(file.path).catch(() => undefined)
  if (!stat) return undefined
  // Truncated or replaced: start over.
  const offset = stat.size < file.offset ? 0 : file.offset
  if (stat.size === offset) return undefined

  const read = await $.process
    .run(['sh', '-c', 'tail -c "+$1" "$2" | head -c "$3"', 'sh', String(offset + 1), file.path, String(CHUNK_BYTES)], {
      timeoutMs: 5000,
    })
    .catch(() => undefined)
  if (!read) return undefined

  const end = read.stdout.lastIndexOf('\n') + 1
  const whole = read.stdout.slice(0, end)

  return {
    offset: offset + encoder.encode(whole).length,
    lines: whole === '' ? [] : whole.slice(0, -1).split('\n'),
    current: read.stdout.slice(end),
  }
}

let isPolling = false

async function poll($: EngineInterface) {
  if (isPolling) return
  isPolling = true
  try {
    const now = await $.clock.now()
    const list = await read($, tasks)
    const changes = new Map<string, LogTask>()
    for (const task of list) {
      const isLive = task.status === 'running' || now - (task.endedAt ?? 0) < LINGER_MS
      if (!isLive) continue

      let files = task.files
      if (task.outputOf) {
        const output = await outputFile($, task.outputOf)
        if (output) files = [{ path: output, offset: 0 }, ...files]
      }
      let lines: string[] = []
      let current = ''
      let isMoved = files !== task.files
      const read = await Promise.all(files.map(file => readNew($, file)))
      files = files.map((file, i) => {
        const got = read[i]
        if (!got) return file
        lines = [...lines, ...got.lines]
        current = got.current || current
        isMoved ||= got.offset !== file.offset

        return { ...file, offset: got.offset }
      })
      const clean = (line: string) => lastSegment(line.replace(ESCAPES, ''))
      if (!isMoved && clean(current) === task.current) continue

      changes.set(task.id, {
        ...task,
        outputOf: files.length > task.files.length ? undefined : task.outputOf,
        files,
        lines: [...task.lines, ...lines.map(clean)].slice(-KEEP_LINES),
        current: clean(current),
      })
    }
    if (changes.size > 0) {
      await update($, tasks, all => all.map(task => changes.get(task.id) ?? task))
    }
  } catch {
    // A file vanished mid-read or the like: the next poll tries again.
  } finally {
    isPolling = false
  }
}

async function track(
  $: EngineInterface,
  task: Pick<LogTask, 'id' | 'title' | 'outputOf'> & { paths: string[] },
) {
  const added: LogTask = {
    id: task.id,
    title: task.title,
    outputOf: task.outputOf,
    status: 'running',
    startedAt: await $.clock.now(),
    files: task.paths.map(path => ({ path, offset: 0 })),
    lines: [],
    current: '',
  }
  await update($, tasks, list =>
    [...list.filter(one => one.id !== task.id), added].slice(-KEEP_TASKS),
  )
  await update($, selected, () => task.id)
  await update($, scrollBack, () => 0)
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  if (!opened.isPlaced) {
    $.ui.toast('Background command started: /live-log shows its output')
  }
}

async function markEnded($: EngineInterface, text: string) {
  const ended =
    /<task-id>([\w-]+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>(?:[\s\S]*?<summary>([\s\S]*?)<\/summary>)?/g
  const endedAt = await $.clock.now()
  for (const [, id = '', status = '', summary] of text.matchAll(ended)) {
    const final: LogTask['status'] =
      status === 'completed' || status === 'killed' ? status : 'failed'
    await update($, tasks, list =>
      list.map(task =>
        task.id === id && task.status === 'running'
          ? { ...task, status: final, summary, endedAt }
          : task,
      ),
    )
  }
}

// Tells Claude the pane exists and how to make the most of it.
const GUIDANCE = `# Live log pane

The user has the live-log mod: the output of every Bash command you start with \`run_in_background: true\` appears live in a "Live log" pane beside the chat, together with any file the command redirects its output to (\`> build.log 2>&1\`, \`&>> run.log\`, \`| tee test.log\`).

- Start every command you expect to run longer than about 30 seconds (builds, test suites, installs, migrations, imports, dev servers) with \`run_in_background: true\` instead of in the foreground, so the user can watch it progress. Do not detach it yourself with \`nohup\` or \`&\`: the pane only sees commands the Bash tool backgrounds.
- When the output should also be kept, redirect it to a log file in the same command; the pane follows that file. A relative log path is resolved from a leading \`cd <dir> &&\` of the command, else from the session's directory.
- Make the output appear as it happens instead of block-buffered: \`python -u\` or \`PYTHONUNBUFFERED=1\`, \`stdbuf -oL\` where available, or the tool's own progress or verbose flag.
- Then wait for the completion notification rather than polling the output file or sleeping.
- To watch a log of a process started elsewhere, the user can type \`/live-log <file>\`.`

const MARK: Record<LogTask['status'], string> = {
  running: '●',
  completed: '✓',
  failed: '✗',
  killed: '■',
}

function elapsed(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)

  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

const shorten = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'live-log',
      description: 'Show the live output of background commands, or follow a file',
      argumentHint: '[file]',
    })
    // The reading runs on a timer of the session: work started inside a
    // tool call's hook would end with that hook's budget.
    $.clock.every(POLL_MS, () => void poll($))

    return next(e)
  })

  on('command.run', { command: 'live-log' }, async ($, e) => {
    const file = e.args.trim()
    if (file) {
      const cwd = await $.session.cwd()
      const path = file.startsWith('/') ? file : `${cwd}/${file}`
      await track($, { id: `file-${await $.clock.now()}`, title: file, paths: [path] })
    } else {
      await $.ui.open({ id: PANE, title: TITLE })
    }

    return { text: file ? `Following ${file}.` : 'Live log opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const result = ran.result as { backgroundTaskId?: string } | undefined
    const id = result?.backgroundTaskId
    if (!id || e.agentId) return ran

    const cwd = await $.session.cwd()
    await track($, {
      id,
      title: e.description ?? shorten(e.command, 60),
      outputOf: id,
      paths: logFiles(e.command, cwd),
    }).catch(() => undefined)

    return ran
  })

  // A compaction summarises the prompt that carried the guidance away.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    await update($, isGuided, () => false)

    return compacted
  })

  // The guidance rides along the session's first prompt as context, not
  // every prompt: the transcript keeps it until a compaction. And the engine
  // tells Claude a background command ended with a prompt like
  // <task-notification><task-id>…</task-id>…<status>completed</status>
  // <summary>…</summary></task-notification>.
  on('prompt.submit', async ($, e, next) => {
    const isFirst = !(await read($, isGuided).catch(() => true))
    if (isFirst) await update($, isGuided, () => true).catch(() => undefined)
    const guided = isFirst ? { ...e, context: [...(e.context ?? []), GUIDANCE] } : e

    if (e.origin?.kind === 'task-notification') {
      await markEnded($, e.text).catch(() => undefined)
    }

    return next(guided)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, tasks)
    const chosen = await read($, selected)
    const task = list.find(one => one.id === chosen) ?? list.at(-1)

    if (!task) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No background commands yet.</Text>
          <Text dimColor>Their output shows here while they run.</Text>
        </Box>
      )
    }

    const now = await $.clock.now()
    const shown = task.current ? [...task.lines, task.current] : task.lines
    const logRows = Math.max(1, e.props.scroll.bodyRows - FRAME_ROWS)
    const back = Math.min(await read($, scrollBack), Math.max(0, shown.length - logRows))
    const end = shown.length - back
    const window = shown.slice(Math.max(0, end - logRows), end)
    // Blank rows above short output keep the footer at the bottom.
    const blank = logRows - window.length - (shown.length === 0 ? 1 : 0)
    const info = [
      back > 0 ? `↑ ${back} lines above the end` : undefined,
      task.status === 'running'
        ? `running ${elapsed(now - task.startedAt)}`
        : `${task.summary ?? task.status} · ${elapsed((task.endedAt ?? now) - task.startedAt)}`,
      task.files.map(file => file.path.split('/').pop()).join(', '),
    ]
      .filter(part => part !== undefined)
      .join(' · ')
    const shownTasks = list.slice(-6)
    // One row of tabs: each title gets an equal share of the width.
    const titleRoom = Math.max(
      6,
      Math.floor(e.props.bodyColumns / shownTasks.length) - 6,
    )
    const choose = async (id: string) => {
      await update($, selected, () => id)
      await update($, scrollBack, () => 0)
    }

    // The pane would scroll its whole tree, tabs and footer included; this
    // hook draws exactly the body's rows instead and moves its own window
    // (`ui.scroll` below), so the tabs stay at the top and the footer at the
    // bottom.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="nowrap">
          {shownTasks.map((one, i) => (
            <Button
              key={`task-${one.id}`}
              hotkey={String(i + 1)}
              label={`${MARK[one.status]} ${shorten(one.title, titleRoom)}`}
              onPress={() => choose(one.id)}
            />
          ))}
        </Box>
        {Array.from({ length: Math.max(0, blank) }, (_, i) => (
          <Text key={`blank-${i}`}> </Text>
        ))}
        {shown.length === 0 && <Text dimColor>(no output yet)</Text>}
        {window.map((line, i) => (
          <Text key={`line-${i}`} wrap="truncate-end">
            {line === '' ? ' ' : line}
          </Text>
        ))}
        <Box flexDirection="row" flexWrap="nowrap">
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {info}
            </Text>
          </Box>
          <Button
            key="end"
            hotkey="e"
            label={back > 0 ? '↓ End' : '↓ following'}
            onPress={() => update($, scrollBack, () => 0)}
          />
        </Box>
      </Box>
    )
  })

  // The wheel and the scroll keys move this hook's own window over the
  // output; the engine's window stays put (no `next`).
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    const list = await read($, tasks)
    const chosen = await read($, selected)
    const task = list.find(one => one.id === chosen) ?? list.at(-1)
    const lines = (task?.lines.length ?? 0) + (task?.current ? 1 : 0)
    const most = Math.max(0, lines - Math.max(1, e.bodyRows - FRAME_ROWS))
    await update($, scrollBack, back => Math.min(most, Math.max(0, back - e.by)))

    return {}
  })
}
