import type { DbtRunCounts, DbtRunStatus } from '../types'

// Subcommands worth recording; deps/clean/debug/init/parse are housekeeping.
const DBT_COMMAND =
  /(^|[\s;&|/(])dbt\s+(run|build|test|seed|snapshot|compile|show|source|ls|list|retry|clone|run-operation)(?=\s|$)/

// Marks a command this mod already wrapped, so a re-dispatch never double-wraps.
export const WRAP_MARK = '.claude/claude-modz/dbt-runs/'

export const isDbtCommand = (command: string): boolean =>
  DBT_COMMAND.test(command) && !command.includes(WRAP_MARK)

const quote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`

/**
 * Copies the command's combined output into `logPath` while passing it through
 * unchanged, records the real exit code in `rcPath`, and leaves that code as the
 * command's status (a pipe would otherwise report tee's). Works in bash and zsh.
 */
export const wrapCommand = (command: string, logPath: string, rcPath: string): string =>
  `{ (\n${command}\n) ; echo $? > ${quote(rcPath)} ; } 2>&1 | tee ${quote(logPath)} ; ( exit "$(cat ${quote(rcPath)} 2>/dev/null || echo 1)" )`

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

export const stripAnsi = (text: string): string =>
  text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n')

export const tailLines = (text: string, count: number): string =>
  text.replace(/\n+$/, '').split('\n').slice(-Math.max(1, count)).join('\n')

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
