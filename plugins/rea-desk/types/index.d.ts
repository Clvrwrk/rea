export type CallStatus = 'runs' | 'ok' | 'error' | 'blocked'

export type ReaCall = {
  id: string
  tool: string
  targets: string[]
  status: CallStatus
  startedAt: number
  ms?: number
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'rea-desk': {
      calls: Shaped<ReaCall[]>
      scope: Shaped<string[]>
      focus: Shaped<string>
    }
  }
}
