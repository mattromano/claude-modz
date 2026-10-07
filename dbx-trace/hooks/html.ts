import type { DbxEnrichment, DbxEvent } from '../types'
import { rowsFor } from './enrich'
import { formatBytes, formatDuration } from './events'
import type { LinkConfig } from './links'
import { queryLink, tableLink, warehouseLink } from './links'
import { catalogOf, classify, preview } from './sql'

export type Report = { title: string; path: string; kind?: string }

export type PageInput = {
  sessionId: string
  branch?: string
  cwd: string
  generatedAt: number
  events: readonly DbxEvent[]
  enrichment: DbxEnrichment
  reports: readonly Report[]
  links: LinkConfig
  prod: readonly string[]
  dev: readonly string[]
}

export type Kind = 'read' | 'write' | 'prod-write' | 'script' | 'blocked' | 'failed'

/** What an event looks like everywhere: prod writes outrank everything but a block. */
export const kindOf = (e: DbxEvent, prod: readonly string[]): Kind => {
  if (e.status === 'blocked') return 'blocked'
  if (e.tables_written.some(t => classify(t, prod, []) === 'prod')) return 'prod-write'
  if (e.status === 'failed') return 'failed'
  if (e.event_type === 'script' || e.event_type === 'cli') return 'script'
  return e.tables_written.length > 0 ? 'write' : 'read'
}

const KIND_LABEL: Record<Kind, string> = {
  read: 'read',
  write: 'write',
  'prod-write': 'PROD WRITE',
  script: 'script',
  blocked: 'blocked',
  failed: 'failed',
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const a = (href: string | undefined, text: string, cls = ''): string =>
  href === undefined
    ? `<span class="${cls}">${esc(text)}</span>`
    : `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`

// The catalog is the chip's color; the label is schema.table, the full name on hover.
const tableChip = (input: PageInput, table: string, written: boolean): string => {
  const cls = classify(table, input.prod, input.dev)
  const label = table.split('.').length === 3 ? table.slice(table.indexOf('.') + 1) : table
  const href = tableLink(input.links, table)
  const attrs = `class="chip ${cls}${written ? ' w' : ''}" title="${esc(table)}"`
  return href === undefined ? `<span ${attrs}>${esc(label)}</span>` : `<a ${attrs} href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`
}

/** Totals the header and the band share. */
export const totals = (events: readonly DbxEvent[], enrichment: DbxEnrichment, prod: readonly string[]) => {
  const rows = events.flatMap(e => rowsFor(enrichment, e.id))
  const sum = (f: (r: (typeof rows)[number]) => number | undefined) =>
    rows.length === 0 ? undefined : rows.reduce((n, r) => n + (f(r) ?? 0), 0)
  return {
    actions: events.length,
    queries: events.filter(e => e.event_type === 'query' && e.status !== 'blocked').length,
    statements: rows.length,
    failed: events.filter(e => e.status === 'failed').length,
    blocked: events.filter(e => e.status === 'blocked').length,
    prodWrites: events.filter(e => kindOf(e, prod) === 'prod-write').length,
    readBytes: sum(r => r.read_bytes),
    serverMs: sum(r => r.total_duration_ms),
  }
}

const timeOf = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour12: false })
}

// --- Panels ------------------------------------------------------------------------------

