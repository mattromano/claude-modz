export type DbtRunStatus = 'running' | 'success' | 'warn' | 'error' | 'cancelled' | 'unknown'

export type DbtRunCounts = { pass: number; warn: number; error: number; skip: number; total: number }

export type DbtRun = {
  id: string
  startedAt: number
  finishedAt?: number
  command: string
  repo: string
  sessionId: string
  logPath: string
  rcPath: string
  status: DbtRunStatus
  exitCode?: number
  counts?: DbtRunCounts
  bytes: number
}

export type DbtRunsView = { kind: 'list' } | { kind: 'detail'; id: string }

declare module 'claude-code' {
  interface PluginState {
    'dbt-runs': { runs: DbtRun[]; view: DbtRunsView; isShown: boolean; logEnd: number }
  }
}
