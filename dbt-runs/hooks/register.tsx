import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DbtRun, DbtRunStatus, DbtRunsView } from '../types'
import {
  basename,
  deriveStatus,
  formatBytes,
  formatDuration,
  formatTime,
  isDbtCommand,
  newRunId,
  parseSummary,
  repoFromCommand,
  stripAnsi,
  tailLines,
  truncate,
  wrapCommand,
} from './dbt'

type $ = EngineInterface

const PANE = 'dbt-runs'
const TITLE = 'dbt runs'
const STORE_PREFIX = 'run:'
const STALE_MS = 3 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
// The pane scrolls; past this the full log is a `cat` away.
const LOG_TAIL_LINES = 500

const runs = atom({ plugin: 'dbt-runs', key: 'runs' } as const, [] as DbtRun[])
const view = atom({ plugin: 'dbt-runs', key: 'view' } as const, { kind: 'list' } as DbtRunsView)

const GLYPH: Record<DbtRunStatus, { glyph: string; color: string }> = {
  running: { glyph: '●', color: 'warning' },
  success: { glyph: '✓', color: 'success' },
  warn: { glyph: '⚠', color: 'warning' },
  error: { glyph: '✗', color: 'error' },
  cancelled: { glyph: '■', color: 'inactive' },
  unknown: { glyph: '?', color: 'inactive' },
}

const logDir = async ($: $) => `${(await $.env.get('HOME')) ?? '~'}/.claude/claude-modz/dbt-runs`

const byNewest = (list: readonly DbtRun[]) => [...list].sort((a, b) => b.startedAt - a.startedAt)

const isRun = (value: unknown): value is DbtRun =>
  typeof value === 'object' && value !== null && 'id' in value && 'logPath' in value

// Each run is its own store key, so sessions writing at once never clobber each other.
const saveRun = async ($: $, run: DbtRun) => {
  await $.store.set(STORE_PREFIX + run.id, run)
  await update($, runs, list => byNewest([...list.filter(r => r.id !== run.id), run]))
}

const syncFromStore = async ($: $) => {
  const keys = (await $.store.keys()).filter(k => k.startsWith(STORE_PREFIX))
  const all: DbtRun[] = []
  for (const key of keys) {
    const value = await $.store.get(key)
    if (isRun(value)) all.push(value)
  }
  const next = byNewest(all)
  const current = await read($, runs)
  if (JSON.stringify(current) !== JSON.stringify(next)) await update($, runs, () => next)
}

