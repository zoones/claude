/** This session's open worklog interval: the last line of today tagged with the session. */
export type Running = { category: string; comment: string; since: string }

declare module 'claude-code' {
  interface PluginState {
    'worklog-band': {
      running: Running | null
      /** True while a `wl` call started from the band runs; the band ignores presses meanwhile. */
      isBusy: boolean
      /** True while the row of project buttons is open. */
      isPicking: boolean
      /** Project picked from that row, waiting for "rebook" or "continue"; null = no question open. */
      pending: string | null
    }
  }
}
