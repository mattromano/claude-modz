import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { DbxEnrichment, DbxEvent, DbxPaneView } from '../types'
import { ENRICH_MARK, buildQuery, emptyEnrichment, matchRows, parseHistory, pendingEvents, rowsFor } from './enrich'
import type { McpLikeResult } from './enrich'
import {
  classifyBash,
  commandDir,
  formatBytes,
  formatDuration,
  formatTime,
  keptArgs,
  latestPerId,
  resolvePath,
  resultFacts,
  splitMcpName,
  sqlArgOf,
  tracePaths,
  truncate,
} from './events'
import { kindOf, renderPage, totals } from './html'
import type { Kind, Report } from './html'
import type { LinkConfig } from './links'
import { queryLink, tableLink } from './links'
import { KIND_COLOR, tableGroups, timelineCells, timelineSvg } from './pane'
import { classify, extractTables, preview, splitList } from './sql'

type $ = EngineInterface

const events = atom({ plugin: 'dbx-trace', key: 'events' } as const, [] as DbxEvent[])
const enrichment = atom({ plugin: 'dbx-trace', key: 'enrichment' } as const, emptyEnrichment())
const isShown = atom({ plugin: 'dbx-trace', key: 'isShown' } as const, false)
const pagePath = atom({ plugin: 'dbx-trace', key: 'pagePath' } as const, '')
const paneView = atom({ plugin: 'dbx-trace', key: 'paneView' } as const, { kind: 'list' } as DbxPaneView)
const isPaneOpen = atom({ plugin: 'dbx-trace', key: 'isPaneOpen' } as const, false)

const PANE = 'dbx-trace'
const PANE_TITLE = 'Databricks trace'
const PANE_ROWS = 28

const BAND_ROWS = 6

const GLYPH: Record<Kind | 'running', { glyph: string; color: string }> = {
  read: { glyph: '◇', color: 'inactive' },
  write: { glyph: '✎', color: 'success' },
  'prod-write': { glyph: '✎', color: 'error' },
  script: { glyph: '▸', color: 'suggestion' },
  failed: { glyph: '✗', color: 'error' },
  blocked: { glyph: '⊘', color: 'warning' },
  running: { glyph: '●', color: 'warning' },
}

type Config = {
  links: LinkConfig
  user: string
  toolPattern: RegExp
  sqlArgs: string[]
  enrichTool: string
  prod: string[]
  dev: string[]
  enrich: boolean
}

const readConfig = (options: PluginOptions): Config => {
  const s = (key: string, fallback: string) => (typeof options[key] === 'string' ? (options[key] as string) : fallback)
  let toolPattern: RegExp
  try {
    toolPattern = new RegExp(s('mcp_tool_pattern', '^mcp__.*databricks.*__'), 'i')
  } catch {
    toolPattern = /^mcp__.*databricks.*__/i
  }
  return {
    links: { host: s('workspace_host', ''), workspaceId: s('workspace_id', '') },
    user: s('user_email', ''),
    toolPattern,
    sqlArgs: s('sql_arg_names', 'statement,query,sql,sql_query')
      .split(',')
      .map(x => x.trim())
      .filter(x => x !== ''),
    enrichTool: s('enrich_tool', ''),
    prod: splitList(s('prod_catalogs', 'rcm_prod')),
    dev: splitList(s('dev_catalogs', 'rcm_dev')),
    enrich: options.enrich !== false,
  }
}

