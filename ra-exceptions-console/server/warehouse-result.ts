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
// empty exception queue. This helper reads the real location and returns a
// positional `unknown[][]` (column order preserved from the object insertion
// order, which matches the SELECT) so existing `row[0]`-style parsing works.
// It also tolerates the raw 2-D (`data_array`) and legacy nested (`result.*`)
// shapes defensively.
export interface WarehouseResult {
  data?: Record<string, unknown>[];
  data_array?: unknown[][];
  result?: {
    data?: Record<string, unknown>[];
    data_array?: unknown[][];
  };
}

export function resultRows(res: WarehouseResult | null | undefined): unknown[][] {
  if (!res) return [];
  if (Array.isArray(res.data)) return res.data.map((row) => Object.values(row));
  if (Array.isArray(res.data_array)) return res.data_array;
  const r = res.result;
  if (r && Array.isArray(r.data)) return r.data.map((row) => Object.values(row));
  if (r && Array.isArray(r.data_array)) return r.data_array;
  return [];
}