const header = (input: PageInput): string => {
  const t = totals(input.events, input.enrichment, input.prod)
  const catalogs = [
    ...new Set(input.events.flatMap(e => [...e.tables_read, ...e.tables_written]).flatMap(n => catalogOf(n) ?? [])),
  ].sort()
  const warehouses = [
    ...new Set([
      ...input.events.flatMap(e => e.warehouse_id ?? []),
      ...input.enrichment.rows.flatMap(r => r.warehouse_id ?? []),
    ]),
  ]
  const tile = (label: string, value: string, cls = '') =>
    `<div class="tile ${cls}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`
  const e = input.enrichment
  const enrichLine =
    e.error !== undefined
      ? `<p class="note warn">Query history unavailable: ${esc(e.error)}</p>`
      : e.fetched_at === 0
        ? `<p class="note">Query history not read yet; server-side numbers fill in at the end of a turn.</p>`
        : `<p class="note">Query history read ${esc(new Date(e.fetched_at).toLocaleTimeString('en-US', { hour12: false }))} · ${t.statements} statements matched.</p>`
  return `
<header>
  <div class="title">
    <h1>Databricks trace</h1>
    <div class="meta">
      <span>session <code>${esc(input.sessionId)}</code></span>
      ${input.branch ? `<span>branch <code>${esc(input.branch)}</code></span>` : ''}
      <span>${esc(input.cwd)}</span>
      <span>updated ${esc(new Date(input.generatedAt).toLocaleString('en-US', { hour12: false }))}</span>
    </div>
    <div class="meta">
      ${catalogs.map(c => `<span class="chip ${classify(`${c}.x.y`, input.prod, input.dev)}">${esc(c)}</span>`).join('')}
      ${warehouses.map(w => a(warehouseLink(input.links, w), `warehouse ${w}`, 'chip other')).join('')}
    </div>
  </div>
  <div class="tiles">
    ${tile('actions', String(t.actions))}
    ${tile('queries', String(t.queries))}
    ${tile('failed', String(t.failed), t.failed > 0 ? 'bad' : '')}
    ${tile('blocked', String(t.blocked), t.blocked > 0 ? 'warnt' : '')}
    ${tile('prod writes', String(t.prodWrites), t.prodWrites > 0 ? 'prod' : '')}
    ${tile('bytes read', formatBytes(t.readBytes))}
    ${tile('server time', formatDuration(t.serverMs))}
  </div>
  ${enrichLine}
</header>`
}

const timeline = (input: PageInput): string => {
  if (input.events.length === 0) return ''
  const times = input.events.map(e => Date.parse(e.ts))
  const lo = Math.min(...times)
  const hi = Math.max(...input.events.map(e => Date.parse(e.ended_ts ?? e.ts)))
  const span = Math.max(1, hi - lo)
  const x = (ms: number) => 10 + ((ms - lo) / span) * 980
  const marks = input.events
    .map(e => {
      const kind = kindOf(e, input.prod)
      const x0 = x(Date.parse(e.ts))
      const x1 = Math.max(x0 + 4, x(Date.parse(e.ended_ts ?? e.ts)))
      const tip = `${timeOf(e.ts)} ${KIND_LABEL[kind]} ${preview(e.sql_text ?? e.command ?? '', 80)}`
      return `<a href="#ev-${esc(e.id)}"><rect class="k-${kind}" x="${x0.toFixed(1)}" y="8" width="${(x1 - x0).toFixed(1)}" height="24" rx="2"><title>${esc(tip)}</title></rect></a>`
    })
    .join('')
  return `
<section>
  <h2>Timeline</h2>
  <svg class="timeline" viewBox="0 0 1000 40" preserveAspectRatio="none" role="img" aria-label="Actions over time">
    <line x1="10" y1="20" x2="990" y2="20" class="axis"/>${marks}
  </svg>
  <div class="axis-labels"><span>${esc(timeOf(new Date(lo).toISOString()))}</span><span>${esc(timeOf(new Date(hi).toISOString()))}</span></div>
  <div class="legend">${(['read', 'write', 'prod-write', 'script', 'failed', 'blocked'] as const)
    .map(k => `<span><i class="sw k-${k}"></i>${KIND_LABEL[k]}</span>`)
    .join('')}</div>
</section>`
}