const readText = async ($: $, path: string) => {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

// Module state: a reload starts it over, which is fine (the files and $.state keep the record).
let cfg: Config = readConfig({})
// Writes to one file go one at a time.
let writes: Promise<unknown> = Promise.resolve()
let isEnriching = false
let isDirty = false
// A headless run (`claude -p`, the SDK) exits right after its last turn: it reads history inside the turn.
let isInteractive = true
// The panel opens itself once, on a session's first Databricks action.
let hasAutoOpened = false
let branch: string | undefined
// tool_use_id -> the whitelist's deny, seen at classic.PreToolUse beneath our tool.call hook.
const denials = new Map<string, string>()


const paths = async ($: $) => tracePaths(await $.session.cwd(), await $.session.id())

const queue = (work: () => Promise<void>) => {
  const run = writes.then(work, work)
  writes = run.catch(() => undefined)
  return run
}

/** Appends the event's line (never rewrites earlier ones) and updates the band. */
const record = async ($: $, event: DbxEvent) => {
  isDirty = true
  await update($, events, list => {
    const at = list.findIndex(x => x.id === event.id)
    return at < 0 ? [...list, event] : list.map((x, i) => (i === at ? event : x))
  })
  const p = await paths($)
  await queue(async () => {
    if ((await readText($, p.gitignore)) === undefined) await $.fs.write(p.gitignore, '*\n')
    const before = (await readText($, p.events)) ?? ''
    await $.fs.write(p.events, `${before}${JSON.stringify(event)}\n`)
  })
}

const loadSession = async ($: $) => {
  const p = await paths($)
  const list = latestPerId((await readText($, p.events)) ?? '')
  let saved: DbxEnrichment = emptyEnrichment()
  try {
    const text = await readText($, p.enrichment)
    if (text !== undefined) saved = { ...emptyEnrichment(), ...(JSON.parse(text) as DbxEnrichment) }
  } catch {
    // A torn file: read history again.
  }
  await update($, events, () => list)
  await update($, enrichment, () => saved)
  if (list.length > 0) await update($, pagePath, () => p.page)
}

/** The MCP server and tool that read history: configured, else the last SQL tool Claude used. */
const enrichTarget = (list: readonly DbxEvent[]) => {
  const lastQuery = [...list].reverse().find(e => e.event_type === 'query' && e.sql_arg !== undefined)
  const name = cfg.enrichTool !== '' ? cfg.enrichTool : lastQuery?.tool
  const split = name === undefined ? undefined : splitMcpName(name)
  if (split === undefined) return undefined
  const arg = lastQuery?.sql_arg ?? cfg.sqlArgs[0] ?? 'statement'
  return { ...split, arg, extra: lastQuery?.call_args ?? {} }
}

type EnrichTarget = NonNullable<ReturnType<typeof enrichTarget>>

/**
 * Runs the history read on the MCP directly; where no session is bound for that (a headless
 * `claude -p`), through the same tool as a tool call, which the whitelist sees like any other.
 */
const runHistoryQuery = async ($: $, target: EnrichTarget, query: string): Promise<McpLikeResult> => {
  const args = { ...target.extra, [target.arg]: query }
  try {
    return (await $.mcp.call(target.server, target.tool, args)) as McpLikeResult
  } catch (err) {
    if (!/not available/i.test(err instanceof Error ? err.message : String(err))) throw err
  }
  const ran = await $.tool.call({ tool: `mcp__${target.server}__${target.tool}`, ...args } as never)
  if (ran.deny !== undefined) return { content: [{ type: 'text', text: ran.deny }], isError: true }
  return { content: [{ type: 'text', text: ran.text ?? JSON.stringify(ran.result) }], isError: ran.isError === true }
}

const enrichNow = async ($: $, force: boolean) => {
  if (!cfg.enrich || isEnriching) return
  const list = await read($, events)
  const current = await read($, enrichment)
  const now = await $.clock.now()
  if (!force && pendingEvents(list, current, now).length === 0) return
  const target = enrichTarget(list)
  const query = buildQuery(list, cfg.user, now)
  if (query === undefined) return
  if (target === undefined) {
    await saveEnrichment($, {
      ...current,
      error: 'no Databricks SQL tool used yet this session; set enrich_tool to read history for scripts',
    })
    return
  }
  isEnriching = true
  try {
    const result = await runHistoryQuery($, target, query)
    const parsed = parseHistory(result)
    if ('error' in parsed) {
      await saveEnrichment($, { ...current, error: parsed.error })
    } else {
      await saveEnrichment($, { fetched_at: now, rows: parsed.rows, matches: matchRows(list, parsed.rows, now) })
    }
  } catch (err) {
    await saveEnrichment($, { ...current, error: err instanceof Error ? err.message : String(err) })
  } finally {
    isEnriching = false
  }
}

const saveEnrichment = async ($: $, value: DbxEnrichment) => {
  isDirty = true
  await update($, enrichment, () => value)
  const p = await paths($)
  await queue(() => $.fs.write(p.enrichment, JSON.stringify(value)))
}

const readReports = async ($: $, path: string): Promise<Report[]> => {
  try {
    const parsed = JSON.parse((await readText($, path)) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((r): r is Report => typeof r?.title === 'string' && typeof r?.path === 'string') : []
  } catch {
    return []
  }
}

const writePage = async ($: $) => {
  const list = await read($, events)
  if (list.length === 0) return undefined
  const p = await paths($)
  const cwd = await $.session.cwd()
  const html = renderPage({
    sessionId: await $.session.id(),
    branch,
    cwd,
    generatedAt: await $.clock.now(),
    events: list,
    enrichment: await read($, enrichment),
    reports: await readReports($, p.reports),
    links: cfg.links,
    prod: cfg.prod,
    dev: cfg.dev,
  })
  await queue(() => $.fs.write(p.page, html))
  isDirty = false
  await update($, pagePath, () => p.page)
  return p.page
}

const openPage = async ($: $, path: string) => {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const tries: string[][] = isWindows ? [['cmd', '/c', 'start', '', path]] : [['open', path], ['xdg-open', path]]
  for (const argv of tries) {
    const ran = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => undefined)
    if (ran?.exitCode === 0) return true
  }
  return false
}

/** Opens the panel; asked (a command, a press) it seats at any width, unasked from 144 columns. */
const openPane = async ($: $) => {
  // Inline (the default layout) it asks for room to show the actions; docked it takes the column.
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, rows: PANE_ROWS })
  await update($, isPaneOpen, () => opened.isPlaced)
  return opened.isPlaced
}

