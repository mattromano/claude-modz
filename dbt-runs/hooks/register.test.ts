import type { RenderElement } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { deriveStatus, isDbtCommand, logWindow, parseAnsiLine, parseSummary, repoFromCommand, wrapCommand } from './dbt'

describe('detection', () => {
  test('records dbt work commands', async () => {
    expect(isDbtCommand('./dbt-env/bin/dbt run -m silver__x')).toBe(true)
    expect(isDbtCommand('cd ~/Desktop/repos/ethereum-models && ./dbt-env/bin/dbt build -s +x')).toBe(true)
    expect(isDbtCommand('dbt test --select y')).toBe(true)
    expect(isDbtCommand('dbt run-operation foo')).toBe(true)
  })

  test('ignores housekeeping and non-dbt commands', async () => {
    expect(isDbtCommand('dbt deps')).toBe(false)
    expect(isDbtCommand('rm package-lock.yml && dbt clean && dbt deps')).toBe(false)
    expect(isDbtCommand('grep -r dbt run.txt')).toBe(false)
    expect(isDbtCommand('ls models/dbt_run')).toBe(false)
  })

  test('never wraps a command twice', async () => {
    const wrapped = wrapCommand('dbt run', '/h/.claude/claude-modz/dbt-runs/a.log', '/h/.claude/claude-modz/dbt-runs/a.rc')
    expect(isDbtCommand(wrapped)).toBe(false)
  })
})

describe('parsing', () => {
  test('repo comes from the last cd', async () => {
    expect(repoFromCommand('cd ~/Desktop/repos/ethereum-models && dbt run')).toBe('ethereum-models')
    expect(repoFromCommand('cd "/a/b/base-models/" && dbt run')).toBe('base-models')
    expect(repoFromCommand('dbt run')).toBeUndefined()
  })

  test('summary line with and without NO-OP', async () => {
    const log = '12:00:01  Finished running 3 models\n12:00:01  Done. PASS=2 WARN=1 ERROR=0 SKIP=0 NO-OP=0 TOTAL=3\n'
    expect(parseSummary(log)).toEqual({ pass: 2, warn: 1, error: 0, skip: 0, total: 3 })
    expect(parseSummary('Done. PASS=1 WARN=0 ERROR=1 SKIP=4 TOTAL=6')).toEqual({ pass: 1, warn: 0, error: 1, skip: 4, total: 6 })
    expect(parseSummary('Compilation Error in model x')).toBeUndefined()
  })

  test('status from exit code and counts', async () => {
    expect(deriveStatus(0, { pass: 3, warn: 0, error: 0, skip: 0, total: 3 })).toBe('success')
    expect(deriveStatus(0, { pass: 2, warn: 1, error: 0, skip: 0, total: 3 })).toBe('warn')
    expect(deriveStatus(1, undefined)).toBe('error')
    expect(deriveStatus(130, undefined)).toBe('cancelled')
    expect(deriveStatus(undefined, undefined)).toBe('unknown')
  })
})

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

describe('colors', () => {
  test('SGR escapes become styled spans', async () => {
    const line = '1 of 2 OK created model x ... [\u001b[32mSUCCESS 1\u001b[0m in 2.0s]'
    expect(parseAnsiLine(line)).toEqual([
      { text: '1 of 2 OK created model x ... [' },
      { text: 'SUCCESS 1', color: 'success' },
      { text: ' in 2.0s]' },
    ])
    expect(parseAnsiLine('\u001b[1;31mERROR\u001b[22m!\u001b[39m ok')).toEqual([
      { text: 'ERROR', color: 'error', bold: true },
      { text: '!', color: 'error', bold: false, dimColor: false },
      { text: ' ok', bold: false, dimColor: false },
    ])
    expect(parseAnsiLine('plain')).toEqual([{ text: 'plain' }])
  })

  test('the wrapper turns dbt colors on and strips them from what Claude reads', async () => {
    const wrapped = wrapCommand('dbt run', '/l.log', '/l.rc')
    expect(wrapped).toContain('export DBT_USE_COLORS=true')
    expect(wrapped).toContain("| tee '/l.log' | perl -pe")
  })
})

describe('log window', () => {
  const log = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

  test('0 follows the end', async () => {
    const w = logWindow(log, 10, 0)
    expect([w.first, w.last, w.total, w.isAtEnd, w.isAtTop]).toEqual([21, 30, 30, true, false])
    expect(w.source.split('\n')[0]).toBe('line 21')
  })

  test('a fixed end stays put as the log grows', async () => {
    const grown = log + 'line 31\nline 32\n'
    expect(logWindow(grown, 10, 15).last).toBe(15)
  })

  test('clamps to the top and to the end', async () => {
    expect(logWindow(log, 10, 3)).toMatchObject({ first: 1, last: 10, isAtTop: true })
    expect(logWindow(log, 10, 99)).toMatchObject({ last: 30, isAtEnd: true })
    expect(logWindow('one\ntwo', 10, 0)).toMatchObject({ first: 1, last: 2, isAtTop: true, isAtEnd: true })
  })
})

