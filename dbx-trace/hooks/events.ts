import type { DbxEvent } from '../types'

// --- Where a session's trace lives --------------------------------------------------------

export const traceDir = (cwd: string): string => `${cwd.replace(/[\\/]+$/, '')}/.claude/dbx-trace`
export const tracePaths = (cwd: string, sessionId: string) => {
  const dir = traceDir(cwd)
  return {
    dir,
    gitignore: `${dir}/.gitignore`,
    events: `${dir}/${sessionId}.jsonl`,
    enrichment: `${dir}/${sessionId}.enrich.json`,
    page: `${dir}/${sessionId}.html`,
    reports: `${dir}/${sessionId}.reports.json`,
  }
}

/** The JSONL is append-only; a call's later line supersedes its earlier one. Order is first appearance. */
export const latestPerId = (jsonl: string): DbxEvent[] => {
  const byId = new Map<string, DbxEvent>()
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    try {
      const event = JSON.parse(line) as DbxEvent
      if (typeof event.id === 'string') byId.set(event.id, event)
    } catch {
      // A torn last line from a crash: skip it.
    }
  }
  return [...byId.values()]
}

// --- Which tool calls are Databricks --------------------------------------------------------

/** `mcp__<server>__<tool>` split at its first `__` after the prefix. */
export const splitMcpName = (name: string): { server: string; tool: string } | undefined => {
  const m = name.match(/^mcp__(.+?)__(.+)$/)
  return m === null ? undefined : { server: m[1]!, tool: m[2]! }
}

export const sqlArgOf = (
  input: Record<string, unknown>,
  names: readonly string[],
): { arg: string; sql: string } | undefined => {
  for (const arg of names) {
    const value = input[arg]
    if (typeof value === 'string' && value.trim() !== '') return { arg, sql: value }
  }
  return undefined
}

/** Non-SQL arguments worth keeping and reusing for enrichment: warehouse, catalog, schema. */
export const keptArgs = (input: Record<string, unknown>): Record<string, string | number | boolean> => {
  const kept: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!/warehouse|catalog|schema/i.test(key)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') kept[key] = value
  }
  return kept
}

const PY_SCRIPT =
  /(?:^|[\s;&|(])(?:python(?:3(?:\.\d+)?)?|uv\s+run(?:\s+python3?)?|poetry\s+run\s+python3?|pipenv\s+run\s+python3?)\s+(?:-[A-Za-z]+\s+)*(["']?)([^\s;&|"']+\.py)\1/g
// The databricks CLI at a command position, not the word in an argument (`grep databricks x`).
const DBX_CLI = /(?:^|[;&|(]\s*|\n\s*)databricks\s+[a-z]/
const DBX_IMPORT = /^\s*(?:from|import)\s+databricks\b/m
// Inline code (`-c '...'`, a heredoc) has its import after a quote or a separator.
const DBX_IMPORT_INLINE = /(?:^|[\s'";])(?:from|import)\s+databricks\b/

export const scriptPaths = (command: string): string[] => [...command.matchAll(PY_SCRIPT)].map(m => m[2]!)

const isAbsolute = (path: string) => /^(?:\/|~|[A-Za-z]:[\\/])/.test(path)

/** The folder a command's scripts resolve against: its last `cd`, else the session's. */
export const commandDir = (command: string, cwd: string, home: string | undefined): string => {
  const dirs = [...command.matchAll(/(?:^|[\s;&|(])cd\s+(["']?)([^\s;&|"')]+)\1/g)]
  const dir = dirs.at(-1)?.[2]
  if (dir === undefined) return cwd
  const expanded = dir.startsWith('~') && home !== undefined ? home + dir.slice(1) : dir
  return isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`
}

export const resolvePath = (path: string, dir: string, home: string | undefined): string => {
  const expanded = path.startsWith('~') && home !== undefined ? home + path.slice(1) : path
  return isAbsolute(expanded) ? expanded : `${dir}/${expanded}`
}

/**
 * What a Bash command is on the Databricks side: `cli` for the databricks CLI, `script` for
 * Python whose source (a script file, `-c`, a heredoc) imports databricks, else undefined.
 */
export const classifyBash = async (
  command: string,
  readScript: (path: string) => Promise<string | undefined>,
): Promise<'script' | 'cli' | undefined> => {
  if (DBX_CLI.test(command)) return 'cli'
  if (!/\bpython|\buv\s+run|\bpoetry\s+run|\bpipenv\s+run/.test(command)) return undefined
  if (DBX_IMPORT_INLINE.test(command)) return 'script'
  for (const path of scriptPaths(command)) {
    const source = await readScript(path)
    if (source !== undefined && DBX_IMPORT.test(source)) return 'script'
  }
  return undefined
}

// --- What a Databricks result says (counts and ids only, never values) ------------------

export type ResultFacts = { statementId?: string; warehouseId?: string; rowCount?: number }

const ID_KEYS = ['statement_id', 'statementId', 'query_id', 'queryId']
const WAREHOUSE_KEYS = ['warehouse_id', 'warehouseId']
const COUNT_KEYS = ['row_count', 'rowCount', 'total_row_count', 'totalRowCount', 'num_rows', 'numRows']
const ROW_ARRAYS = ['data_array', 'dataArray', 'rows', 'data', 'results']

const walk = (value: unknown, facts: ResultFacts, depth: number) => {
  if (depth > 6 || typeof value !== 'object' || value === null) return
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) walk(item, facts, depth + 1)
    return
  }
  const obj = value as Record<string, unknown>
  for (const key of ID_KEYS) {
    if (facts.statementId === undefined && typeof obj[key] === 'string') facts.statementId = obj[key]
  }
  for (const key of WAREHOUSE_KEYS) {
    if (facts.warehouseId === undefined && typeof obj[key] === 'string') facts.warehouseId = obj[key]
  }
  for (const key of COUNT_KEYS) {
    const n = Number(obj[key])
    if (facts.rowCount === undefined && obj[key] !== undefined && Number.isFinite(n)) facts.rowCount = n
  }
  if (facts.rowCount === undefined) {
    for (const key of ROW_ARRAYS) {
      const rows = obj[key]
      if (Array.isArray(rows) && rows.every(r => typeof r === 'object' && r !== null)) {
        facts.rowCount = rows.length
        break
      }
    }
  }
  for (const child of Object.values(obj)) walk(child, facts, depth + 1)
}

/** Ids and a row count from a tool's result text (JSON or prose); the values themselves are never kept. */
export const resultFacts = (text: string | undefined): ResultFacts => {
  const facts: ResultFacts = {}
  if (text === undefined) return facts
  const trimmed = text.trim()
  if (/^[[{]/.test(trimmed)) {
    try {
      walk(JSON.parse(trimmed), facts, 0)
    } catch {
      // Not JSON after all.
    }
  }
  facts.statementId ??= text.match(/statement[_ ]?id["'\s:=]+([0-9a-f]{8}-[0-9a-f-]{20,})/i)?.[1]
  facts.warehouseId ??= text.match(/warehouse[_ ]?id["'\s:=]+([0-9a-f]{12,})/i)?.[1]
  return facts
}

// --- Formatting (from dbt-runs) ------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')

export const formatTime = (ms: number, now: number): string => {
  const d = new Date(ms)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return sameDay ? time : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`
}

export const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined) return '–'
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${pad(Math.round(s % 60))}s`
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`
}

export const formatBytes = (bytes: number | undefined): string => {
  if (bytes === undefined) return '–'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export const truncate = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