const showAction = async ($: $, id: string) => {
  await update($, paneView, (): DbxPaneView => ({ kind: 'detail', id }))
  await openPane($)
}

/** A Databricks action started: the band shows, and the session's first one opens the panel. */
const announce = async ($: $) => {
  await update($, isShown, () => true)
  if (isInteractive && !hasAutoOpened) {
    hasAutoOpened = true
    await openPane($).catch(() => undefined)
  }
}

/** End of a turn: read history for what is still unmatched, then redraw the page. */
const afterTurn = async ($: $) => {
  await enrichNow($, false)
  if (isDirty) await writePage($)
}

/** Deep links for the model to quote after a query: the statement, then the tables. */
const linkNote = (event: DbxEvent): string | undefined => {
  if (event.status !== 'succeeded') return undefined
  const statement = event.statement_id === undefined ? undefined : queryLink(cfg.links, event.statement_id)
  const tables = [...event.tables_written, ...event.tables_read.filter(t => !event.tables_written.includes(t))]
    .slice(0, 6)
    .flatMap(t => {
      const href = tableLink(cfg.links, t)
      return href === undefined ? [] : [`${t}: ${href}`]
    })
  if (statement === undefined && tables.length === 0) return undefined
  return [
    'Databricks links for this call (include the relevant ones when you report on it):',
    ...(statement !== undefined ? [`query profile: ${statement}`] : []),
    ...tables,
  ].join('\n')
}

const settle = async (
  $: $,
  event: DbxEvent,
  ran: { deny?: string; isError?: boolean; text?: string },
  toolUseId: string,
): Promise<DbxEvent> => {
  const ended = await $.clock.now()
  const duration_ms = ended - Date.parse(event.ts)
  // The engine prefixes a settings hook's reason (`PreToolUse:<tool> hook error: `); keep the rule's own words.
  const denied = (ran.deny ?? denials.get(toolUseId))?.replace(/^PreToolUse:\S+ hook(?: blocking)? error:\s*/, '')
  denials.delete(toolUseId)
  if (denied !== undefined) {
    const blocked: DbxEvent = { ...event, event_type: 'blocked', status: 'blocked', block_reason: denied, ended_ts: iso(ended), duration_ms }
    await record($, blocked)
    return blocked
  }
  const settled: DbxEvent = {
    ...event,
    status: ran.isError === true ? 'failed' : 'succeeded',
    ended_ts: iso(ended),
    duration_ms,
    ...(ran.isError === true ? { error: (ran.text ?? '').trim().split('\n')[0]?.slice(0, 500) } : {}),
  }
  await record($, settled)
  return settled
}

