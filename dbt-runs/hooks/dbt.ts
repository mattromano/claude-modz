import type { DbtRunCounts, DbtRunStatus } from '../types'

// Subcommands worth recording; deps/clean/debug/init/parse are housekeeping.
const DBT_COMMAND =
  /(^|[\s;&|/(])dbt\s+(run|build|test|seed|snapshot|compile|show|source|ls|list|retry|clone|run-operation)(?=\s|$)/

// Marks a command this mod already wrapped, so a re-dispatch never double-wraps.
export const WRAP_MARK = '.claude/claude-modz/dbt-runs/'

export const isDbtCommand = (command: string): boolean =>
  DBT_COMMAND.test(command) && !command.includes(WRAP_MARK)

const quote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`

// Strips terminal escapes from each line as it streams, flushing every line.
const STRIP_ANSI = `perl -pe 'BEGIN { $| = 1 } s/\\e\\[[0-9;?]*[A-Za-z]//g'`

/**
 * Copies the command's combined output into `logPath`, records the real exit code in
 * `rcPath`, and leaves that code as the command's status (a pipe would otherwise report
 * the last stage's). Works in bash and zsh.
 *
 * dbt colors only a terminal, so the command runs with DBT_USE_COLORS=true: the log
 * keeps dbt's colors for the band, and the copy Claude reads has them stripped, line
 * by line as it streams.
 */
export const wrapCommand = (command: string, logPath: string, rcPath: string): string =>
  `{ (\nexport DBT_USE_COLORS=true\n${command}\n) ; echo $? > ${quote(rcPath)} ; } 2>&1 | tee ${quote(logPath)} | ${STRIP_ANSI} ; ( exit "$(cat ${quote(rcPath)} 2>/dev/null || echo 1)" )`

export const basename = (path: string): string =>
  path.replace(/\/+$/, '').split('/').pop() || path

/** The repo a command runs in, from its last `cd <dir>`, if it has one. */
export const repoFromCommand = (command: string): string | undefined => {
  const dirs = [...command.matchAll(/(?:^|[\s;&|(])cd\s+(["']?)([^\s;&|"')]+)\1/g)]
  const dir = dirs.at(-1)?.[2]
  return dir === undefined ? undefined : basename(dir)
}

/** The counts on dbt's closing `Done. PASS=… TOTAL=…` line. */
export const parseSummary = (text: string): DbtRunCounts | undefined => {
  const line = text
    .split('\n')
    .reverse()
    .find(l => /\bDone\.\s.*\bTOTAL=\d+/.test(l))
  if (line === undefined) return undefined
  const n = (name: string) => Number(line.match(new RegExp(`\\b${name}=(\\d+)`))?.[1] ?? 0)
  return { pass: n('PASS'), warn: n('WARN'), error: n('ERROR'), skip: n('SKIP'), total: n('TOTAL') }
}

export const deriveStatus = (
  exitCode: number | undefined,
  counts: DbtRunCounts | undefined,
): DbtRunStatus => {
  if (exitCode === undefined) return 'unknown'
  if (exitCode === 130 || exitCode === 143) return 'cancelled'
  if (exitCode !== 0 || (counts?.error ?? 0) > 0) return 'error'
  if ((counts?.warn ?? 0) > 0) return 'warn'
  return 'success'
}

export type AnsiSpan = { text: string; color?: string; bold?: boolean; dimColor?: boolean }

// SGR foreground codes to the session theme's colors where it has one, else the terminal's names.
const ANSI_COLOR: Record<number, string> = {
  30: 'black', 31: 'error', 32: 'success', 33: 'warning', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
  90: 'gray', 91: 'redBright', 92: 'greenBright', 93: 'yellowBright', 94: 'blueBright', 95: 'magentaBright',
  96: 'cyanBright', 97: 'whiteBright',
}

/** One line's text split where its SGR escapes change the style; other escapes are dropped. */
export const parseAnsiLine = (line: string): AnsiSpan[] => {
  const spans: AnsiSpan[] = []
  let style: Omit<AnsiSpan, 'text'> = {}
  let at = 0
  const push = (text: string) => {
    if (text.length > 0) spans.push({ text, ...style })
  }
  for (const m of line.matchAll(/\u001b\[([0-9;?]*)([A-Za-z])/g)) {
    push(line.slice(at, m.index))
    at = m.index + m[0].length
    if (m[2] !== 'm') continue
    for (const code of (m[1] || '0').split(';').map(Number)) {
      if (code === 0) style = {}
      else if (code === 1) style = { ...style, bold: true }
      else if (code === 2) style = { ...style, dimColor: true }
      else if (code === 22) style = { ...style, bold: false, dimColor: false }
      else if (code === 39) style = { ...style, color: undefined }
      else if (ANSI_COLOR[code] !== undefined) style = { ...style, color: ANSI_COLOR[code] }
    }
  }
  push(line.slice(at))
  return spans
}

export const stripAnsi = (text: string): string =>
  text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n')

/**
 * The `size` lines of a log ending at line `end` (1-based), or at its last line while `end` is 0,
 * which is how a live run is followed. A fixed `end` stays put as a running log grows.
 */
export const logWindow = (text: string, size: number, end: number) => {
  const all = text.replace(/\n+$/, '').split('\n')
  const rows = Math.max(1, size)
  const last = end <= 0 ? all.length : Math.min(Math.max(end, Math.min(rows, all.length)), all.length)
  const first = Math.max(1, last - rows + 1)
  return {
    source: all.slice(first - 1, last).join('\n'),
    first,
    last,
    total: all.length,
    isAtTop: first === 1,
    isAtEnd: last === all.length,
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

export const newRunId = (now: number): string => {
  const d = new Date(now)
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${stamp}-${crypto.randomUUID().slice(0, 6)}`
}

export const formatTime = (ms: number, now: number): string => {
  const d = new Date(ms)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return sameDay ? time : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`
}

export const formatDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${pad(s % 60)}s`
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const truncate = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
