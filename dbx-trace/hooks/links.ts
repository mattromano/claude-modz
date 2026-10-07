// Every Databricks deep link comes from here, so a URL pattern is fixed in one place.
// Patterns to verify against the workspace are listed in the README.

export type LinkConfig = { host: string; workspaceId: string }

const withWorkspace = (url: string, cfg: LinkConfig): string =>
  cfg.workspaceId === '' ? url : `${url}${url.includes('?') ? '&' : '?'}o=${encodeURIComponent(cfg.workspaceId)}`

const base = (cfg: LinkConfig): string | undefined => {
  const host = cfg.host.trim().replace(/\/+$/, '')
  if (host === '') return undefined
  return /^https?:\/\//.test(host) ? host : `https://${host}`
}

const make = (cfg: LinkConfig, path: string): string | undefined => {
  const root = base(cfg)
  return root === undefined ? undefined : withWorkspace(`${root}${path}`, cfg)
}

/** Catalog Explorer for a fully qualified table; undefined for a name without catalog and schema. */
export const tableLink = (cfg: LinkConfig, table: string): string | undefined => {
  const parts = table.split('.')
  if (parts.length !== 3) return undefined
  return make(cfg, `/explore/data/${parts.map(encodeURIComponent).join('/')}`)
}

/** Query history, opened on the statement (its profile is a click from there). */
export const queryLink = (cfg: LinkConfig, statementId: string): string | undefined =>
  make(cfg, `/sql/history?queryId=${encodeURIComponent(statementId)}`)

export const warehouseLink = (cfg: LinkConfig, warehouseId: string): string | undefined =>
  make(cfg, `/sql/warehouses/${encodeURIComponent(warehouseId)}`)

export const jobRunLink = (cfg: LinkConfig, jobId: string, runId: string): string | undefined =>
  make(cfg, `/jobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}`)
