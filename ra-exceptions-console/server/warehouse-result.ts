// Normalizes @databricks/appkit `analytics.query()` results to positional rows.
//
// appkit 0.57's SQL connector returns the full statement response, and the rows
// live UNDER `result` — never at the top level:
//   • `result.data` — array of column-keyed row objects (the transformed shape
//     you get whenever the result set has rows + a manifest), or
//   • `result.data_array` — the raw 2-D array (empty / untransformed result sets).
// The server routes originally read top-level `warehouseResult.data_array`, which
// is always undefined, so every server-side query came back empty ($0 KPIs, empty
// queue). This helper reads the correct nested location and always hands back a
// positional `unknown[][]` so existing `row[0]`-style parsing keeps working.
export interface WarehouseResult {
  result?: {
    data_array?: unknown[][];
    data?: Record<string, unknown>[];
  };
  // Legacy / defensive: some shapes surface the raw array at the top level.
  data_array?: unknown[][];
}

export function resultRows(res: WarehouseResult | null | undefined): unknown[][] {
  const r = res?.result;
  if (r && Array.isArray(r.data_array)) return r.data_array;
  // Transformed objects preserve column order in insertion order, so Object.values
  // reproduces the SELECT's column positions.
  if (r && Array.isArray(r.data)) return r.data.map((row) => Object.values(row));
  if (res && Array.isArray(res.data_array)) return res.data_array;
  return [];
}
