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
  logWindow,
  newRunId,
  parseAnsiLine,
  parseSummary,
  repoFromCommand,
  stripAnsi,
  truncate,
  wrapCommand,
} from './dbt'

type $ = EngineInterface

const STORE_PREFIX = 'run:'
const STALE_MS = 3 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

const runs = atom({ plugin: 'dbt-runs', key: 'runs' } as const, [] as DbtRun[])
const view = atom({ plugin: 'dbt-runs', key: 'view' } as const, { kind: 'list' } as DbtRunsView)
// Whether the band above the prompt shows; runs are kept either way.
const isShown = atom({ plugin: 'dbt-runs', key: 'isShown' } as const, false)
// The band scrolls a tall tree with the wheel itself; past this many lines the head is left out.
const LOG_MAX_LINES = 1000
const LOG_END_KEY = 'log-end'

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

const show = ($: $) => update($, isShown, () => true)
// The person's collapse ([-], ctrl+x ctrl+a) belongs to the engine and no call expands it; clearing
// the band for a moment before drawing it again is meant to bring it back open.
const reopen = async ($: $) => {
  await update($, isShown, () => false)
  await $.clock.sleep(150)
  await show($)
}
// Hides the band only: every run stays stored, and /dbt-runs or the next run brings it back.
const minimize = ($: $) => () => void update($, isShown, () => false)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dbt-runs',
      description: 'Show the dbt runs band (args: clear | clear-week)',
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
    await reopen($)

    return { text: 'dbt runs shown above the prompt.' }
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
    await show($)

    const ran = await next({ ...e, command: wrapCommand(e.command, run.logPath, run.rcPath) })
    if (ran.deny !== undefined) {
      await saveRun($, { ...run, status: 'cancelled', finishedAt: await $.clock.now() })
    } else {
      // A backgrounded command has no exit code yet; the timer settles it later.
      await finalize($, run)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // The band above the prompt sits at the bottom in every layout, where a pane docks to the side in fullscreen.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isShown))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const list = await read($, runs)
    const current = await read($, view)
    const now = await $.clock.now()
    const setView = (v: DbtRunsView) => () =>
      void (async () => {
        await update($, view, () => v)
        // A run opens at the end of its output; the next draw has to land before the scroll can.
        if (v.kind === 'detail') {
          $.clock.after(100, () => void $.ui.scroll({ in: e.requestId, to: 'end' }).catch(() => undefined))
        }
      })()
    // Letter hotkeys only: a band's digit hotkeys would answer digits typed into an empty prompt.
    const hint = (keys: string) => <Text dimColor>ctrl+x tab to focus · {keys}</Text>

    const detail = current.kind === 'detail' ? list.find(r => r.id === current.id) : undefined
    if (detail !== undefined) {
      const { glyph, color } = GLYPH[detail.status]
      const elapsed = (detail.finishedAt ?? now) - detail.startedAt
      // The log keeps dbt's colors; lone carriage returns (progress redraws) become line breaks.
      const log = ((await readText($, detail.logPath)) ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      const c = detail.counts
      const win = logWindow(log, LOG_MAX_LINES, 0)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
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
            <Button key="back" hotkey="b" autoFocus onPress={setView({ kind: 'list' })}>
              Back
            </Button>
            {detail.status !== 'running' && (
              <Button key="delete" hotkey="d" onPress={() => void deleteRuns($, [detail.id])}>
                Delete
              </Button>
            )}
            <Button key="minimize" hotkey="m" dimColor onPress={minimize($)}>
              Minimize
            </Button>
          </Box>
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
          <Text dimColor wrap="truncate-end">
            $ {detail.command.replace(/\s+/g, ' ')}
          </Text>
          {hint(`scroll for more · b back${detail.status === 'running' ? '' : ' · d delete'} · m minimize`)}
          {win.first > 1 && <Text dimColor>… first {win.first - 1} lines left out (full log: {detail.logPath})</Text>}
          {log.length === 0 && <Text dimColor>(no output yet)</Text>}
          {log.length > 0 &&
            win.source.split('\n').map(line => (
              <Text>
                {line.length === 0
                  ? ' '
                  : parseAnsiLine(line).map(span => (
                      <Text
                        {...(span.color !== undefined ? { color: span.color } : {})}
                        {...(span.bold ? { bold: true } : {})}
                        {...(span.dimColor ? { dimColor: true } : {})}
                      >
                        {span.text}
                      </Text>
                    ))}
              </Text>
            ))}
          <Box key={LOG_END_KEY}>
            <Text dimColor>
              {detail.status === 'running' ? '● still running…' : `— end of output · ${win.total} lines —`}
            </Text>
          </Box>
        </Box>
      )
    }

    const totalBytes = list.reduce((sum, r) => sum + r.bytes, 0)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text>
            <Text bold>dbt runs</Text>
            <Text dimColor>
              {' '}
              · {list.length} · {formatBytes(totalBytes)} on disk
            </Text>
          </Text>
          {list.length > 0 && (
            <Button key="clear-finished" hotkey="c" dimColor onPress={() => void clearFinished($)}>
              Clear finished
            </Button>
          )}
          {list.length > 0 && (
            <Button key="clear-week" hotkey="w" dimColor onPress={() => void clearFinished($, WEEK_MS)}>
              Clear &gt;7d
            </Button>
          )}
          <Button key="minimize" hotkey="m" dimColor onPress={minimize($)}>
            Minimize
          </Button>
        </Box>
        {list.length === 0 && <Text dimColor>No dbt runs yet. They appear here as Claude runs them.</Text>}
        {list.map((run, i) => {
          const { glyph, color } = GLYPH[run.status]
          const elapsed = (run.finishedAt ?? now) - run.startedAt
          const time = formatTime(run.startedAt, now)
          const cmd = run.command.replace(/^.*?(?=\S*dbt\s)/s, '').replace(/\s+/g, ' ')
          const c = run.counts
          const stats = `${formatDuration(elapsed)} · ${formatBytes(run.bytes)}${
            c !== undefined ? ` · ${c.pass}✓ ${c.warn}⚠ ${c.error}✗ ${c.skip}↷` : ''
          }`
          return (
            <Box key={`row-${run.id}`} flexDirection="row">
              <Text color={color}>{glyph} </Text>
              <Button
                key={`open-${run.id}`}
                plain
                {...(i === 0 ? { autoFocus: true as const } : {})}
                onPress={setView({ kind: 'detail', id: run.id })}
                label={truncate(`${time}  ${run.repo}  ${cmd}`, Math.max(10, width - stats.length - 4))}
              />
              <Text dimColor> {stats}</Text>
            </Box>
          )
        })}
        {list.length > 0 && hint('↑↓ move · Enter open · c clear finished · w clear >7d · m minimize')}
      </Box>
    )
  })
}