const queryTable = (input: PageInput): string => {
  const catalogs = new Set<string>()
  const rows = input.events
    .map((e, i) => {
      const kind = kindOf(e, input.prod)
      const history = rowsFor(input.enrichment, e.id)
      const own = history.length === 1 && history[0]!.how !== 'window' ? history[0] : undefined
      const tables = [...e.tables_written.map(t => tableChip(input, t, true)), ...e.tables_read.filter(t => !e.tables_written.includes(t)).map(t => tableChip(input, t, false))]
      const rowCatalogs = [...e.tables_read, ...e.tables_written].flatMap(t => catalogOf(t) ?? [])
      for (const c of rowCatalogs) catalogs.add(c)
      const statementId = e.statement_id ?? own?.statement_id
      const text = e.sql_text ?? e.command ?? ''
      const inferred =
        e.event_type === 'query' || history.length === 0
          ? ''
          : `<div class="inferred"><div class="sub">${history.length} statement${history.length === 1 ? '' : 's'} inferred from this run's window</div>
              <table class="mini"><tbody>${history
                .map(
                  r => `<tr><td>${a(queryLink(input.links, r.statement_id), preview(r.statement_text ?? r.statement_id, 90), 'mono')}
                    ${r.client_application ? `<div class="sub">${esc(r.client_application)}</div>` : ''}</td>
                    <td>${esc(r.execution_status ?? '')}</td><td class="num">${esc(formatDuration(r.total_duration_ms))}</td>
                    <td class="num">${esc(r.produced_rows === undefined ? '–' : String(r.produced_rows))}</td><td class="num">${esc(formatBytes(r.read_bytes))}</td></tr>`,
                )
                .join('')}</tbody></table></div>`
      const serverMs = own?.total_duration_ms ?? (history.length > 0 ? history.reduce((n, r) => n + (r.total_duration_ms ?? 0), 0) : undefined)
      const rowsOut = own?.produced_rows ?? e.row_count
      const bytes = history.length > 0 ? history.reduce((n, r) => n + (r.read_bytes ?? 0), 0) : undefined
      const status = e.status === 'running' ? 'running' : e.status
      const error = own?.error_message ?? e.error
      return `
<tr id="ev-${esc(e.id)}" class="r-${kind}" data-status="${status}" data-kind="${kind}" data-catalogs="${esc(rowCatalogs.join(' '))}"
    data-i="${i}" data-dur="${e.duration_ms ?? -1}" data-server="${serverMs ?? -1}" data-rows="${rowsOut ?? -1}" data-bytes="${bytes ?? -1}" data-text="${esc(text.toLowerCase())}">
  <td class="num">${i + 1}</td>
  <td class="mono">${esc(timeOf(e.ts))}</td>
  <td><span class="badge k-${kind}">${KIND_LABEL[kind]}</span></td>
  <td class="status s-${status}">${esc(status)}</td>
  <td class="sql"><details><summary class="mono">${esc(preview(text, 110) || '(empty)')}</summary><pre>${esc(text)}</pre>
    ${e.block_reason !== undefined ? `<div class="reason">${esc(e.block_reason)}</div>` : ''}
    ${error !== undefined && e.status !== 'blocked' ? `<div class="reason">${esc(error)}</div>` : ''}
    <div class="sub">${esc(e.tool)}</div></details>${inferred}</td>
  <td class="tables">${tables.join(' ')}</td>
  <td class="num">${esc(formatDuration(e.duration_ms))}</td>
  <td class="num">${esc(formatDuration(serverMs))}</td>
  <td class="num">${esc(rowsOut === undefined ? '–' : rowsOut.toLocaleString('en-US'))}</td>
  <td class="num">${esc(formatBytes(bytes))}</td>
  <td>${statementId !== undefined ? a(queryLink(input.links, statementId), 'profile', 'link') : ''}</td>
</tr>`
    })
    .join('')
  const options = (values: readonly string[]) => values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')
  return `
<section>
  <h2>Actions</h2>
  <div class="filters">
    <input id="f-text" type="search" placeholder="Filter SQL or command" aria-label="Filter text">
    <select id="f-status" aria-label="Status"><option value="">any status</option>${options(['succeeded', 'failed', 'blocked', 'running'])}</select>
    <select id="f-kind" aria-label="Kind"><option value="">any kind</option>${options(['read', 'write', 'prod-write', 'script', 'failed', 'blocked'])}</select>
    <select id="f-catalog" aria-label="Catalog"><option value="">any catalog</option>${options([...catalogs].sort())}</select>
    <label>min <input id="f-dur" type="number" min="0" step="0.5" value="0" aria-label="Minimum seconds"> s</label>
    <span id="f-count" class="dim"></span>
  </div>
  <div class="scroll">
  <table id="actions">
    <thead><tr>
      <th data-sort="i" class="num">#</th><th data-sort="i">time</th><th data-sort="kind">kind</th><th data-sort="status">status</th>
      <th>statement</th><th>tables</th><th data-sort="dur" class="num">client</th><th data-sort="server" class="num">server</th>
      <th data-sort="rows" class="num">rows</th><th data-sort="bytes" class="num">read</th><th></th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="11" class="empty">No Databricks actions yet.</td></tr>'}</tbody>
  </table>
  </div>
</section>`
}

