import type { RenderElement } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { DbxEvent } from '../types'
import { buildQuery, emptyEnrichment, matchRows, parseHistory } from './enrich'
import { classifyBash, latestPerId, resultFacts, splitMcpName } from './events'
import { renderPage } from './html'
import { queryLink, tableLink } from './links'
import { classify, extractTables, normalizeSql } from './sql'

describe('tables', () => {
  test('reads, writes, CTEs and backticks', async () => {
    expect(extractTables('SELECT * FROM rcm_dev.charges.fct_charge c JOIN `rcm_prod`.`ref`.`dim_payer` p ON 1=1')).toEqual({
      read: ['rcm_dev.charges.fct_charge', 'rcm_prod.ref.dim_payer'],
      written: [],
    })
    expect(
      extractTables('WITH x AS (SELECT * FROM rcm_prod.a.b), y AS (SELECT 1) INSERT INTO rcm_dev.s.t SELECT * FROM x JOIN y'),
    ).toEqual({ read: ['rcm_prod.a.b'], written: ['rcm_dev.s.t'] })
  })

  test('merge, CTAS, delete, update, drop', async () => {
    expect(extractTables('MERGE INTO rcm_dev.s.t USING rcm_prod.s.src ON t.id = src.id WHEN MATCHED THEN UPDATE SET *')).toEqual({
      read: ['rcm_prod.s.src'],
      written: ['rcm_dev.s.t'],
    })
    expect(extractTables('CREATE OR REPLACE TABLE rcm_dev.s.new AS SELECT * FROM rcm_prod.s.old').written).toEqual(['rcm_dev.s.new'])
    expect(extractTables('DELETE FROM rcm_prod.s.t WHERE x = 1')).toEqual({ read: [], written: ['rcm_prod.s.t'] })
    expect(extractTables('UPDATE rcm_dev.s.t SET a = 1').written).toEqual(['rcm_dev.s.t'])
    expect(extractTables('DROP TABLE IF EXISTS rcm_dev.s.t').written).toEqual(['rcm_dev.s.t'])
  })

  test('keywords inside strings and comments are not tables', async () => {
    expect(extractTables("SELECT 'insert into rcm_prod.a.b' AS s -- from rcm_prod.x.y\nFROM rcm_dev.a.b")).toEqual({
      read: ['rcm_dev.a.b'],
      written: [],
    })
  })

  test('catalog classes', async () => {
    expect(classify('rcm_prod.a.b', ['rcm_prod'], ['rcm_dev'])).toBe('prod')
    expect(classify('rcm_dev.a.b', ['rcm_prod'], ['rcm_dev'])).toBe('dev')
    expect(classify('a.b', ['rcm_prod'], ['rcm_dev'])).toBe('other')
  })
})