const readText = async ($: $, path: string) => {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

const statOf = async ($: $, path: string) => {
  try {
    return await $.fs.stat(path)
  } catch {
    return undefined
  }
}

/** Settles a run from its exit-code file and log; a no-op until the exit code exists. */
const finalize = async ($: $, run: DbtRun) => {
  const rc = await readText($, run.rcPath)
  if (rc === undefined) return false
  const exitCode = Number.parseInt(rc.trim(), 10)
  const log = stripAnsi((await readText($, run.logPath)) ?? '')
  const counts = parseSummary(log)
  const logStat = await statOf($, run.logPath)
  const rcStat = await statOf($, run.rcPath)
  await saveRun($, {
    ...run,
    exitCode: Number.isNaN(exitCode) ? undefined : exitCode,
    counts,
    status: deriveStatus(Number.isNaN(exitCode) ? undefined : exitCode, counts),
    finishedAt: rcStat?.mtimeMs ?? (await $.clock.now()),
    bytes: logStat?.size ?? run.bytes,
  })
  return true
}

/** Advances every running run: settles finished ones, grows sizes, gives up on abandoned ones. */
const tick = async ($: $) => {
  const now = await $.clock.now()
  for (const run of await read($, runs)) {
    if (run.status !== 'running') continue
    if (await finalize($, run)) continue
    const stat = await statOf($, run.logPath)
    if (stat === undefined || now - stat.mtimeMs > STALE_MS) {
      await saveRun($, { ...run, status: 'unknown', bytes: stat?.size ?? 0 })
    } else if (stat.size !== run.bytes) {
      await saveRun($, { ...run, bytes: stat.size })
    }
  }
}

const deleteRuns = async ($: $, ids: readonly string[]) => {
  if (ids.length === 0) return
  const list = await read($, runs)
  const doomed = list.filter(r => ids.includes(r.id))
  const paths = doomed.flatMap(r => [r.logPath, r.rcPath])
  if (paths.length > 0) await $.process.run(['rm', '-f', ...paths])
  for (const run of doomed) await $.store.delete(STORE_PREFIX + run.id)
  await update($, runs, all => all.filter(r => !ids.includes(r.id)))
  await update($, view, (v): DbtRunsView => (v.kind === 'detail' && ids.includes(v.id) ? { kind: 'list' } : v))
}

const clearFinished = async ($: $, olderThanMs?: number) => {
  const now = await $.clock.now()
  const list = await read($, runs)
  const ids = list
    .filter(r => r.status !== 'running')
    .filter(r => olderThanMs === undefined || now - r.startedAt > olderThanMs)
    .map(r => r.id)
  await deleteRuns($, ids)
  return ids.length
}

// Opened by the person it takes the keys; opened by a run starting it only shows.
const openPane = ($: $, focus?: true) => $.ui.open({ id: PANE, title: TITLE, ...(focus ? { focus } : {}) })

// The main screen reports no clicks and opens panes inline, so a run only pops the
// pane open unasked where the terminal docks it beside the transcript.
let isDocked = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dbt-runs',
      description: 'Open the dbt runs pane (args: clear | clear-week)',
      argumentHint: '[clear|clear-week]',
    })
    await syncFromStore($)
    let beats = 0
    $.clock.every(2000, () => {
      beats += 1
      void (async () => {
        // Other sessions add runs too; pick them up every ~10s.
        if (beats % 5 === 0) await syncFromStore($)
        await tick($)
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'dbt-runs' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') return { text: `Deleted ${await clearFinished($)} finished dbt runs.` }
    if (arg === 'clear-week') {
      return { text: `Deleted ${await clearFinished($, WEEK_MS)} dbt runs older than 7 days.` }
    }
    await update($, view, (): DbtRunsView => ({ kind: 'list' }))
    await openPane($, true)

    return { text: 'dbt runs pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isDbtCommand(e.command)) return next(e)

    const dir = await logDir($)
    await $.process.run(['mkdir', '-p', dir])
    const startedAt = await $.clock.now()
    const id = newRunId(startedAt)
    const run: DbtRun = {
      id,
      startedAt,
      command: e.command,
      repo: repoFromCommand(e.command) ?? basename(await $.session.cwd()),
      sessionId: await $.session.id(),
      logPath: `${dir}/${id}.log`,
      rcPath: `${dir}/${id}.rc`,
      status: 'running',
      bytes: 0,
    }
    await saveRun($, run)
    const panes = await $.ui.panes()
    if (isDocked && !panes.some(p => p.id === PANE)) void openPane($)

    const ran = await next({ ...e, command: wrapCommand(e.command, run.logPath, run.rcPath) })
    if (ran.deny !== undefined) {
      await saveRun($, { ...run, status: 'cancelled', finishedAt: await $.clock.now() })
    } else {
      // A backgrounded command has no exit code yet; the timer settles it later.
      await finalize($, run)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const list = await read($, runs)
    const current = await read($, view)
    const now = await $.clock.now()
    const setView = (v: DbtRunsView) => () => void update($, view, () => v)
    isDocked = e.viewport?.isFullscreen === true
    const hint = (keys: string) => (
      <Text dimColor>{e.props.isFocused ? keys : 'ctrl+x tab to focus this pane'}</Text>
    )

    const detail = current.kind === 'detail' ? list.find(r => r.id === current.id) : undefined
    if (detail !== undefined) {
      const { glyph, color } = GLYPH[detail.status]
      const elapsed = (detail.finishedAt ?? now) - detail.startedAt
      const log = stripAnsi((await readText($, detail.logPath)) ?? '')
      const c = detail.counts
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="back" hotkey="b" autoFocus onPress={setView({ kind: 'list' })}>
              Back
            </Button>
            {detail.status !== 'running' && (
              <Button key="delete" hotkey="d" onPress={() => void deleteRuns($, [detail.id])}>
                Delete
              </Button>
            )}
          </Box>
          <Text>
            <Text color={color}>{glyph} </Text>
            <Text bold>{detail.status}</Text>
            <Text dimColor>
              {' '}
              · {detail.repo} · {formatTime(detail.startedAt, now)} · {formatDuration(elapsed)} ·{' '}
              {formatBytes(detail.bytes)}
              {detail.exitCode !== undefined ? ` · exit ${detail.exitCode}` : ''}
            </Text>
          </Text>
          {c !== undefined && (
            <Text>
              <Text color="success">PASS={c.pass} </Text>
              <Text color="warning">WARN={c.warn} </Text>
              <Text color="error">ERROR={c.error} </Text>
              <Text dimColor>
                SKIP={c.skip} TOTAL={c.total}
              </Text>
            </Text>
          )}
          {hint(detail.status === 'running' ? 'b back · Esc close' : 'b back · d delete · Esc close')}
          <Text dimColor wrap="wrap">
            $ {detail.command}
          </Text>
          <Code source={log.length > 0 ? tailLines(log, LOG_TAIL_LINES) : '(no output yet)'} />
        </Box>
      )
    }

    const totalBytes = list.reduce((sum, r) => sum + r.bytes, 0)
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{list.length} runs</Text>
          <Text dimColor> · {formatBytes(totalBytes)} on disk</Text>
        </Text>
        {list.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Button key="clear-finished" hotkey="c" dimColor onPress={() => void clearFinished($)}>
              Clear finished
            </Button>
            <Button key="clear-week" hotkey="w" dimColor onPress={() => void clearFinished($, WEEK_MS)}>
              Clear &gt;7d
            </Button>
          </Box>
        )}
        {list.length > 0 && hint('1-9 open · ↑↓ move · Enter open · c clear finished · w clear >7d · Esc close')}
        {list.length === 0 && <Text dimColor>No dbt runs yet. They appear here as Claude runs them.</Text>}
        {list.map((run, i) => {
          const { glyph, color } = GLYPH[run.status]
          const elapsed = (run.finishedAt ?? now) - run.startedAt
          const head = `${formatTime(run.startedAt, now)}  ${run.repo}  `
          const cmd = run.command.replace(/^.*?(?=\S*dbt\s)/s, '').replace(/\s+/g, ' ')
          const c = run.counts
          return (
            <Box key={`row-${run.id}`} flexDirection="column">
              <Box flexDirection="row">
                <Text color={color}>{glyph} </Text>
                <Button
                  key={`open-${run.id}`}
                  plain
                  {...(i < 9 ? { hotkey: String(i + 1) } : {})}
                  {...(i === 0 ? { autoFocus: true as const } : {})}
                  onPress={setView({ kind: 'detail', id: run.id })}
                  label={truncate(head + cmd, width - (i < 9 ? 5 : 2))}
                />
              </Box>
              <Text dimColor>
                {'  '}
                {formatDuration(elapsed)} · {formatBytes(run.bytes)}
                {c !== undefined ? ` · ${c.pass}✓ ${c.warn}⚠ ${c.error}✗ ${c.skip}↷` : ''}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