const graph = (input: PageInput): string => {
  // A blocked statement touched nothing: its tables stay off the graph (the guardrail panel has it).
  const ran = input.events.filter(e => e.status !== 'blocked')
  const written = new Set(ran.flatMap(e => e.tables_written))
  const readOnly = [...new Set(ran.flatMap(e => e.tables_read))].filter(t => !written.has(t))
  const order = (list: string[]) => list.sort((p, q) => (catalogOf(p) ?? '~').localeCompare(catalogOf(q) ?? '~') || p.localeCompare(q))
  const left = order(readOnly)
  const right = order([...written])
  if (left.length === 0 && right.length === 0) return ''
  const ROW = 34
  const height = Math.max(left.length, right.length, 1) * ROW + 30
  const center = height / 2
  const node = (t: string, x: number, y: number, isWrite: boolean) => {
    const cls = classify(t, input.prod, input.dev)
    const label = t.length > 40 ? `…${t.slice(-39)}` : t
    const href = tableLink(input.links, t)
    const body = `<rect class="node ${cls}${isWrite ? ' w' : ''}" x="${x}" y="${y - 12}" width="300" height="24" rx="4"/><text x="${x + 10}" y="${y + 4}">${esc(label)}</text><title>${esc(t)}</title>`
    return href === undefined ? `<g>${body}</g>` : `<a href="${esc(href)}" target="_blank" rel="noopener">${body}</a>`
  }
  const y = (i: number, n: number) => center - ((n - 1) * ROW) / 2 + i * ROW
  const edges = [
    ...left.map((t, i) => `<path class="edge read" d="M310 ${y(i, left.length)} C 420 ${y(i, left.length)}, 420 ${center}, 480 ${center}"/>`),
    ...right.map(
      (t, i) =>
        `<path class="edge ${classify(t, input.prod, input.dev)} w" d="M600 ${center} C 660 ${center}, 660 ${y(i, right.length)}, 770 ${y(i, right.length)}" marker-end="url(#arrow-${classify(t, input.prod, input.dev)})"/>`,
    ),
  ].join('')
  const markers = (['prod', 'dev', 'other'] as const)
    .map(c => `<marker id="arrow-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" class="ah ${c}"/></marker>`)
    .join('')
  return `
<section>
  <h2>Tables touched</h2>
  <div class="scroll">
  <svg class="graph" viewBox="0 0 1080 ${height}" width="1080" height="${height}" role="img" aria-label="Tables read and written">
    <defs>${markers}</defs>${edges}
    ${left.map((t, i) => node(t, 10, y(i, left.length), false)).join('')}
    <rect class="session" x="480" y="${center - 16}" width="120" height="32" rx="16"/><text class="session-t" x="540" y="${center + 5}" text-anchor="middle">this session</text>
    ${right.map((t, i) => node(t, 770, y(i, right.length), true)).join('')}
    ${left.length > 0 ? `<text class="col" x="10" y="14">read</text>` : ''}${right.length > 0 ? `<text class="col" x="770" y="14">written</text>` : ''}
  </svg>
  </div>
  <div class="legend"><span><i class="sw node-prod"></i>${esc(input.prod.join(', ') || 'prod')}</span><span><i class="sw node-dev"></i>${esc(input.dev.join(', ') || 'dev')}</span><span><i class="sw node-other"></i>other</span></div>
</section>`
}

const guardrails = (input: PageInput): string => {
  const blocked = input.events.filter(e => e.status === 'blocked')
  const prodWrites = input.events.filter(e => e.status !== 'blocked' && kindOf(e, input.prod) === 'prod-write')
  if (blocked.length === 0 && prodWrites.length === 0) {
    return `<section><h2>Guardrails</h2><p class="note">Nothing blocked, no writes to ${esc(input.prod.join(', ') || 'prod')}.</p></section>`
  }
  const after = (e: DbxEvent) => input.events.slice(input.events.indexOf(e) + 1)[0]
  const item = (e: DbxEvent, title: string, cls: string) => {
    const next = after(e)
    return `<li class="${cls}"><div class="gtitle">${esc(title)} · <a href="#ev-${esc(e.id)}">${esc(timeOf(e.ts))}</a></div>
      <pre>${esc(e.sql_text ?? e.command ?? '')}</pre>
      ${e.block_reason !== undefined ? `<div class="reason">${esc(e.block_reason)}</div>` : ''}
      <div class="sub">Next: ${next === undefined ? 'nothing on Databricks' : `<a href="#ev-${esc(next.id)}">${esc(KIND_LABEL[kindOf(next, input.prod)])} · ${esc(preview(next.sql_text ?? next.command ?? '', 90))}</a>`}</div></li>`
  }
  return `
<section>
  <h2>Guardrails</h2>
  <ul class="guard">${[...blocked.map(e => item(e, 'Blocked', 'blocked')), ...prodWrites.map(e => item(e, `Write to ${e.tables_written.filter(t => classify(t, input.prod, []) === 'prod').join(', ')}`, 'prod'))].join('')}</ul>
</section>`
}

