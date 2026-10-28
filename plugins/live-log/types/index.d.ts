export type LogFile = { path: string; offset: number }

export type LogTask = {
  id: string
  title: string
  // The background task whose output file is still to be found.
  outputOf?: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  summary?: string
  startedAt: number
  endedAt?: number
  files: LogFile[]
  lines: string[]
  current: string
}

declare module 'claude-code' {
  interface PluginState {
    'live-log': {
      tasks: Shaped<LogTask[]>
      selected: string | null
      // Rows the window is scrolled up from the newest line; 0 follows it.
      scrollBack: number
      // Whether this session's conversation already carries the guidance.
      isGuided: boolean
    }
  }
}
