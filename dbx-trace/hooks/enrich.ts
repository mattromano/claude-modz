import type { DbxEnrichment, DbxEvent, DbxHistoryRow, DbxMatch } from '../types'
import { normalizeSql, sqlString } from './sql'

// Marks the enrichment query so it never shows up as one of the session's own statements.
export const ENRICH_MARK = 'dbx-trace enrichment'

// Clock skew between this machine and the warehouse, plus queueing before start_time.
const TEXT_SLACK_MS = 2 * 60 * 1000
const WINDOW_SLACK_MS = 5 * 1000
// Past this, an event that never matched is taken as never going to (history lag is minutes).
const PENDING_MS = 15 * 60 * 1000

export const emptyEnrichment = (): DbxEnrichment => ({ fetched_at: 0, rows: [], matches: {} })

const startOf = (e: DbxEvent) => Date.parse(e.ts)
// A background run never reports its end here; its window is capped.
const BACKGROUND_MS = 30 * 60 * 1000
const endOf = (e: DbxEvent, now: number) =>
  e.ended_ts !== undefined && e.background !== true
    ? Date.parse(e.ended_ts)
    : Math.min(now, Date.parse(e.ts) + BACKGROUND_MS)

/** Events a history read could still tell more about. */
export const pendingEvents = (events: readonly DbxEvent[], enrichment: DbxEnrichment, now: number): DbxEvent[] =>
  events.filter(
    e =>
      e.status !== 'blocked' &&
      e.status !== 'running' &&
      (enrichment.matches[e.id]?.length ?? 0) === 0 &&
      now - endOf(e, now) < PENDING_MS,
  )

/**
 * One read of system.query.history covering every event's window, by identity: no tag in
 * the statements themselves. `user` blank means the identity the MCP runs as.
 */
export const buildQuery = (events: readonly DbxEvent[], user: string, now: number): string | undefined => {
  const live = events.filter(e => e.status !== 'blocked')
  if (live.length === 0) return undefined
  const from = Math.min(...live.map(startOf)) - TEXT_SLACK_MS
  const to = Math.max(...live.map(e => endOf(e, now))) + TEXT_SLACK_MS
  const who = user.trim() === '' ? 'current_user()' : sqlString(user.trim())
  return [
    `/* ${ENRICH_MARK} */`,
    'SELECT statement_id, execution_status, total_duration_ms, read_bytes, produced_rows,',
    '       compute.warehouse_id AS warehouse_id, error_message, client_application,',
    '       unix_millis(start_time) AS start_ms, unix_millis(end_time) AS end_ms, statement_text',
    'FROM system.query.history',
    `WHERE executed_by = ${who}`,
    `  AND start_time BETWEEN timestamp_millis(${from}) AND timestamp_millis(${to})`,
    `  AND statement_text NOT LIKE '%${ENRICH_MARK}%'`,
    'ORDER BY start_time',
    'LIMIT 2000',
  ].join('\n')
}

// --- Reading the rows back, whatever shape the MCP answers in --------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const columnNames = (cols: unknown): string[] | undefined =>
  Array.isArray(cols) ? cols.map(c => (isObj(c) ? String(c.name ?? c.column_name ?? '') : String(c))) : undefined

/** Finds a table in a parsed result: an array of objects, or columns beside an array of arrays. */
/**
 * One row's cells: a plain array, or the DBSQL statement API's `{ values: [{ string_value }] }`
 * (a null cell is `{ null_value }` or `{}`). Anything else is not a row.
 */
const cellsOf = (row: unknown): unknown[] | undefined => {
  if (Array.isArray(row)) return row
  if (!isObj(row) || !Array.isArray(row.values)) return undefined
  return row.values.map(cell =>
    isObj(cell) ? (cell.string_value ?? cell.number_value ?? cell.bool_value ?? null) : cell,
  )
}

const findTable = (value: unknown, depth = 0): Obj[] | undefined => {
  if (depth > 6) return undefined
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isObj)) return value
    return undefined
  }
  if (!isObj(value)) return undefined
  const schema = isObj(value.manifest) && isObj(value.manifest.schema) ? value.manifest.schema.columns : undefined
  const names = columnNames(value.columns ?? schema)
  const data = isObj(value.result) ? value.result.data_array : (value.data_array ?? value.rows ?? value.data)
  const rows = Array.isArray(data) ? data.map(cellsOf) : undefined
  if (names !== undefined && rows !== undefined && rows.every(r => r !== undefined)) {
    return rows.map(row => Object.fromEntries(names.map((n, i) => [n, row![i]])))
  }
  for (const child of Object.values(value)) {
    const found = findTable(child, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v))

