// SQL text helpers: table extraction for the tables-touched graph, catalog classes, previews.
// A regex reader, not a parser: good for the statements Claude writes, best effort beyond.

export type CatalogClass = 'prod' | 'dev' | 'other'

export const splitList = (value: string): string[] =>
  value
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0)

/** Blanks out comments and string literals so keywords inside them are not read as SQL. */
export const stripNoise = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')

// A dotted name of 1-3 parts, each bare or backticked.
const PART = '(?:`[^`]+`|[A-Za-z_][\\w$]*)'
const NAME = `(${PART}(?:\\s*\\.\\s*${PART}){0,2})`

const normalizeName = (raw: string): string =>
  raw
    .split('.')
    .map(p => p.trim().replace(/^`|`$/g, ''))
    .join('.')
    .toLowerCase()

const READ = new RegExp(`\\b(?:from|join|using)\\s+${NAME}`, 'gi')
const WRITE = [
  new RegExp(`\\binsert\\s+(?:into|overwrite)\\s+(?:table\\s+)?${NAME}`, 'gi'),
  new RegExp(`\\bmerge\\s+into\\s+${NAME}`, 'gi'),
  new RegExp(`\\bupdate\\s+${NAME}\\s+set\\b`, 'gi'),
  new RegExp(`\\bdelete\\s+from\\s+${NAME}`, 'gi'),
  new RegExp(
    `\\bcreate\\s+(?:or\\s+replace\\s+)?(?:temp(?:orary)?\\s+)?(?:streaming\\s+)?(?:table|view|materialized\\s+view)\\s+(?:if\\s+not\\s+exists\\s+)?${NAME}`,
    'gi',
  ),
  new RegExp(`\\bcopy\\s+into\\s+${NAME}`, 'gi'),
  new RegExp(`\\btruncate\\s+table\\s+${NAME}`, 'gi'),
  new RegExp(`\\balter\\s+(?:table|view)\\s+${NAME}`, 'gi'),
  new RegExp(`\\bdrop\\s+(?:table|view|materialized\\s+view)\\s+(?:if\\s+exists\\s+)?${NAME}`, 'gi'),
  new RegExp(`\\boptimize\\s+${NAME}`, 'gi'),
]
// Words a FROM/JOIN can be followed by that are not tables.
const NOT_TABLES = new Set(['select', 'lateral', 'values', 'unnest', 'explode', 'json_table', 'read_files', 'range'])

const cteNames = (sql: string): Set<string> => {
  const names = new Set<string>()
  // A WITH can open the statement or follow CREATE ... AS / INSERT ...; each CTE is `name AS (`.
  if (!/\bwith\b/i.test(sql)) return names
  for (const m of sql.matchAll(/(?:\bwith|,)\s*(?:recursive\s+)?(`[^`]+`|[A-Za-z_]\w*)\s*(?:\([^)]*\))?\s+as\s*\(/gi)) {
    names.add(normalizeName(m[1]!))
  }
  return names
}

export type Tables = { read: string[]; written: string[] }

/** Tables a statement (or a script of statements) reads and writes, lowercased, CTEs left out. */
export const extractTables = (sql: string): Tables => {
  const clean = stripNoise(sql)
  const ctes = cteNames(clean)
  const written = new Set<string>()
  for (const re of WRITE) for (const m of clean.matchAll(re)) written.add(normalizeName(m[1]!))
  const read = new Set<string>()
  // `DELETE FROM t` writes t; drop its FROM so the read scan does not count t as read.
  for (const m of clean.replace(/\bdelete\s+from\b/gi, 'delete ').matchAll(READ)) {
    const name = normalizeName(m[1]!)
    if (!NOT_TABLES.has(name) && !ctes.has(name)) read.add(name)
  }
  for (const name of ctes) written.delete(name)
  return { read: [...read].sort(), written: [...written].sort() }
}

export const catalogOf = (table: string): string | undefined => {
  const parts = table.split('.')
  return parts.length === 3 ? parts[0] : undefined
}

export const classify = (table: string, prod: readonly string[], dev: readonly string[]): CatalogClass => {
  const catalog = catalogOf(table)
  if (catalog !== undefined && prod.includes(catalog)) return 'prod'
  if (catalog !== undefined && dev.includes(catalog)) return 'dev'
  return 'other'
}

/** One-line preview: comments dropped, whitespace collapsed, cut to `width`. */
export const preview = (sql: string, width: number): string => {
  const flat = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(1, width - 1))}…`
}

/** Text compared across client and server: comments kept out, whitespace collapsed, case folded, trailing `;` dropped. */
export const normalizeSql = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim()
    .toLowerCase()

/** A SQL string literal. */
export const sqlString = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
