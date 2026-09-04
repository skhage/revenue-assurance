# RA Demo — Model Governance via Unity (AI) Gateway

> **Scrutiny summary**
> - ✅ **2026-09-03:** New artifact. Documents how **every model the demo uses** is routed through
>   **Unity Gateway** (the Databricks governance layer for enterprise AI, built on Unity Catalog —
>   the feature formerly surfaced as "Mosaic AI Gateway"; see the
>   [AI Gateway docs](https://docs.databricks.com/aws/en/ai-gateway)). Records the **governance
>   matrix** (what is routed, what is governed-but-not-endpoint, and why), the concrete endpoints
>   created in the demo workspace, and the exact wiring. Grounds the `ra-llm-gateway` reference in
>   `reconciliation/pipelines/silver_doc_intelligence.sql`. Pairs with
>   [`12-domains-and-tags.md`](12-domains-and-tags.md) (UC governance context).

**Purpose.** Unity Gateway extends Unity Catalog governance to the *runtime* interactions between
models, agents, and tools: **usage tracking** (requests/tokens/latency in system tables), **rate
limits**, **payload logging** (request/response to UC Delta inference tables), **guardrails**
(content/PII policy), and **permissions** (grant/revoke via UC). It operates on **model serving
endpoints**. The demo's premise — reconciliation you can *trust and audit* — extends to the models:
every model call is governed, tracked, and traceable, not a black box.

---

## 1. The governance matrix

The demo uses several kinds of model. Not all can be *attached to a custom gateway endpoint* — two
are Databricks-managed primitives with no endpoint parameter, and one (`ai_forecast`) is a
statistical function, not a served model at all. The honest position: **route everything that can
be routed through a governed endpoint; document the rest as governed-by-UC with the reason.**

| Model / AI call | Where | Kind | Routing | Governance |
|---|---|---|---|---|
| **Contract + invoice term extraction** | `silver_doc_intelligence.sql` | LLM (structured extract) | ✅ **Routed** — `ai_query('ra-llm-gateway', …, responseFormat)` | Unity Gateway: usage tracking, rate limit, inference-table payload logging |
| **Isolation Forest anomaly** | `mlops/` | Custom sklearn, UC-registered | ✅ **Served** — endpoint `ra-anomaly-gateway` (batch scoring kept as the pipeline path) | Unity Gateway on the endpoint + UC model registry (versions, `@champion` alias, lineage) |
| **`ai_parse_document`** (PDF OCR/layout) | `silver_doc_intelligence.sql` | Databricks-managed doc model | ⚠️ **Not endpoint-routable** — no endpoint parameter | UC data/function permissions on the call; the *extraction* step it feeds **is** gatewayed |
| **`ai_forecast`** (revenue time-series) | `warehouse/gold_revenue_forecast_anomalies.sql` | Statistical forecaster | ❌ **N/A** — not a served model / no endpoint | UC permissions on the SQL + source tables |
| **Genie SQL generation** | Genie space / in-app Ask tab | Databricks-managed Genie model | ⚠️ **Not user-pointable** at a custom endpoint | UC data permissions + Genie space `CAN_RUN`; queries are governed at the data layer |

**Why `ai_extract` → `ai_query`.** `ai_extract` uses an *implicit*, Databricks-managed serving
endpoint that cannot be governed by a gateway. `ai_query('<endpoint>', …)` targets a **named**
endpoint, so pointing it at `ra-llm-gateway` brings the extraction under usage tracking, rate
limits, and payload logging. Structured output is preserved with a `responseFormat` json_schema
that mirrors the old `ai_extract` field set, so downstream mismatch logic is unchanged.

**Why not gateway the shared FM endpoint directly.** Claude is proprietary and only served through
the shared, workspace-wide `databricks-claude-sonnet-4-5` endpoint. Enabling payload logging on
*that* endpoint would capture every other workspace user's traffic into the RA schema — a privacy
problem. Instead we front it with our own **external-model proxy** endpoint (below), which is the
proven pattern in this workspace.

---

## 2. Endpoints created

### `ra-llm-gateway` — governed Claude proxy (LLM extraction)
- **Type:** custom `llm/v1/chat` endpoint, single served entity = an `external_model` with
  `provider: databricks-model-serving`, `name: databricks-claude-sonnet-4-5`.
- **Auth:** the proxy authenticates to the FM endpoint with a workspace PAT stored as the secret
  `ra_gateway/fm_token` (180-day lifetime — **renew before expiry or the endpoint 401s**).
- **Unity Gateway config:** `usage_tracking_config.enabled=true`; `rate_limits` =
  100 calls/min per endpoint; `inference_table_config` → payload logging into
  `cdm_tmforum.revenue_assurance` (prefix `ra_llm_gateway`). Guardrails available (not enabled;
  extraction content is internal contract/invoice data).
- **Consumers:** the two `ai_query(...)` calls in `silver_doc_intelligence.sql`. Any future app
  LLM surface should set `DATABRICKS_SERVING_ENDPOINT_NAME` to this endpoint.

### `ra-anomaly-gateway` — governed Isolation Forest (anomaly scoring)
- **Type:** custom-model endpoint serving `cdm_tmforum.revenue_assurance.ra_anomaly_isolation_forest@champion`
  (`workload_size: Small`, `scale_to_zero_enabled: true`).
- **Unity Gateway config:** usage tracking + 100 calls/min rate limit + inference-table logging
  (prefix `ra_anomaly_gateway`). Guardrails are LLM-only, so not applicable.
- **Scoring path:** the nightly **batch** `spark_udf` scoring in `mlops/score.py` remains the
  pipeline path (cost-appropriate for full-table scoring); the endpoint provides a **governed,
  real-time** scoring surface for the demo and any app/API caller. Both read the same
  `@champion` version, so scores are consistent.

---

## 3. What a presenter can show

- **Usage & lineage:** system tables show requests/tokens/latency per endpoint; UC shows the model
  version and `@champion` alias behind `ra-anomaly-gateway`.
- **Payload logging:** the inference tables under `cdm_tmforum.revenue_assurance`
  (`ra_llm_gateway_*`, `ra_anomaly_gateway_*`) hold the actual request/response rows — "every model
  call is auditable."
- **Rate limits:** the per-endpoint ceiling is a governance control, not just a cost knob.
- **The point:** the same platform that reconciles the *data* also governs the *models* — one UC
  boundary over data and AI.

---

## 4. Operational notes / follow-ups

- **Token renewal.** `ra_gateway/fm_token` expires in 180 days. Rotate with
  `databricks tokens create …` + `databricks secrets put-secret ra_gateway fm_token …`; the
  endpoint picks up the new secret value on its next config update.
- **Not yet gatewayed and why:** `ai_parse_document`, `ai_forecast`, Genie — see the matrix. If a
  future Databricks release exposes an endpoint parameter for `ai_parse_document`, route it too.
- **App governance surface.** The planned **Anomaly models** tab (see
  [`16-detection-tabs-plan.md`](16-detection-tabs-plan.md)) should surface per-endpoint usage +
  the "which models are gatewayed" matrix so the governance story is visible in the console itself.
- **Public-repo redaction.** This doc uses `demo-workspace` conventions elsewhere; the endpoint
  and secret *names* here are non-sensitive, but never commit the PAT value or the real workspace
  hostname into tracked files.