const toRow = (raw: Obj): DbxHistoryRow | undefined => {
  const lower = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]))
  const id = str(lower.statement_id)
  if (id === undefined) return undefined
  return {
    statement_id: id,
    execution_status: str(lower.execution_status),
    total_duration_ms: num(lower.total_duration_ms),
    read_bytes: num(lower.read_bytes),
    produced_rows: num(lower.produced_rows),
    warehouse_id: str(lower.warehouse_id),
    error_message: str(lower.error_message),
    client_application: str(lower.client_application),
    start_ms: num(lower.start_ms),
    end_ms: num(lower.end_ms),
    statement_text: str(lower.statement_text),
  }
}

export type McpLikeResult = { content?: readonly { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown }

/** History rows from an MCP result, or the reason none could be read. */
export const parseHistory = (result: McpLikeResult): { rows: DbxHistoryRow[] } | { error: string } => {
  const text = (result.content ?? [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
  if (result.isError === true) return { error: firstLine(text) || 'the query failed' }
  let table = findTable(result.structuredContent)
  if (table === undefined) {
    try {
      table = findTable(JSON.parse(text))
    } catch {
      table = undefined
    }
  }
  if (table === undefined) {
    if (/no rows|empty|\[\s*\]/i.test(text) || text.trim() === '') return { rows: [] }
    return { error: `could not read the history result: ${firstLine(text)}` }
  }
  return { rows: table.flatMap(r => toRow(r) ?? []) }
}

const firstLine = (text: string) => text.trim().split('\n')[0]?.slice(0, 300) ?? ''

// --- Tying rows to events -----------------------------------------------------------------

/**
 * Matches rows to events. A query matches by statement id, else by identical text started
 * inside its window; a script or CLI call claims every unclaimed statement inside its run.
 */
export const matchRows = (
  events: readonly DbxEvent[],
  rows: readonly DbxHistoryRow[],
  now: number,
): Record<string, { row: string; how: DbxMatch }[]> => {
  const matches: Record<string, { row: string; how: DbxMatch }[]> = {}
  const claimed = new Set<string>()
  const add = (event: DbxEvent, row: DbxHistoryRow, how: DbxMatch) => {
    claimed.add(row.statement_id)
    ;(matches[event.id] ??= []).push({ row: row.statement_id, how })
  }

  const queries = events.filter(e => e.event_type === 'query' && e.status !== 'blocked')
  for (const event of queries) {
    const byId = event.statement_id === undefined ? undefined : rows.find(r => r.statement_id === event.statement_id)
    if (byId !== undefined) add(event, byId, 'statement_id')
  }
  for (const event of queries) {
    if (matches[event.id] !== undefined || event.sql_text === undefined) continue
    const want = normalizeSql(event.sql_text)
    const from = startOf(event) - TEXT_SLACK_MS
    const to = endOf(event, now) + TEXT_SLACK_MS
    const candidates = rows.filter(
      r =>
        !claimed.has(r.statement_id) &&
        r.statement_text !== undefined &&
        normalizeSql(r.statement_text) === want &&
        (r.start_ms === undefined || (r.start_ms >= from && r.start_ms <= to)),
    )
    const nearest = candidates.sort(
      (a, b) => Math.abs((a.start_ms ?? 0) - startOf(event)) - Math.abs((b.start_ms ?? 0) - startOf(event)),
    )[0]
    if (nearest !== undefined) add(event, nearest, 'text')
  }
  for (const event of events.filter(e => e.event_type === 'script' || e.event_type === 'cli')) {
    const from = startOf(event) - WINDOW_SLACK_MS
    const to = endOf(event, now) + WINDOW_SLACK_MS
    for (const row of rows) {
      if (claimed.has(row.statement_id) || row.start_ms === undefined) continue
      if (row.start_ms >= from && row.start_ms <= to) add(event, row, 'window')
    }
  }
  return matches
}

/** Rows for one event, in start order. */
export const rowsFor = (enrichment: DbxEnrichment, eventId: string): (DbxHistoryRow & { how: DbxMatch })[] => {
  const byId = new Map(enrichment.rows.map(r => [r.statement_id, r]))
  return (enrichment.matches[eventId] ?? [])
    .flatMap(m => {
      const row = byId.get(m.row)
      return row === undefined ? [] : [{ ...row, how: m.how }]
    })
    .sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0))
}
