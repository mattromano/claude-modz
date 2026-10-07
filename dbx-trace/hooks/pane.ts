// Pure pieces of the in-Claude-Code panel: the timeline (terminal cells or desktop SVG) and
// the tables-touched groups. Drawing with $ stays in register.tsx.
import type { DbxEvent } from '../types'
import type { Kind } from './html'
import { kindOf } from './html'
import { catalogOf, classify } from './sql'
import type { CatalogClass } from './sql'

export const KIND_RGB: Record<Kind, number> = {
  read: 0x9ca3af,
  write: 0x22c55e,
  'prod-write': 0xef4444,
  script: 0x60a5fa,
  failed: 0xa78bfa,
  blocked: 0xf59e0b,
}
const AXIS_RGB = 0x57534e
const DEFAULT_COLOR = 0x01000000

/** Theme color names for Text, per kind. */
export const KIND_COLOR: Record<Kind, string> = {
  read: 'inactive',
  write: 'success',
  'prod-write': 'error',
  script: 'suggestion',
  failed: 'error',
  blocked: 'warning',
}

type Span = { kind: Kind; from: number; to: number }

const spans = (events: readonly DbxEvent[], prod: readonly string[], width: number): Span[] => {
  if (events.length === 0 || width < 2) return []
  const lo = Math.min(...events.map(e => Date.parse(e.ts)))
  const hi = Math.max(...events.map(e => Date.parse(e.ended_ts ?? e.ts)))
  const span = Math.max(1, hi - lo)
  const at = (ms: number) => Math.min(width - 1, Math.max(0, Math.round(((ms - lo) / span) * (width - 1))))
  return events.map(e => {
    const from = at(Date.parse(e.ts))
    return { kind: kindOf(e, prod), from, to: Math.max(from, at(Date.parse(e.ended_ts ?? e.ts))) }
  })
}

// Later kinds paint over earlier ones where cells collide: a block or prod write is never hidden.
const PAINT_ORDER: Kind[] = ['read', 'script', 'write', 'failed', 'blocked', 'prod-write']

/** One row of terminal cells: an axis with each action painted where it ran. */
export const timelineCells = (events: readonly DbxEvent[], prod: readonly string[], columns: number): string => {
  const width = Math.max(1, Math.min(512, columns))
  const words = new Uint32Array(width * 3)
  for (let i = 0; i < width; i++) words.set([0x2500, AXIS_RGB, DEFAULT_COLOR], i * 3)
  const ordered = [...spans(events, prod, width)].sort((a, b) => PAINT_ORDER.indexOf(a.kind) - PAINT_ORDER.indexOf(b.kind))
  for (const s of ordered) for (let i = s.from; i <= s.to; i++) words.set([0x2588, KIND_RGB[s.kind], DEFAULT_COLOR], i * 3)
  return toBase64(new Uint8Array(words.buffer))
}

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`

/** The same timeline as SVG, for surfaces that draw SVG (the desktop app). */
export const timelineSvg = (events: readonly DbxEvent[], prod: readonly string[], width: number): string => {
  const w = Math.max(100, Math.round(width))
  const marks = spans(events, prod, w - 8)
    .map(s => `<rect x="${s.from + 4}" y="4" width="${Math.max(3, s.to - s.from)}" height="16" rx="2" fill="${hex(KIND_RGB[s.kind])}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 24" width="${w}" height="24"><line x1="4" y1="12" x2="${w - 4}" y2="12" stroke="${hex(AXIS_RGB)}" stroke-width="1"/>${marks}</svg>`
}

export type TableUse = { name: string; reads: number; writes: number }
export type CatalogGroup = { catalog: string; cls: CatalogClass; tables: TableUse[] }

/** Tables the session read or wrote (blocked statements left out), grouped by catalog, prod first. */
export const tableGroups = (events: readonly DbxEvent[], prod: readonly string[], dev: readonly string[]): CatalogGroup[] => {
  const uses = new Map<string, TableUse>()
  const use = (name: string) => uses.get(name) ?? uses.set(name, { name, reads: 0, writes: 0 }).get(name)!
  for (const e of events) {
    if (e.status === 'blocked') continue
    for (const t of e.tables_read) use(t).reads++
    for (const t of e.tables_written) use(t).writes++
  }
  const groups = new Map<string, CatalogGroup>()
  for (const u of uses.values()) {
    const catalog = catalogOf(u.name) ?? '(unqualified)'
    const group = groups.get(catalog) ?? groups.set(catalog, { catalog, cls: classify(u.name, prod, dev), tables: [] }).get(catalog)!
    group.tables.push(u)
  }
  const rank: Record<CatalogClass, number> = { prod: 0, dev: 1, other: 2 }
  return [...groups.values()]
    .sort((a, b) => rank[a.cls] - rank[b.cls] || a.catalog.localeCompare(b.catalog))
    .map(g => ({ ...g, tables: g.tables.sort((a, b) => b.writes - a.writes || a.name.localeCompare(b.name)) }))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64; written out so it does not lean on a runtime's Uint8Array.toBase64. */
export const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : B64[c & 63]
  }
  return out
}
