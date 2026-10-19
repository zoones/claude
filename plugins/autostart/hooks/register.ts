// Tested via: claude plugin test plugins/autostart (hooks/register.test.ts)
import type { EngineInterface, Register } from 'claude-code'

const FILE = 'AUTOSTART.md'
const COMMAND = 'autostart'
/** Sessions already started, so a reload or a resume does not run the file again. */
const STARTED_KEY = 'startedSessions'
/** Per directory, the AUTOSTART.md text the person approved; any change needs a new approval. */
const TRUSTED_KEY = 'trusted'
/** Started sessions are dropped from the store after this long. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

/** The prompt the model reads: the file's text, named as coming from it. */
export function autostartPrompt(cwd: string, text: string) {
  const ret = `Instructions from ${FILE} in ${cwd}, run at session start:\n\n${text.trim()}`
  return ret
}

/** The directory's AUTOSTART.md, or null when there is none (or it is empty). */
async function readFile($: EngineInterface, cwd: string) {
  const text = await $.fs.read(`${cwd}/${FILE}`).catch(() => null)
  const ret = typeof text === 'string' && text.trim() !== '' ? text : null
  return ret
}

async function trusted($: EngineInterface) {
  const ret = ((await $.store.get(TRUSTED_KEY)) ?? {}) as Record<string, string>
  return ret
}

/** True the first time a session asks; remembers it for the next. */
async function firstStart($: EngineInterface) {
  const [now, sessionId] = await Promise.all([$.clock.now(), $.session.id()])
  const started = ((await $.store.get(STARTED_KEY)) ?? {}) as Record<string, number>
  if (started[sessionId] !== undefined) {
    return false
  }
  const kept = Object.fromEntries(Object.entries(started).filter(([, at]) => now - at < KEEP_MS))
  await $.store.set(STARTED_KEY, { ...kept, [sessionId]: now })
  return true
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ret = await next(e)
    if (!e.isInteractive) {
      return ret
    }
    await $.command.register({ name: COMMAND, description: `Run this directory's ${FILE} now and trust it for later sessions` })

    const text = await readFile($, e.cwd)
    if (text === null || !(await firstStart($))) {
      return ret
    }
    if ((await trusted($))[e.cwd] === text) {
      void $.prompt.submit({ text: autostartPrompt(e.cwd, text) })
    } else {
      // A cloned repository must not get to prompt Claude on its own: new or changed files wait for /autostart.
      void $.ui.toast(`${FILE} found here, not yet trusted: /${COMMAND} runs it and trusts it from now on`)
    }
    return ret
  })

  on('command.run', { command: COMMAND }, async $ => {
    const cwd = await $.session.cwd()
    const text = await readFile($, cwd)
    if (text === null) {
      return { text: `No ${FILE} in ${cwd}.` }
    }
    await $.store.set(TRUSTED_KEY, { ...(await trusted($)), [cwd]: text })
    // Submitted from the command's own hook the prompt would wait on that hook: hand it to a timer.
    void $.clock.after(0, () => $.prompt.submit({ text: autostartPrompt(cwd, text) }))
    return { text: `${FILE} trusted for ${cwd}; it runs at the start of every session here until it changes.` }
  })
}