describe('capture helpers', () => {
  test('Bash classification', async () => {
    const files: Record<string, string> = { 'load.py': 'import os\nfrom databricks import sql\n', 'plain.py': 'print(1)\n' }
    const reader = async (p: string) => files[p]
    expect(await classifyBash('python load.py --x 1', reader)).toBe('script')
    expect(await classifyBash('uv run python plain.py', reader)).toBeUndefined()
    expect(await classifyBash("python -c 'from databricks.sdk import WorkspaceClient; print(1)'", reader)).toBe('script')
    expect(await classifyBash('databricks jobs run-now 123', reader)).toBe('cli')
    expect(await classifyBash('grep -r databricks src', reader)).toBeUndefined()
    expect(await classifyBash('pip install databricks-sdk', reader)).toBeUndefined()
  })

  test('result facts are ids and counts, never values', async () => {
    const text = JSON.stringify({
      statement_id: '01ef-aaaa-bbbb-cccc-0123456789ab',
      manifest: { total_row_count: 3 },
      result: { data_array: [['patient-1'], ['patient-2'], ['patient-3']] },
    })
    const facts = resultFacts(text)
    expect(facts).toEqual({ statementId: '01ef-aaaa-bbbb-cccc-0123456789ab', rowCount: 3 })
    expect(JSON.stringify(facts)).not.toContain('patient')
    expect(resultFacts('Statement ID: 01ef1234-5678-9abc-def0-123456789abc, 2 rows').statementId).toBe(
      '01ef1234-5678-9abc-def0-123456789abc',
    )
  })

  test('the last line per id wins', async () => {
    const a = { id: 'a', status: 'running' }
    const b = { id: 'a', status: 'succeeded' }
    expect(latestPerId(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n{torn`).map(e => e.status)).toEqual(['succeeded'])
  })

  test('MCP names split at the server', async () => {
    expect(splitMcpName('mcp__databricks_sql__execute_sql')).toEqual({ server: 'databricks_sql', tool: 'execute_sql' })
    expect(splitMcpName('Bash')).toBeUndefined()
  })
})

const ev = (over: Partial<DbxEvent>): DbxEvent => ({
  id: 'e1',
  ts: '2026-10-06T12:00:00.000Z',
  ended_ts: '2026-10-06T12:00:02.000Z',
  session_id: 's',
  event_type: 'query',
  tool: 'mcp__databricks__execute_sql',
  status: 'succeeded',
  tables_read: [],
  tables_written: [],
  ...over,
})

describe('enrichment', () => {
  test('the query ties back by identity, with nothing about Claude in it', async () => {
    const q = buildQuery([ev({})], '', Date.parse('2026-10-06T12:10:00Z'))!
    expect(q).toContain('executed_by = current_user()')
    expect(q).toContain('system.query.history')
    expect(q.toLowerCase()).not.toContain('claude')
    expect(buildQuery([ev({})], "matt.o'brien@example.com", 0)).toContain("executed_by = 'matt.o\\'brien@example.com'")
  })

  test('history rows from the shapes an MCP may answer in', async () => {
    const asObjects = { content: [{ type: 'text', text: JSON.stringify([{ STATEMENT_ID: 'x', read_bytes: '10', start_ms: 1 }]) }], isError: false }
    expect(parseHistory(asObjects)).toEqual({ rows: [expect.objectContaining({ statement_id: 'x', read_bytes: 10, start_ms: 1 })] })
    const asArrays = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ manifest: { schema: { columns: [{ name: 'statement_id' }, { name: 'produced_rows' }] } }, result: { data_array: [['y', '5']] } }),
        },
      ],
      isError: false,
    }
    expect(parseHistory(asArrays)).toEqual({ rows: [expect.objectContaining({ statement_id: 'y', produced_rows: 5 })] })
    // The databricks-sql MCP (DBSQL statement API) wraps each row as { values: [{ string_value }] }.
    const asValueCells = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            statement_id: 'outer',
            status: { state: 'SUCCEEDED' },
            manifest: { format: 'JSON_ARRAY', schema: { columns: [{ name: 'statement_id' }, { name: 'produced_rows' }, { name: 'error_message' }] } },
            result: { data_array: [{ values: [{ string_value: 'z' }, { string_value: '7' }, { null_value: 'NULL_VALUE' }] }] },
          }),
        },
      ],
      isError: false,
    }
    expect(parseHistory(asValueCells)).toEqual({
      rows: [expect.objectContaining({ statement_id: 'z', produced_rows: 7, error_message: undefined })],
    })
    expect(parseHistory({ content: [{ type: 'text', text: 'PERMISSION_DENIED: system.query' }], isError: true })).toEqual({
      error: 'PERMISSION_DENIED: system.query',
    })
  })

  test('matching: statement id, then identical text in the window, then script windows', async () => {
    const t0 = Date.parse('2026-10-06T12:00:00Z')
    const events = [
      ev({ id: 'q1', statement_id: 'S1', sql_text: 'select 1' }),
      ev({ id: 'q2', sql_text: 'SELECT  *\nFROM rcm_dev.a.b;' }),
      ev({ id: 'py', event_type: 'script', tool: 'Bash (python)', ts: '2026-10-06T12:01:00.000Z', ended_ts: '2026-10-06T12:01:30.000Z' }),
    ]
    const rows = [
      { statement_id: 'S1', start_ms: t0 },
      { statement_id: 'S2', statement_text: 'select * from rcm_dev.a.b', start_ms: t0 + 500 },
      { statement_id: 'S3', statement_text: 'select 42', start_ms: t0 + 65_000 },
      { statement_id: 'S4', statement_text: 'select 43', start_ms: t0 + 600_000 },
    ]
    expect(matchRows(events, rows, t0 + 700_000)).toEqual({
      q1: [{ row: 'S1', how: 'statement_id' }],
      q2: [{ row: 'S2', how: 'text' }],
      py: [{ row: 'S3', how: 'window' }],
    })
    expect(normalizeSql('SELECT  *\nFROM x; ')).toBe('select * from x')
  })
})

describe('page', () => {
  const links = { host: 'adb-1.7.azuredatabricks.net', workspaceId: '42' }

  test('deep links carry the workspace', async () => {
    expect(tableLink(links, 'rcm_dev.s.t')).toBe('https://adb-1.7.azuredatabricks.net/explore/data/rcm_dev/s/t?o=42')
    expect(queryLink(links, 'S1')).toBe('https://adb-1.7.azuredatabricks.net/sql/history?queryId=S1&o=42')
    expect(tableLink({ host: '', workspaceId: '' }, 'rcm_dev.s.t')).toBeUndefined()
  })

  test('self-contained, escaped, prod loud', async () => {
    const html = renderPage({
      sessionId: 's1',
      branch: 'feat/x',
      cwd: '/r',
      generatedAt: Date.parse('2026-10-06T12:05:00Z'),
      events: [
        ev({ id: 'w', sql_text: "INSERT INTO rcm_prod.s.t SELECT '<b>' FROM rcm_dev.s.u", tables_read: ['rcm_dev.s.u'], tables_written: ['rcm_prod.s.t'], statement_id: 'S9' }),
        ev({ id: 'b', status: 'blocked', event_type: 'blocked', sql_text: 'DROP TABLE rcm_prod.s.t', block_reason: 'rcm_prod is select-only', tables_written: ['rcm_prod.s.t'] }),
      ],
      enrichment: emptyEnrichment(),
      reports: [],
      links,
      prod: ['rcm_prod'],
      dev: ['rcm_dev'],
    })
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain("'<b>'")
    expect(html).toContain('PROD WRITE')
    expect(html).toContain('rcm_prod is select-only')
    expect(html).toContain('queryId=S9&amp;o=42')
    expect(html).toContain('<svg class="graph"')
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet|@import/)
  })
})

// --- Through the engine ------------------------------------------------------------------

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 110, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

const TOOL = 'mcp__databricks__execute_sql'

// On Windows the engine hands fs hooks `C:\r\...` for `/r/...`; the fake disk keys on one form.
const slashPath = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
class FakeDisk extends Map<string, string> {
  override get(path: string) {
    return super.get(slashPath(path))
  }
  override set(path: string, text: string) {
    return super.set(slashPath(path), text)
  }
  override has(path: string) {
    return super.has(slashPath(path))
  }
}

const harness = (on: Parameters<TestBody>[1]) => {
  mock.store(on)
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on, { now: Date.UTC(2026, 9, 6, 12) })
  const files = new FakeDisk()
  const ran: string[][] = []
  const sent: Record<string, unknown>[] = []
  const mcpCalls: { server: string; tool: string; args: Record<string, unknown> }[] = []
  const opened: string[] = []
  let history: unknown = { content: [{ type: 'text', text: '[]' }], isError: false }
  let cwd = '/r'

  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    const stdout = e.argv[0] === 'git' ? 'feat/charges\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('mcp.call', (_$, e) => {
    mcpCalls.push({ server: e.server, tool: e.tool, args: e.args })
    return { value: history as never }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: '/r' }))
  on('ui.render', { component: 'AbovePrompt' }, ($e, e) => h($e.ui.resolve(e).Box, {}) as RenderElement)
  on('tool.call', { tool: TOOL }, (_$, e) => {
    sent.push({ ...(e as Record<string, unknown>) })
    const text = JSON.stringify({ statement_id: 'S-1', manifest: { total_row_count: 2 }, result: { data_array: [['a'], ['b']] } })
    return { result: { content: [{ type: 'text', text }] }, text }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))

  return {
    files,
    ran,
    sent,
    mcpCalls,
    opened,
    setHistory: (value: unknown) => {
      history = value
    },
    setCwd: (dir: string) => {
      cwd = dir
    },
    lines: () => latestPerId(files.get('/r/.claude/dbx-trace/sess-1.jsonl') ?? ''),
  }
}

test('a Databricks SQL call is recorded untouched, linked, enriched and drawn', async ($, on) => {
  const h_ = harness(on)
  await $.session.start({ cwd: '/r', surface: null } as never)

  const sql = 'INSERT INTO rcm_dev.charges.t SELECT * FROM rcm_prod.charges.src'
  const result = await $.tool.call({ tool: TOOL, statement: sql, warehouse_id: 'wh1' } as never)

  // The statement reaches Databricks exactly as Claude wrote it: no tag, nothing added.
  expect(h_.sent[0]?.statement).toBe(sql)
  const [event] = h_.lines()
  expect(event).toMatchObject({
    status: 'succeeded',
    statement_id: 'S-1',
    row_count: 2,
    warehouse_id: 'wh1',
    tables_written: ['rcm_dev.charges.t'],
    tables_read: ['rcm_prod.charges.src'],
  })
  // Counts only: no result value reaches the trace.
  expect(h_.files.get('/r/.claude/dbx-trace/sess-1.jsonl')).not.toMatch(/"a"|\["b"\]/)
  expect(h_.files.get('/r/.claude/dbx-trace/.gitignore')).toBe('*\n')
  expect(result.deny).toBeUndefined()

  // History: identity-matched by statement id.
  h_.setHistory({
    content: [{ type: 'text', text: JSON.stringify([{ statement_id: 'S-1', read_bytes: 2048, total_duration_ms: 900, produced_rows: 2, start_ms: Date.UTC(2026, 9, 6, 12) }]) }],
    isError: false,
  })
  const refreshed = await $.command.run({ command: 'dbx-trace', args: 'refresh' } as never)
  expect(JSON.stringify(refreshed)).toContain('Query history read')
  expect(h_.mcpCalls[0]).toMatchObject({ server: 'databricks', tool: 'execute_sql', args: { warehouse_id: 'wh1' } })
  expect(String(h_.mcpCalls[0]?.args.statement)).toContain('executed_by = current_user()')
  expect(String(h_.mcpCalls[0]?.args.statement).toLowerCase()).not.toContain('claude')
  const page = h_.files.get('/r/.claude/dbx-trace/sess-1.html') ?? ''
  expect(page).toContain('2.0 KB')
  expect(page).toContain('feat/charges')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'dbx-trace', surface, ...BAND })
    expect(await ui.find({ text: /Databricks/ })).toBeDefined()
    expect(await ui.find({ text: /INSERT INTO rcm_dev\.charges\.t/ })).toBeDefined()
    expect(await ui.find({ text: /2\.0 KB read/ })).toBeDefined()
    await ui.unmount()
  }

  // /dbx-trace page opens the page; minimize hides the band.
  await $.command.run({ command: 'dbx-trace', args: 'page' } as never)
  expect(h_.ran.some(argv => argv[0] === 'open' && argv[1] === '/r/.claude/dbx-trace/sess-1.html')).toBe(true)
  const band = await $.ui.mount({ plugin: 'dbx-trace', surface: 'terminal', ...BAND })
  await band.press({ key: 'hide' })
  expect(await band.find({ text: /Databricks/ })).toBeUndefined()
  await band.unmount()
})

test('a whitelist block is recorded as blocked, a prod write as loud', async ($, on) => {
  const h_ = harness(on)
  on('classic.PreToolUse', () => ({ deny: 'rcm_prod is select-only' }))
  await $.session.start({ cwd: '/r', surface: null } as never)

  await $.tool.call({ tool: TOOL, statement: 'DELETE FROM rcm_prod.charges.t' } as never)
  const [event] = h_.lines()
  expect(event).toMatchObject({ status: 'blocked', event_type: 'blocked', block_reason: 'rcm_prod is select-only' })

  const ui = await $.ui.mount({ plugin: 'dbx-trace', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /1 blocked/ })).toBeDefined()
  await ui.unmount()
})

test('enrichment errors show instead of failing', async ($, on) => {
  const h_ = harness(on)
  await $.session.start({ cwd: '/r', surface: null } as never)
  await $.tool.call({ tool: TOOL, statement: 'select 1' } as never)
  h_.setHistory({ content: [{ type: 'text', text: '[INSUFFICIENT_PERMISSIONS] system.query.history' }], isError: true })
  const out = await $.command.run({ command: 'dbx-trace', args: 'refresh' } as never)
  expect(JSON.stringify(out)).toContain('INSUFFICIENT_PERMISSIONS')
  const ui = await $.ui.mount({ plugin: 'dbx-trace', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /query history: \[INSUFFICIENT_PERMISSIONS\]/ })).toBeDefined()
  await ui.unmount()
})

test('a Python script using databricks is recorded; other Bash passes untouched', async ($, on) => {
  const h_ = harness(on)
  h_.files.set('/r/jobs/load.py', 'from databricks import sql\n')
  await $.session.start({ cwd: '/r', surface: null } as never)

  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(h_.lines()).toEqual([])

  await $.tool.call({ tool: 'Bash', command: 'cd jobs && python load.py' })
  expect(h_.lines()).toEqual([expect.objectContaining({ event_type: 'script', status: 'succeeded', command: 'cd jobs && python load.py' })])
})

test('non-SQL calls on the Databricks server pass unrecorded', async ($, on) => {
  const h_ = harness(on)
  on('tool.call', { tool: 'mcp__databricks__list_warehouses' }, () => ({ result: { content: [] } }))
  await $.session.start({ cwd: '/r', surface: null } as never)
  await $.tool.call({ tool: 'mcp__databricks__list_warehouses' } as never)
  expect(h_.lines()).toEqual([])
})

test(
  'with a workspace configured, Claude gets the deep links to quote',
  { options: { workspace_host: 'https://adb-1.7.azuredatabricks.net', workspace_id: '42' } },
  async ($, on) => {
    harness(on)
    await $.session.start({ cwd: '/r', surface: null } as never)
    const result = await $.tool.call({ tool: TOOL, statement: 'SELECT * FROM rcm_dev.charges.fct_charge' } as never)
    const note = (result.context ?? []).join('\n')
    expect(note).toContain('query profile: https://adb-1.7.azuredatabricks.net/sql/history?queryId=S-1&o=42')
    expect(note).toContain('rcm_dev.charges.fct_charge: https://adb-1.7.azuredatabricks.net/explore/data/rcm_dev/charges/fct_charge?o=42')
  },
)

test('a CTE after CREATE ... AS is not a table', async () => {
  expect(extractTables('CREATE OR REPLACE TABLE rcm_dev.s.t AS WITH base AS (SELECT * FROM rcm_prod.s.src) SELECT * FROM base')).toEqual({
    read: ['rcm_prod.s.src'],
    written: ['rcm_dev.s.t'],
  })
})

const PANE_PROPS = {
  component: 'Pane',
  requestId: 'dbx-trace',
  props: {
    title: 'Databricks trace',
    isFocused: true,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the panel opens on the first action and shows the whole trace inside Claude Code', async ($, on) => {
  const h_ = harness(on)
  on('classic.PreToolUse', (_$, e) =>
    /delete/i.test(String((e as Record<string, unknown>).statement)) ? { deny: 'rcm_prod is select-only' } : {},
  )
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true } as never)

  await $.tool.call({ tool: TOOL, statement: 'SELECT COUNT(*) FROM rcm_prod.charges.fct_charge_inventory' } as never)
  // Opened by itself, once.
  expect(h_.opened).toEqual(['dbx-trace'])
  await $.tool.call({ tool: TOOL, statement: 'CREATE OR REPLACE TABLE rcm_dev.charges.stg AS SELECT * FROM rcm_prod.charges.fct_charge_inventory' } as never)
  await $.tool.call({ tool: TOOL, statement: 'DELETE FROM rcm_prod.charges.fct_charge_inventory WHERE is_test = 1' } as never)
  expect(h_.opened).toEqual(['dbx-trace'])

  // While the panel is up, the band steps aside.
  const band = await $.ui.mount({ plugin: 'dbx-trace', surface: 'terminal', ...BAND })
  expect(await band.find({ text: /^Databricks$/ })).toBeUndefined()
  await band.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'dbx-trace', surface, ...PANE_PROPS })
    expect(await pane.find({ text: /3 actions · 2 queries/ })).toBeDefined()
    expect(await pane.find({ text: /1 blocked/ })).toBeDefined()
    expect(await pane.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()
    expect(await pane.find({ text: /^Guardrails$/ })).toBeDefined()
    expect(await pane.find({ text: /^rcm_prod\s*$/ })).toBeDefined()
    expect(await pane.find({ text: /^rcm_dev\s*$/ })).toBeDefined()

    // Open the blocked action, read why, come back.
    const rows = (await pane.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('open-'))
    expect(rows.length).toBe(3)
    await pane.press({ key: rows[0]!.key! })
    expect(await pane.find({ text: /rcm_prod is select-only/ })).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toBeDefined()
    expect(await pane.find({ text: /Next: nothing on Databricks/ })).toBeDefined()
    await pane.press({ key: 'back' })
    expect(await pane.find({ text: /3 actions/ })).toBeDefined()
    await pane.unmount()
  }

  // /dbx-trace hide closes the panel (the band comes back only once shown again); /dbx-trace reopens it.
  await $.command.run({ command: 'dbx-trace', args: 'hide' } as never)
  const before = h_.opened.length
  await $.command.run({ command: 'dbx-trace', args: '' } as never)
  expect(h_.opened.length).toBe(before + 1)
})

test('a headless session never opens the panel', async ($, on) => {
  const h_ = harness(on)
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  await $.tool.call({ tool: TOOL, statement: 'SELECT 1' } as never)
  expect(h_.opened).toEqual([])
})

test('the trace stays at the project root when the shell has cd-ed elsewhere', async ($, on) => {
  const h_ = harness(on)
  await $.session.start({ cwd: '/r', surface: null } as never)
  h_.setCwd('/r/dbx-trace/hooks')
  await $.tool.call({ tool: TOOL, statement: 'SELECT count(*) FROM rcm_dev.charges.t' } as never)
  h_.setCwd('/other/repo')
  await $.tool.call({ tool: TOOL, statement: 'SELECT count(*) FROM rcm_dev.charges.u' } as never)

  expect(h_.lines().map(l => l.tables_read)).toEqual([['rcm_dev.charges.t'], ['rcm_dev.charges.u']])
  expect([...h_.files.keys()].filter(k => !k.startsWith('/r/.claude/dbx-trace/'))).toEqual([])
})