test('a dbt Bash call is wrapped, recorded, settled and deletable', async ($, on) => {
  mock.store(on)
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on, { now: Date.UTC(2026, 9, 6, 12) })
  const files = new Map<string, string>()
  const removed: string[] = []
  let ranCommand = ''

  on('process.run', (_$, e) => {
    if (e.argv[0] === 'rm') removed.push(...e.argv.slice(2))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.stat', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false } }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    ranCommand = e.command
    const log = e.command.match(/tee '([^']+)'/)?.[1] ?? ''
    const models = Array.from(
      { length: 40 },
      (_, i) => `${i + 1} of 40 OK created model m${i + 1} [\u001b[32mSUCCESS ${i + 1}\u001b[0m in 1.0s]`,
    ).join('\n')
    const out = `Running with dbt=1.9\n${models}\nDone. PASS=4 WARN=0 ERROR=0 SKIP=0 TOTAL=4\n`
    files.set(log, out)
    files.set(log.replace(/\.log$/, '.rc'), '0\n')
    return { result: { stdout: out, stderr: '', interrupted: false } }
  })

  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // The engine's own band: empty.
  on('ui.render', { component: 'AbovePrompt' }, ($e, e) => h($e.ui.resolve(e).Box, {}) as RenderElement)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/r/fallback' }))

  await $.session.start({ cwd: '/r', surface: null } as never)
  const ran = await $.tool.call({ tool: 'Bash', command: 'cd /r/ethereum-models && ./dbt-env/bin/dbt run -m x' })

  expect(ranCommand).toContain("tee '/home/t/.claude/claude-modz/dbt-runs/")
  expect(ranCommand).toContain('./dbt-env/bin/dbt run -m x')
  expect(ran.deny).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'dbt-runs', surface, ...BAND })
    expect(await ui.find({ text: /dbt runs · 1 ·/ })).toBeDefined()
    expect(await ui.find({ text: /ethereum-models\s+\.\/dbt-env\/bin\/dbt run -m x/ })).toBeDefined()
    expect(await ui.find({ text: /4✓ 0⚠ 0✗/ })).toBeDefined()
    await ui.unmount()
  }

  // Click into the run, see its output, delete it from the detail view.
  const detail = await $.ui.mount({ plugin: 'dbt-runs', surface: 'terminal', ...BAND })
  const row = (await detail.findAll({ type: 'Button' })).find(b => b.key?.startsWith('open-'))
  await detail.press({ key: row!.key! })
  expect(await detail.find({ text: /PASS=4/ })).toBeDefined()
  // The whole log is drawn for the band to scroll with the wheel. (Opening at the end is
  // $.ui.scroll, which the test kit does not answer.)
  expect(await detail.find({ type: 'Text', text: /^Running with dbt=1.9$/ })).toBeDefined()
  expect(await detail.find({ type: 'Text', text: /^Done\. PASS=4/ })).toBeDefined()
  // dbt's colors come through as styled text, escapes gone.
  expect(await detail.find({ type: 'Text', text: /^SUCCESS 40$/ })).toBeDefined()
  expect(await detail.find({ text: /\u001b/ })).toBeUndefined()
  expect(await detail.find({ key: 'log-end' })).toBeDefined()
  await detail.press({ key: 'back' })
  expect(await detail.find({ text: /dbt runs · 1 ·/ })).toBeDefined()
  await detail.unmount()

  // Minimize hides the band but keeps the run; /dbt-runs shows it again.
  const band = await $.ui.mount({ plugin: 'dbt-runs', surface: 'terminal', ...BAND })
  await band.press({ key: 'minimize' })
  expect(await band.find({ text: /dbt runs/ })).toBeUndefined()
  await band.unmount()
  await $.command.run({ command: 'dbt-runs', args: '' } as never)
  const reopened = await $.ui.mount({ plugin: 'dbt-runs', surface: 'terminal', ...BAND })
  expect(await reopened.find({ text: /dbt runs · 1 ·/ })).toBeDefined()
  await reopened.unmount()

  const done = await $.command.run({ command: 'dbt-runs', args: 'clear' } as never)
  expect(JSON.stringify(done)).toContain('Deleted 1')
  const ui = await $.ui.mount({ plugin: 'dbt-runs', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /No dbt runs yet/ })).toBeDefined()
  await ui.unmount()
  expect(removed.length).toBe(2)
})

test('a non-dbt Bash call passes through untouched', async ($, on) => {
  mock.store(on)
  let ranCommand = ''
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    ranCommand = e.command
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(ranCommand).toBe('git status')
})