const reports = (input: PageInput): string => `
<section>
  <h2>Reports</h2>
  ${
    input.reports.length === 0
      ? '<p class="note">No reports for this session yet.</p>'
      : `<ul class="reports">${input.reports.map(r => `<li>${a(r.path, r.title, 'link')}${r.kind ? ` <span class="dim">${esc(r.kind)}</span>` : ''}</li>`).join('')}</ul>`
  }
</section>`

// --- The page ------------------------------------------------------------------------------

const CSS = `
:root{--bg:#fafaf9;--panel:#fff;--ink:#1c1917;--dim:#78716c;--line:#e7e5e4;--accent:#2563eb;
--read:#a8a29e;--write:#16a34a;--prod:#dc2626;--prod-bg:#fef2f2;--script:#2563eb;--blocked:#d97706;--failed:#7c3aed;--code:#f5f5f4}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0c0a09;--panel:#1c1917;--ink:#f5f5f4;--dim:#a8a29e;--line:#292524;--accent:#60a5fa;
--read:#78716c;--write:#22c55e;--prod:#f87171;--prod-bg:#3b0d0d;--script:#60a5fa;--blocked:#fbbf24;--failed:#a78bfa;--code:#292524}}
:root[data-theme="dark"]{--bg:#0c0a09;--panel:#1c1917;--ink:#f5f5f4;--dim:#a8a29e;--line:#292524;--accent:#60a5fa;
--read:#78716c;--write:#22c55e;--prod:#f87171;--prod-bg:#3b0d0d;--script:#60a5fa;--blocked:#fbbf24;--failed:#a78bfa;--code:#292524}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1440px;margin:0 auto;padding:24px 16px 64px}
header .meta,ul.guard,.reason,.note{overflow-wrap:anywhere}section,header{min-width:0}
h1{font-size:22px;margin:0 0 6px}h2{font-size:15px;margin:0 0 12px;letter-spacing:.02em;text-transform:uppercase;color:var(--dim)}
section,header{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
code,.mono,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
pre{background:var(--code);padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-word;margin:8px 0}
a{color:var(--accent)}.dim,.sub{color:var(--dim)}.sub{font-size:12px}
.meta{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--dim);margin-bottom:6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:12px 0 4px}
.tile{border:1px solid var(--line);border-radius:8px;padding:8px 10px}.tile .v{font-size:20px;font-weight:600}.tile .l{color:var(--dim);font-size:12px}
.tile.bad .v{color:var(--failed)}.tile.warnt .v{color:var(--blocked)}.tile.prod{background:var(--prod-bg);border-color:var(--prod)}.tile.prod .v{color:var(--prod)}
.note{color:var(--dim);margin:8px 0 0}.note.warn{color:var(--blocked)}
.chip{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;font:12px ui-monospace,Menlo,monospace;margin:1px 0;text-decoration:none;color:var(--ink)}
.chip.prod{border-color:var(--prod);color:var(--prod)}.chip.prod.w{background:var(--prod);color:#fff;font-weight:600}
.chip.dev{border-color:var(--write);color:var(--write)}.chip.dev.w{background:var(--write);color:#fff}
.chip.other.w{border-color:var(--ink)}
.timeline{width:100%;height:40px;display:block}.axis{stroke:var(--line);stroke-width:1}
.axis-labels{display:flex;justify-content:space-between;color:var(--dim);font-size:12px}
.legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--dim);font-size:12px;margin-top:8px}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.k-read{fill:var(--read);background:var(--read)}.k-write{fill:var(--write);background:var(--write)}.k-prod-write{fill:var(--prod);background:var(--prod)}
.k-script{fill:var(--script);background:var(--script)}.k-blocked{fill:var(--blocked);background:var(--blocked)}.k-failed{fill:var(--failed);background:var(--failed)}
.badge{color:#fff;border-radius:4px;padding:1px 6px;font-size:11.5px;font-weight:600;white-space:nowrap}.badge.k-read{color:var(--panel)}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.filters input,.filters select{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font:inherit}
.filters input[type=number]{width:64px}.filters input[type=search]{min-width:220px;flex:1}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--dim);font-weight:600;white-space:nowrap;position:sticky;top:0;background:var(--panel)}
th[data-sort]{cursor:pointer}th[data-sort]:hover{color:var(--ink)}th.asc::after{content:" ▲"}th.desc::after{content:" ▼"}
td.num,th.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
td.sql{min-width:260px;max-width:420px}td.sql summary{cursor:pointer;word-break:break-word}
td.tables{min-width:180px}td.tables .chip{white-space:nowrap}
tr.r-prod-write{background:var(--prod-bg)}tr.r-prod-write td:first-child{box-shadow:inset 3px 0 var(--prod)}
tr.r-blocked td:first-child{box-shadow:inset 3px 0 var(--blocked)}
.s-failed{color:var(--failed);font-weight:600}.s-blocked{color:var(--blocked);font-weight:600}.s-running{color:var(--script)}
.reason{color:var(--blocked);font-size:12.5px;margin:4px 0}
.inferred{margin-top:6px}.mini td{padding:3px 6px;font-size:12px;border-bottom:1px dashed var(--line)}
.empty{color:var(--dim);text-align:center;padding:24px}
.graph text{font:12px ui-monospace,Menlo,monospace;fill:var(--ink)}.graph .col{fill:var(--dim);font:600 11px system-ui,sans-serif;text-transform:uppercase}
.node{fill:var(--panel);stroke:var(--read);stroke-width:1.5}.node.dev{stroke:var(--write)}.node.prod{stroke:var(--prod)}
.node.prod.w{fill:var(--prod-bg);stroke-width:2.5}
.edge{fill:none;stroke-width:1.5}.edge.read{stroke:var(--read)}.edge.dev{stroke:var(--write)}.edge.prod{stroke:var(--prod);stroke-width:2.5}.edge.other{stroke:var(--ink)}
.ah.dev{fill:var(--write)}.ah.prod{fill:var(--prod)}.ah.other{fill:var(--ink)}
.session{fill:var(--accent)}.graph .session-t{fill:#fff;font:600 12px system-ui,sans-serif}
.node-prod{background:var(--prod)}.node-dev{background:var(--write)}.node-other{background:var(--read)}
ul.guard,ul.reports{list-style:none;margin:0;padding:0}ul.guard li{border-left:3px solid var(--blocked);padding:4px 0 8px 12px;margin-bottom:10px}
ul.guard li.prod{border-color:var(--prod)}.gtitle{font-weight:600}
@media (max-width:640px){main{padding:16px 16px 48px}td.sql{min-width:240px}}
`