export const register: Register = (on, options) => {
  cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    const started = await next(e)
    await $.command.register({
      name: 'dbx-trace',
      description: 'Databricks trace panel (args: page | refresh | path | hide | clear)',
      argumentHint: '[page|refresh|path|hide|clear]',
    })
    await loadSession($)
    // A resumed session already had its first action; its panel opens on asking.
    if ((await read($, events)).length > 0) {
      hasAutoOpened = true
      await update($, isShown, () => true)
    }
    const git = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: e.cwd, timeoutMs: 5000 }).catch(() => undefined)
    branch = git?.exitCode === 0 ? git.stdout.trim() : undefined
    return started
  })

  // Beneath every tool.call hook: the whitelist's verdict, so a block is not mistaken for a failure.
  on('classic.PreToolUse', async ($, e, next) => {
    const verdict = await next(e)
    if (typeof verdict.deny === 'string') denials.set(e.tool_use_id, verdict.deny)
    return verdict
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const sessionId = await $.session.id()
    const startedAt = await $.clock.now()

    if (tool === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : ''
      const cwd = await $.session.cwd()
      const home = await $.env.get('HOME')
      const dir = commandDir(command, cwd, home)
      const kind = await classifyBash(command, path => readText($, resolvePath(path, dir, home)))
      if (kind === undefined) return next(e)
      const tables = extractTables(command)
      const event: DbxEvent = {
        id: e.tool_use_id,
        ts: iso(startedAt),
        session_id: sessionId,
        event_type: kind,
        tool: kind === 'cli' ? 'databricks CLI' : 'Bash (python)',
        command,
        status: 'running',
        tables_read: tables.read,
        tables_written: tables.written,
        ...(input.run_in_background === true ? { background: true } : {}),
      }
      await record($, event)
      await announce($)
      const ran = await next(e)
      await settle($, event, ran, e.tool_use_id)
      return ran
    }

    if (!cfg.toolPattern.test(tool)) return next(e)
    const found = sqlArgOf(input, cfg.sqlArgs)
    // Not a SQL call on this server (listing warehouses, polling): pass, unrecorded.
    if (found === undefined || found.sql.includes(ENRICH_MARK)) return next(e)
    const tables = extractTables(found.sql)
    const event: DbxEvent = {
      id: e.tool_use_id,
      ts: iso(startedAt),
      session_id: sessionId,
      event_type: 'query',
      tool,
      sql_text: found.sql,
      sql_arg: found.arg,
      call_args: keptArgs(input),
      status: 'running',
      tables_read: tables.read,
      tables_written: tables.written,
    }
    const warehouse = Object.entries(event.call_args ?? {}).find(([k]) => /warehouse/i.test(k))?.[1]
    if (typeof warehouse === 'string') event.warehouse_id = warehouse
    await record($, event)
    await announce($)

    const ran = await next(e)
    const facts = ran.deny === undefined && ran.isError !== true ? resultFacts(ran.text) : {}
    const settled = await settle(
      $,
      {
        ...event,
        ...(facts.statementId !== undefined ? { statement_id: facts.statementId } : {}),
        ...(facts.warehouseId !== undefined ? { warehouse_id: facts.warehouseId } : {}),
        ...(facts.rowCount !== undefined ? { row_count: facts.rowCount } : {}),
      },
      ran,
      e.tool_use_id,
    )
    if (ran.deny !== undefined || settled.status === 'blocked') return ran
    const note = linkNote(settled)
    return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // The main loop's turns only; history and the page catch up off the turn's clock, or, with
    // nobody at the prompt, before the process can exit.
    if (e.agentId === undefined && (await read($, events)).length > 0) {
      if (isInteractive) $.clock.after(50, () => void afterTurn($).catch(() => undefined))
      else await afterTurn($).catch(() => undefined)
    }
    return done
  })

  // A last read and redraw as the session ends; a headless run exits before the turn-end timer fires.
  on('session.end', async ($, e, next) => {
    if ((await read($, events)).length > 0) await afterTurn($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'dbx-trace' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'hide') {
      await update($, isShown, () => false)
      await $.ui.close({ id: PANE })
      return { text: 'Databricks trace hidden; /dbx-trace brings it back.' }
    }
    if (arg === 'clear') {
      const p = await paths($)
      await queue(async () => {
        await $.fs.write(p.events, '')
        await $.fs.write(p.enrichment, JSON.stringify(emptyEnrichment()))
      })
      await update($, events, () => [])
      await update($, enrichment, () => emptyEnrichment())
      await update($, paneView, (): DbxPaneView => ({ kind: 'list' }))
      return { text: 'Cleared this session’s Databricks trace.' }
    }
    if (arg === 'path') {
      const p = await paths($)
      return { text: `Trace: ${p.events}\nPage: ${p.page}` }
    }
    if (arg === 'refresh') {
      await enrichNow($, true)
      const page = await writePage($)
      const err = (await read($, enrichment)).error
      if (page === undefined) return { text: 'No Databricks actions in this session yet.' }
      return { text: err === undefined ? `Query history read; panel and page updated.` : `Query history unavailable (${err}).` }
    }
    if (arg === 'page') {
      const page = await writePage($)
      if (page === undefined) return { text: 'No Databricks actions in this session yet.' }
      const opened = await openPage($, page)
      return { text: opened ? `Opened ${page}` : `Trace page: ${page}` }
    }
    await update($, paneView, (): DbxPaneView => ({ kind: 'list' }))
    await update($, isShown, () => true)
    const placed = await openPane($)
    return { text: placed ? 'Databricks trace panel opened.' : 'Databricks trace panel is waiting for room; the band shows meanwhile.' }
  })

  // The person (or a plugin) closed the panel: the band comes back.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isPaneOpen, () => false)
    return closed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || !(await read($, isShown)) || (await read($, isPaneOpen))) return below
    const list = await read($, events)
    if (list.length === 0) return below

    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns)
    const enriched = await read($, enrichment)
    const now = await $.clock.now()
    const t = totals(list, enriched, cfg.prod)
    const run = (work: () => Promise<unknown>) => () => void work().catch(() => undefined)

    const rows = [...list].reverse().slice(0, BAND_ROWS)
    const band = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text>
            <Text bold>Databricks</Text>
            <Text dimColor>
              {' '}
              · {t.actions} action{t.actions === 1 ? '' : 's'}
            </Text>
            {t.failed > 0 && <Text color="error"> · {t.failed} failed</Text>}
            {t.blocked > 0 && <Text color="warning"> · {t.blocked} blocked</Text>}
            {t.prodWrites > 0 && (
              <Text color="error" bold>
                {' '}
                · {t.prodWrites} PROD WRITE{t.prodWrites === 1 ? '' : 'S'}
              </Text>
            )}
            {t.readBytes !== undefined && <Text dimColor> · {formatBytes(t.readBytes)} read</Text>}
          </Text>
          <Button key="panel" hotkey="p" onPress={run(async () => { await update($, paneView, (): DbxPaneView => ({ kind: 'list' })); await openPane($) })}>
            Panel
          </Button>
          <Button key="open" hotkey="o" dimColor onPress={run(async () => { const p = await writePage($); if (p !== undefined) await openPage($, p) })}>
            Page
          </Button>
          <Button key="hide" hotkey="m" dimColor onPress={run(() => update($, isShown, () => false))}>
            Minimize
          </Button>
        </Box>
        {rows.map(ev => {
          const kind = kindOf(ev, cfg.prod)
          const { glyph, color } = ev.status === 'running' ? GLYPH.running : GLYPH[kind]
          const tables = ev.tables_written.length > 0 ? ev.tables_written : ev.tables_read
          const tableText = tables.length === 0 ? '' : `${tables[0]}${tables.length > 1 ? ` +${tables.length - 1}` : ''}`
          const stat = ev.status === 'running' ? 'running' : formatDuration(ev.duration_ms)
          const head = `${formatTime(Date.parse(ev.ts), now)} ${stat.padStart(6)}  `
          const room = Math.max(10, width - head.length - tableText.length - 6)
          return (
            <Box key={`ev-${ev.id}`} flexDirection="row">
              <Text color={color}>{glyph} </Text>
              <Button
                key={`band-open-${ev.id}`}
                plain
                onPress={run(() => showAction($, ev.id))}
                label={`${head}${truncate(preview(ev.sql_text ?? ev.command ?? '', room), room)}`}
              />
              {tableText !== '' && <Text {...(ev.tables_written.length > 0 ? { color: classify(tables[0]!, cfg.prod, cfg.dev) === 'prod' ? 'error' : 'success' } : { dimColor: true })}>  {tableText}</Text>}
            </Box>
          )
        })}
        {list.length > BAND_ROWS && <Text dimColor>… {list.length - BAND_ROWS} earlier in the panel</Text>}
        {enriched.error !== undefined && (
          <Text color="warning" wrap="truncate-end">
            query history: {enriched.error}
          </Text>
        )}
        <Text dimColor>ctrl+x tab to focus · Enter opens an action · p panel · o page · m minimize</Text>
      </Box>
    )
    return (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code, Link } = $.ui.resolve(e)
    const width = Math.max(40, e.props.bodyColumns)
    const list = await read($, events)
    const enriched = await read($, enrichment)
    const view = await read($, paneView)
    const now = await $.clock.now()
    const run = (work: () => Promise<unknown>) => () => void work().catch(() => undefined)
    const toList = run(() => update($, paneView, (): DbxPaneView => ({ kind: 'list' })))
    const openPageNow = run(async () => {
      const p = await writePage($)
      if (p !== undefined) await openPage($, p)
    })
    const refresh = run(async () => {
      await enrichNow($, true)
      await writePage($)
    })
    const link = (href: string | undefined, text: string, color?: string) =>
      href === undefined ? <Text {...(color !== undefined ? { color } : {})}>{text}</Text> : <Link href={href}>{color !== undefined ? <Text color={color}>{text}</Text> : text}</Link>
    const tableColor = (t: string, written: boolean) => {
      const cls = classify(t, cfg.prod, cfg.dev)
      return cls === 'prod' ? 'error' : cls === 'dev' ? 'success' : written ? undefined : 'inactive'
    }
    const glyphOf = (ev: DbxEvent) => (ev.status === 'running' ? GLYPH.running : GLYPH[kindOf(ev, cfg.prod)])

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>Databricks trace</Text>
          <Text dimColor>No Databricks actions in this session yet. They appear here as Claude runs queries and scripts.</Text>
        </Box>
      )
    }

    // --- One action ---------------------------------------------------------------------
    const detail = view.kind === 'detail' ? list.find(x => x.id === view.id) : undefined
    if (detail !== undefined) {
      const kind = kindOf(detail, cfg.prod)
      const { glyph, color } = glyphOf(detail)
      const history = rowsFor(enriched, detail.id)
      const own = detail.event_type === 'query' && history.length === 1 ? history[0] : undefined
      const statementId = detail.statement_id ?? own?.statement_id
      const text = detail.sql_text ?? detail.command ?? ''
      const at = list.indexOf(detail)
      const next = list[at + 1]
      const facts = [
        detail.status,
        formatTime(Date.parse(detail.ts), now),
        `client ${formatDuration(detail.duration_ms)}`,
        ...(own?.total_duration_ms !== undefined ? [`server ${formatDuration(own.total_duration_ms)}`] : []),
        ...(own?.read_bytes !== undefined ? [`${formatBytes(own.read_bytes)} read`] : []),
        ...((own?.produced_rows ?? detail.row_count) !== undefined ? [`${(own?.produced_rows ?? detail.row_count)!.toLocaleString('en-US')} rows`] : []),
      ].join(' · ')
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1}>
            <Button key="back" hotkey="b" autoFocus onPress={toList}>
              Back
            </Button>
            {at > 0 && (
              <Button key="prev" hotkey="k" dimColor onPress={run(() => update($, paneView, (): DbxPaneView => ({ kind: 'detail', id: list[at - 1]!.id })))}>
                Prev
              </Button>
            )}
            {next !== undefined && (
              <Button key="next" hotkey="j" dimColor onPress={run(() => update($, paneView, (): DbxPaneView => ({ kind: 'detail', id: next.id })))}>
                Next
              </Button>
            )}
            <Button key="page" hotkey="o" dimColor onPress={openPageNow}>
              Page
            </Button>
          </Box>
          <Box flexDirection="column">
            <Text>
              <Text color={color} bold>
                {glyph} {kind === 'prod-write' ? 'PROD WRITE' : kind}
              </Text>
              <Text dimColor> · {facts}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">
              {detail.tool}
              {statementId !== undefined ? ` · statement ${statementId}` : ''}
            </Text>
            {statementId !== undefined && queryLink(cfg.links, statementId) !== undefined && link(queryLink(cfg.links, statementId), 'Open query profile ↗')}
          </Box>
          <Code source={text} language={detail.event_type === 'query' || detail.event_type === 'blocked' ? 'sql' : 'bash'} wrap="wrap" />
          {detail.block_reason !== undefined && <Text color="warning">⊘ {detail.block_reason}</Text>}
          {(own?.error_message ?? detail.error) !== undefined && <Text color="error">✗ {own?.error_message ?? detail.error}</Text>}
          {detail.tables_read.length + detail.tables_written.length > 0 && (
            <Box flexDirection="column">
              <Text bold>Tables</Text>
              {detail.tables_written.map(t => (
                <Text>
                  <Text color={tableColor(t, true)}>✎ </Text>
                  {link(tableLink(cfg.links, t), t, tableColor(t, true))}
                  <Text dimColor>{detail.status === 'blocked' ? ' (attempted)' : ' written'}</Text>
                </Text>
              ))}
              {detail.tables_read
                .filter(t => !detail.tables_written.includes(t))
                .map(t => (
                  <Text>
                    <Text dimColor>◇ </Text>
                    {link(tableLink(cfg.links, t), t, tableColor(t, false))}
                    <Text dimColor> read</Text>
                  </Text>
                ))}
            </Box>
          )}
          {detail.event_type !== 'query' && history.length > 0 && (
            <Box flexDirection="column">
              <Text bold>
                {history.length} statement{history.length === 1 ? '' : 's'} inferred from this run’s window
              </Text>
              {history.map(r => (
                <Box flexDirection="column">
                  <Text wrap="truncate-end">
                    <Text color={r.execution_status === 'FAILED' ? 'error' : 'success'}>{r.execution_status === 'FAILED' ? '✗' : '✓'} </Text>
                    {truncate(preview(r.statement_text ?? r.statement_id, width - 4), width - 4)}
                  </Text>
                  <Text dimColor>
                    {'  '}
                    {formatDuration(r.total_duration_ms)} · {formatBytes(r.read_bytes)} · {r.produced_rows ?? '–'} rows · {r.client_application ?? 'unknown client'}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
          {detail.status === 'blocked' && (
            <Text dimColor wrap="truncate-end">
              Next: {next === undefined ? 'nothing on Databricks' : `${kindOf(next, cfg.prod)} · ${preview(next.sql_text ?? next.command ?? '', width - 20)}`}
            </Text>
          )}
          <Text dimColor>b back · k/j previous/next · o page · Esc to the prompt</Text>
        </Box>
      )
    }

    // --- The whole trace ----------------------------------------------------------------
    const t = totals(list, enriched, cfg.prod)
    const sessionId = await $.session.id()
    const guards = list.filter(x => x.status === 'blocked' || kindOf(x, cfg.prod) === 'prod-write')
    const groups = tableGroups(list, cfg.prod, cfg.dev)
    const newest = [...list].reverse()
    const catalogWidth = Math.max(8, ...groups.map(g => g.catalog.length)) + 1
    const nameWidth = Math.min(48, Math.max(12, ...groups.flatMap(g => g.tables.map(u => u.name.length - g.catalog.length - 1))))
    const timeline =
      e.surface === 'terminal' ? (
        (() => {
          const { Raster } = $.ui.resolve(e)
          return <Raster key="timeline" columns={Math.min(512, width)} rows={1} cells={timelineCells(list, cfg.prod, Math.min(512, width))} />
        })()
      ) : (
        (() => {
          const ui = $.ui.resolve(e)
          return 'Svg' in ui ? (
            <ui.Svg source={timelineSvg(list, cfg.prod, width * 8)} alt={`Timeline of ${list.length} Databricks actions`} />
          ) : (
            <Text dimColor>{list.length} actions over time</Text>
          )
        })()
      )
    const historyLine =
      enriched.error !== undefined
        ? { color: 'warning', text: `query history unavailable: ${enriched.error}` }
        : enriched.fetched_at === 0
          ? { color: undefined, text: 'query history: not read yet (end of turn, or r)' }
          : { color: undefined, text: `query history read ${formatTime(enriched.fetched_at, now)} · ${t.statements} statements matched` }

    const columnsHead = 'time · client · server · read'
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>Databricks</Text>
          <Text dimColor>
            {' '}
            · {t.actions} action{t.actions === 1 ? '' : 's'} · {t.queries} quer{t.queries === 1 ? 'y' : 'ies'}
          </Text>
          {t.failed > 0 && <Text color="error"> · {t.failed} failed</Text>}
          {t.blocked > 0 && <Text color="warning"> · {t.blocked} blocked</Text>}
          {t.prodWrites > 0 ? (
            <Text color="error" bold>
              {' '}
              · {t.prodWrites} PROD WRITE{t.prodWrites === 1 ? '' : 'S'}
            </Text>
          ) : (
            <Text dimColor> · no prod writes</Text>
          )}
          {t.readBytes !== undefined && <Text dimColor> · {formatBytes(t.readBytes)} read</Text>}
          {t.serverMs !== undefined && <Text dimColor> · {formatDuration(t.serverMs)} server</Text>}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text wrap="truncate-end" {...(historyLine.color !== undefined ? { color: historyLine.color } : { dimColor: true })}>
            session {sessionId.slice(0, 8)}
            {branch !== undefined ? ` · ${branch}` : ''} · {historyLine.text}
          </Text>
          <Button key="refresh" hotkey="r" dimColor onPress={refresh}>
            Refresh
          </Button>
          <Button key="page" hotkey="o" dimColor onPress={openPageNow}>
            Page
          </Button>
        </Box>
        {timeline}
        <Text>
          <Text color={KIND_COLOR.read}>■ read </Text>
          <Text color={KIND_COLOR.write}>■ write </Text>
          <Text color={KIND_COLOR['prod-write']}>■ prod write </Text>
          <Text color={KIND_COLOR.script}>■ script </Text>
          <Text color={KIND_COLOR.failed}>■ failed </Text>
          <Text color={KIND_COLOR.blocked}>■ blocked</Text>
        </Text>
        {guards.length > 0 && <Text bold>Guardrails</Text>}
        {guards.map(g => (
          <Button
            key={`guard-${g.id}`}
            plain
            onPress={run(() => showAction($, g.id))}
            label={truncate(
              `${g.status === 'blocked' ? '⊘ blocked' : '✎ PROD WRITE'}  ${formatTime(Date.parse(g.ts), now)}  ${preview(g.sql_text ?? g.command ?? '', width)}${g.block_reason !== undefined ? `  — ${g.block_reason}` : ''}`,
              width,
            )}
          />
        ))}
        <Text>
          <Text bold>Actions</Text>
          <Text dimColor> newest first · {columnsHead}</Text>
        </Text>
        {newest.map((ev, i) => {
          const { glyph, color } = glyphOf(ev)
          const history = rowsFor(enriched, ev.id)
          const server = history.length === 0 ? undefined : history.reduce((n, r) => n + (r.total_duration_ms ?? 0), 0)
          const bytes = history.length === 0 ? undefined : history.reduce((n, r) => n + (r.read_bytes ?? 0), 0)
          const stats = `${(ev.status === 'running' ? 'running' : formatDuration(ev.duration_ms)).padStart(7)} ${formatDuration(server).padStart(7)} ${formatBytes(bytes).padStart(9)}`
          const head = `${formatTime(Date.parse(ev.ts), now).padEnd(8)} ${stats}  `
          const room = Math.max(10, width - head.length - 3)
          return (
            <Box key={`row-${ev.id}`} flexDirection="row">
              <Text color={color}>{glyph} </Text>
              <Button
                key={`open-${ev.id}`}
                plain
                {...(i === 0 ? { autoFocus: true as const } : {})}
                onPress={run(() => showAction($, ev.id))}
                label={`${head}${truncate(preview(ev.sql_text ?? ev.command ?? '', room), room)}`}
              />
            </Box>
          )
        })}
        {groups.length > 0 && <Text bold>Tables touched</Text>}
        {groups.flatMap(g =>
          g.tables.map((u, i) => {
            const short = u.name.slice(g.catalog.length + 1) || u.name
            return (
              <Text>
                <Text color={g.cls === 'prod' ? 'error' : g.cls === 'dev' ? 'success' : 'inactive'} bold>
                  {(i === 0 ? g.catalog : '').padEnd(catalogWidth)}
                </Text>
                <Text {...(u.writes > 0 ? { color: g.cls === 'prod' ? 'error' : 'success' } : { dimColor: true })}>{u.writes > 0 ? ' ✎ ' : ' ◇ '}</Text>
                {link(tableLink(cfg.links, u.name), short.padEnd(nameWidth))}
                <Text dimColor>
                  {u.reads > 0 ? ` read ×${u.reads}` : ''}
                  {u.writes > 0 ? ` written ×${u.writes}` : ''}
                </Text>
              </Text>
            )
          }),
        )}
        <Text dimColor>ctrl+x tab to focus · ↑↓ Enter open an action · r refresh history · o page</Text>
      </Box>
    )
  })
}
