// Normalizes @databricks/appkit `analytics.query()` results to positional rows.
//
// appkit 0.57 resolves query() to a paginated CHUNK object whose rows are at the
// TOP LEVEL under `data`, as an array of column-keyed row objects:
//   { chunk_index, row_offset, row_count, data: [ { col: value, ... }, ... ] }
// (Confirmed from the running app: a COUNT query returns
//  {"row_count":1,"data":[{"open_exceptions":"48414","total_at_risk":"6.02E8",...}]}.)
//
// The original server routes read top-level `data_array`, which does not exist on
// this shape, so every server-side query resolved to [] — hence $0 KPIs and an
// empty exception queue. `resultObjects()` reads the real location and returns
// the rows as column-keyed objects so callers read values BY COLUMN NAME, not
// by SELECT position — a positional read silently shifts every value if the
// warehouse ever returns columns in a different order. Keys are lowercased so a
// read never depends on how the layer cases identifiers either. It also
// tolerates the legacy nested (`result.data`) shape defensively.
export interface WarehouseResult {
  data?: Record<string, unknown>[];
  data_array?: unknown[][];
  result?: {
    data?: Record<string, unknown>[];
    data_array?: unknown[][];
  };
}

export function resultObjects(res: WarehouseResult | null | undefined): Record<string, unknown>[] {
  if (!res) return [];
  const rows = Array.isArray(res.data)
    ? res.data
    : res.result && Array.isArray(res.result.data)
      ? res.result.data
      : null;
  if (!rows) return [];
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[key.toLowerCase()] = value;
    return out;
  });
}
