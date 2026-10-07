/** query: SQL through the Databricks MCP; script: a Python script using databricks-*; cli: the databricks CLI. */
export type DbxEventType = 'query' | 'script' | 'cli' | 'blocked'

export type DbxStatus = 'running' | 'succeeded' | 'failed' | 'blocked'

/**
 * One Databricks action. The JSONL file is append-only: a call writes a `running` line
 * when it starts and its settled line when it ends; the last line per `id` wins.
 * Metadata only: SQL text and counts, never result rows or cell values.
 */
export type DbxEvent = {
  id: string
  ts: string
  ended_ts?: string
  session_id: string
  event_type: DbxEventType
  tool: string
  sql_text?: string
  command?: string
  statement_id?: string
  warehouse_id?: string
  status: DbxStatus
  duration_ms?: number
  row_count?: number
  tables_read: string[]
  tables_written: string[]
  block_reason?: string
  /** First line of the tool's error text, for a failed call. */
  error?: string
  /** A Bash call sent to the background: its window ends when history says so, capped. */
  background?: boolean
  /** The argument the SQL rode in, and the non-SQL scalar arguments worth reusing (warehouse, catalog). */
  sql_arg?: string
  call_args?: Record<string, string | number | boolean>
}

/** One system.query.history row, as read; statement text is SQL, never results. */
export type DbxHistoryRow = {
  statement_id: string
  execution_status?: string
  total_duration_ms?: number
  read_bytes?: number
  produced_rows?: number
  warehouse_id?: string
  error_message?: string
  /** Epoch ms (unix_millis), so matching never depends on the warehouse's time zone. */
  start_ms?: number
  end_ms?: number
  statement_text?: string
  client_application?: string
}

/** How a history row ties to an event: by statement id, by identical text in its window, or inferred from a script's window. */
export type DbxMatch = 'statement_id' | 'text' | 'window'

export type DbxEnrichment = {
  /** Epoch ms of the last successful read; 0 before any. */
  fetched_at: number
  rows: DbxHistoryRow[]
  /** Event id -> matched rows. */
  matches: Record<string, { row: string; how: DbxMatch }[]>
  error?: string
}

/** What the panel shows: the whole trace, or one action opened from it. */
export type DbxPaneView = { kind: 'list' } | { kind: 'detail'; id: string }

declare module 'claude-code' {
  interface PluginState {
    'dbx-trace': {
      events: DbxEvent[]
      enrichment: DbxEnrichment
      isShown: boolean
      /** Where this session's page was last written; empty before the first. */
      pagePath: string
      paneView: DbxPaneView
      /** Whether the panel is drawn; the band steps aside while it is. */
      isPaneOpen: boolean
    }
  }
}
