import type { DbtRunCounts, DbtRunStatus } from '../types'

// Subcommands worth recording; deps/clean/debug/init/parse are housekeeping.
const SUBCOMMAND = '(?:run|build|test|seed|snapshot|compile|show|source|ls|list|retry|clone|run-operation)'

// A dbt executable in command position: after a separator, a keyword or `VAR=value` prefixes.
// Group 1 is everything before the executable, group 2 the executable (`dbt` or a path ending in it).
const DBT_CALL = new RegExp(
  String.raw`((?:^|[;&|({\n]|\b(?:then|do|else|time|exec)\s)[ \t]*(?:[A-Za-z_]\w*=\S*[ \t]+)*)` +
    String.raw`((?:[^\s;&|()<>]*\/)?dbt)(?=[ \t]+${SUBCOMMAND}(?:[\s;&|)]|$))`,
  'g',
)

// Marks a command this mod already wrapped, so a re-dispatch never double-wraps.
export const WRAP_MARK = '.claude/claude-modz/dbt-runs/'

// The shell function each dbt call is routed through.
export const TEE_FN = '__dbt_runs_tee'

/**
 * The command with heredoc bodies and quoted strings blanked to spaces (newlines kept), so
 * every offset still lines up with the original. Text written to a file or echoed is not a call.
 */
export const maskInert = (command: string): string => {
  const out = command.split('')
  const blank = (i: number) => {
    if (out[i] !== '\n') out[i] = ' '
  }
  const heredocs: { word: string; tabs: boolean }[] = []
  let i = 0
  while (i < command.length) {
    const c = command[i]
    if (c === '\\') {
      i += 2
    } else if (c === "'" || c === '"') {
      // Single quotes end at the next one; inside double quotes a backslash escapes.
      let end = i + 1
      while (end < command.length && command[end] !== c) end += c === '"' && command[end] === '\\' ? 2 : 1
      const stop = Math.min(end + 1, command.length)
      for (let j = i; j < stop; j++) blank(j)
      i = stop
    } else if (c === '<' && command.startsWith('<<', i) && command[i + 2] !== '<') {
      const m = command.slice(i).match(/^<<(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/)
      if (m === null) {
        i += 2
      } else {
        heredocs.push({ word: m[3], tabs: m[1] === '-' })
        i += m[0].length
      }
    } else if (c === '\n' && heredocs.length > 0) {
      // Bodies start on the line after their `<<WORD`, one after another.
      i += 1
      for (const { word, tabs } of heredocs.splice(0)) {
        while (i < command.length) {
          const eol = command.indexOf('\n', i)
          const end = eol === -1 ? command.length : eol
          const line = command.slice(i, end)
          for (let j = i; j < end; j++) blank(j)
          i = end + 1
          if ((tabs ? line.replace(/^\t+/, '') : line) === word) break
        }
      }
    } else {
      i += 1
    }
  }
  return out.join('')
}

/** Offsets in `command` where a dbt executable to record starts. */
export const dbtCallOffsets = (command: string): number[] =>
  [...maskInert(command).matchAll(DBT_CALL)].map(m => m.index + m[1].length)

export const isDbtCommand = (command: string): boolean =>
  !command.includes(WRAP_MARK) && dbtCallOffsets(command).length > 0

const quote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`

// Strips terminal escapes from each line as it streams, flushing every line.
const STRIP_ANSI = `perl -pe 'BEGIN { $| = 1 } s/\\e\\[[0-9;?]*[A-Za-z]//g'`

/** Where the wrapper records dbt's own exit code, beside the command's in `rcPath`. */
export const dbtRcPathOf = (rcPath: string): string => rcPath.replace(/\.rc$/, '') + '.dbt.rc'

/**
 * Routes each dbt call in `command` through a shell function that copies dbt's own output into
 * `logPath` before anything else in the command (a redirect, `| tail`, `| grep`) can filter it.
 * The function records the last failing dbt exit code (else 0) in the dbt rc file, and the
 * command's own exit code goes to `rcPath` and stays the command's status. Works in bash and zsh.
 *
 * dbt colors only a terminal, so each call runs with DBT_USE_COLORS=true: the log keeps
 * dbt's colors for the band, and the copy the rest of the command sees has them stripped,
 * line by line as it streams.
 */
export const wrapCommand = (command: string, logPath: string, rcPath: string): string => {
  const log = quote(logPath)
  const rc = quote(rcPath)
  const dbtRc = quote(dbtRcPathOf(rcPath))
  const step = quote(dbtRcPathOf(rcPath) + '.step')
  let routed = command
  for (const at of dbtCallOffsets(command).reverse()) {
    routed = `${routed.slice(0, at)}${TEE_FN} ${routed.slice(at)}`
  }
  const fn =
    `${TEE_FN}() { { DBT_USE_COLORS=true "$@"; echo $? > ${step} ; } 2>&1 | tee -a ${log} | ${STRIP_ANSI} ; ` +
    `__dbt_runs_last="$(cat ${step} 2>/dev/null || echo 1)" ; ` +
    `[ "$__dbt_runs_last" = 0 ] && [ -e ${dbtRc} ] || echo "$__dbt_runs_last" > ${dbtRc} ; ` +
    `return "$__dbt_runs_last" ; }`
  return `: > ${log} ; { (\n${fn}\n${routed}\n) ; echo $? > ${rc} ; } ; ( exit "$(cat ${rc} 2>/dev/null || echo 1)" )`
}

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