const SCRIPT = `
(() => {
  const tbody = document.querySelector('#actions tbody'); if (!tbody) return;
  const rows = [...tbody.querySelectorAll('tr[data-i]')];
  const $ = id => document.getElementById(id);
  const apply = () => {
    const text = $('f-text').value.toLowerCase(), status = $('f-status').value, kind = $('f-kind').value,
      cat = $('f-catalog').value, min = parseFloat($('f-dur').value || '0') * 1000;
    let shown = 0;
    for (const r of rows) {
      const ok = (!text || r.dataset.text.includes(text)) && (!status || r.dataset.status === status) &&
        (!kind || r.dataset.kind === kind) && (!cat || r.dataset.catalogs.split(' ').includes(cat)) &&
        (!min || Math.max(+r.dataset.dur, +r.dataset.server) >= min);
      r.hidden = !ok; if (ok) shown++;
    }
    $('f-count').textContent = shown + ' of ' + rows.length;
  };
  ['f-text','f-status','f-kind','f-catalog','f-dur'].forEach(id => $(id).addEventListener('input', apply));
  let key = 'i', dir = 1;
  document.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort; dir = k === key ? -dir : (k === 'i' ? 1 : -1); key = k;
    document.querySelectorAll('th').forEach(h => h.classList.remove('asc','desc'));
    th.classList.add(dir > 0 ? 'asc' : 'desc');
    const val = r => ['kind','status'].includes(k) ? r.dataset[k] : +r.dataset[k];
    rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    rows.forEach(r => tbody.appendChild(r));
  }));
  apply();
})();
`

/** The whole page: one file, no external assets, so it opens offline and attaches to a PR. */
export const renderPage = (input: PageInput): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Databricks trace</title>
<style>${CSS}</style>
</head>
<body>
<main>
${header(input)}
${timeline(input)}
${guardrails(input)}
${queryTable(input)}
${graph(input)}
${reports(input)}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`
