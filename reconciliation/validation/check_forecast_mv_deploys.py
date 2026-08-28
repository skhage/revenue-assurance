"""Deterministic deployment gate for reconciliation/warehouse/gold_revenue_forecast_anomalies.sql.

Unlike EXPLAIN (planner-only), this actually executes the file's
CREATE OR REFRESH MATERIALIZED VIEW statements against a live warehouse
(deployed under a `_test_` prefix so it never touches the real objects),
confirms REFRESH succeeds, and asserts SHOW CREATE TABLE still contains the
scalar-subquery horizon expression verbatim (i.e. it was not silently
literalized at creation time). The test objects are dropped afterward
regardless of outcome.

This is the actual command referenced by the "deterministic SQL compile/
deployment validation" comment in gold_revenue_forecast_anomalies.sql.

Usage:
    python3 reconciliation/validation/check_forecast_mv_deploys.py \
        --profile <databricks-cli-profile> --warehouse-id <sql-warehouse-id>

Requires the `databricks` CLI to be installed and authenticated (this script
shells out to `databricks api post /api/2.0/sql/statements`, matching the
pattern used elsewhere in this repo's validation tooling -- it never reads or
prints a credential itself).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FORECAST_SQL = REPO_ROOT / "reconciliation" / "warehouse" / "gold_revenue_forecast_anomalies.sql"

# Statement Execution API status.state values. PENDING/RUNNING are NOT
# terminal -- a POST (or a GET while polling) can return either one long
# before the statement actually finishes, and treating them as "no error"
# (as the prior version of this script did) is indistinguishable from
# success. Only these four are terminal; CREATE/REFRESH/DROP must reach one
# of them before this script draws any conclusion.
TERMINAL_STATES = {"SUCCEEDED", "FAILED", "CANCELED", "CLOSED"}
NON_TERMINAL_STATES = {"PENDING", "RUNNING"}

# Suffix distinguishing this run's throwaway test objects from any other
# concurrent/leftover run's -- avoids collisions if two invocations overlap
# or a prior run's cleanup was interrupted (see build_rename_map).
_RUN_SUFFIX = os.environ.get("CHECK_FORECAST_MV_RUN_SUFFIX") or f"{os.getpid()}_{int(time.time())}"


def build_rename_map(run_suffix: str) -> dict[str, str]:
    """Real object names -> this run's unique throwaway test names."""
    return {
        "cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies_dq_audit":
            f"cdm_tmforum.revenue_assurance._test_{run_suffix}_gold_revenue_forecast_anomalies_dq_audit",
        "cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies":
            f"cdm_tmforum.revenue_assurance._test_{run_suffix}_gold_revenue_forecast_anomalies",
    }


def extract_create_statements(sql_text: str) -> list[str]:
    """Split the file into its two CREATE OR REFRESH MATERIALIZED VIEW ... ; statements.

    Anchored to the start of a line (^CREATE, MULTILINE) so prose mentions of
    "CREATE OR REFRESH MATERIALIZED VIEW" inside `--` comments (there are
    several, documenting the design) are not mistaken for real statements.
    """
    statements = re.findall(
        r"^CREATE OR REFRESH MATERIALIZED VIEW.*?;", sql_text, re.DOTALL | re.MULTILINE
    )
    if len(statements) != 2:
        raise RuntimeError(
            f"Expected exactly 2 CREATE OR REFRESH statements in {FORECAST_SQL}, found {len(statements)}"
        )
    return statements


def rename_test_targets(statement: str, rename_map: dict[str, str]) -> tuple[str, str]:
    """Rewrite EVERY known real object name in the statement to its _test_
    equivalent -- the DQ-6 audit statement references both its own name (the
    CREATE target) AND the main forecast MV's name (in its FROM clause), so
    a single-name substitution would leave the FROM clause pointing at the
    real object. Returns (rewritten_statement, real_name_being_created) --
    the latter identified as whichever key appears first in the statement
    text (the CREATE target always appears before any FROM reference).
    """
    rewritten = statement
    create_target = None
    for real_name in rename_map:
        if real_name in rewritten:
            if create_target is None or statement.index(real_name) < statement.index(create_target):
                create_target = real_name
            rewritten = rewritten.replace(real_name, rename_map[real_name])
    if create_target is None:
        raise RuntimeError("Statement does not reference a known object name to rename")
    return rewritten, create_target


def _api_call(args: list[str], timeout: int = 60) -> dict:
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(f"databricks CLI failed: {result.stderr or result.stdout}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Non-JSON response: {result.stdout[:500]}") from exc


def run_sql(profile: str, warehouse_id: str, statement: str, poll_timeout_s: float = 120.0,
            poll_interval_s: float = 2.0) -> dict:
    """Submit a statement and POLL /api/2.0/sql/statements/{id} until it
    reaches a TERMINAL state (SUCCEEDED/FAILED/CANCELED/CLOSED).

    The initial POST's own `wait_timeout` can itself return while the
    statement is still PENDING/RUNNING (that's the whole point of the async
    API) -- treating that response as final, as the prior version of this
    script did, meant PENDING/RUNNING was silently indistinguishable from
    success. This polls the GET endpoint until a terminal state or
    poll_timeout_s elapses, whichever comes first, and raises with a clear
    message on timeout rather than returning a non-terminal response.
    """
    payload = json.dumps(
        {"warehouse_id": warehouse_id, "statement": statement, "wait_timeout": "10s"}
    )
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as fh:
        fh.write(payload)
        payload_path = fh.name
    try:
        response = _api_call(
            ["databricks", "api", "post", "/api/2.0/sql/statements",
             "--profile", profile, "--json", f"@{payload_path}"],
        )
    finally:
        Path(payload_path).unlink(missing_ok=True)

    statement_id = response.get("statement_id")
    deadline = time.monotonic() + poll_timeout_s
    while response.get("status", {}).get("state") in NON_TERMINAL_STATES:
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"Statement {statement_id} did not reach a terminal state within "
                f"{poll_timeout_s}s (last state: {response.get('status', {}).get('state')}). "
                f"Statement text: {statement[:200]!r}"
            )
        time.sleep(poll_interval_s)
        if not statement_id:
            raise RuntimeError(
                f"Statement is non-terminal but no statement_id was returned to poll: {response}"
            )
        response = _api_call(
            ["databricks", "api", "get", f"/api/2.0/sql/statements/{statement_id}",
             "--profile", profile],
        )

    final_state = response.get("status", {}).get("state")
    if final_state not in TERMINAL_STATES:
        raise RuntimeError(
            f"Statement {statement_id} returned an unrecognized status.state "
            f"{final_state!r} -- expected one of {sorted(TERMINAL_STATES)}"
        )
    return response


def statement_error(response: dict) -> str | None:
    """Return an error message if the (already-terminal) response did not
    SUCCEED. CANCELED/CLOSED are treated as failures here too -- this script
    always expects SUCCEEDED for CREATE/REFRESH/SHOW/DROP, so anything else
    is worth surfacing rather than silently accepted."""
    status = response.get("status", {})
    state = status.get("state")
    if state == "SUCCEEDED":
        return None
    if state == "FAILED":
        return status.get("error", {}).get("message", "unknown error")
    if state in NON_TERMINAL_STATES:
        # run_sql() should never return a non-terminal response -- if this
        # fires, run_sql's polling loop has a bug, not the caller.
        return f"statement returned non-terminal state {state!r} (polling bug -- should be impossible)"
    return f"statement ended in state {state!r} (expected SUCCEEDED)"


def normalize_sql_fragment(text: str) -> str:
    """Collapse all whitespace runs to single spaces and strip, so two SQL
    fragments that differ only in indentation/line-wrapping compare equal."""
    return re.sub(r"\s+", " ", text).strip()


def extract_balanced_parens(text: str, open_paren_index: int) -> str:
    """Given the index of an opening '(' in text, return the substring from
    that '(' through its matching ')' (balanced over nested parens)."""
    if text[open_paren_index] != "(":
        raise ValueError(f"Character at index {open_paren_index} is not '(': {text[open_paren_index]!r}")
    depth = 0
    for i in range(open_paren_index, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[open_paren_index:i + 1]
    raise ValueError(f"Unbalanced parentheses starting at index {open_paren_index}")


def extract_horizon_expression(create_statement: str) -> str:
    """Pull the exact `horizon => (...)` argument expression out of an
    ACTUAL CREATE OR REFRESH MATERIALIZED VIEW statement (not the whole
    file, which also contains a prose mention of `horizon => (SELECT ...)`
    inside a `--` comment documenting the design -- matching against the
    full file text would silently pick up that comment's literal `...`
    placeholder instead of the real expression). This is the ground truth
    the deployed DDL's SHOW CREATE TABLE output must match EXACTLY -- not
    just "contains the words horizon and SELECT somewhere", which would
    also pass if the subquery were replaced with an unrelated SELECT.

    Uses balanced-parenthesis matching (extract_balanced_parens), not a
    non-greedy regex `\\(SELECT.*?\\)` -- the naive regex stops at the FIRST
    closing paren, which for `(SELECT ADD_MONTHS(max_actual_month, 12) FROM
    bounds)` is ADD_MONTHS(...)'s own closing paren, silently truncating the
    captured expression before `FROM bounds)`.
    """
    marker = re.search(r"horizon\s*=>\s*\(", create_statement)
    if not marker:
        raise RuntimeError(
            f"Could not find a 'horizon => (' expression in the CREATE "
            f"statement itself (not just the file's comments): {create_statement[:300]!r}"
        )
    open_paren_index = marker.end() - 1  # marker.end() is just past the '('
    expr = extract_balanced_parens(create_statement, open_paren_index)
    return normalize_sql_fragment(expr)


def check_horizon_matches_ddl(ddl_text: str, expected_horizon_expr: str, test_name: str) -> str | None:
    """Return an error string if the deployed DDL's own horizon expression
    doesn't EXACTLY (post-normalization) match expected_horizon_expr. Uses
    the same balanced-parenthesis extraction as extract_horizon_expression
    -- a non-greedy regex would truncate at ADD_MONTHS(...)'s own closing
    paren instead of the outer wrapping paren."""
    marker = re.search(r"horizon\s*=>\s*\(", ddl_text)
    if not marker:
        return (
            f"{test_name}: stored DDL has no 'horizon => (' expression at all "
            "-- it was likely literalized to a constant at creation time"
        )
    try:
        deployed_horizon_expr = normalize_sql_fragment(
            extract_balanced_parens(ddl_text, marker.end() - 1)
        )
    except ValueError as exc:
        return f"{test_name}: could not parse the deployed DDL's horizon expression: {exc}"
    if deployed_horizon_expr != expected_horizon_expr:
        return (
            f"{test_name}: stored DDL's horizon expression does not exactly match the "
            f"source file's.\n    expected: {expected_horizon_expr!r}\n    deployed: {deployed_horizon_expr!r}"
        )
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True, help="Databricks CLI profile name")
    parser.add_argument("--warehouse-id", required=True, help="SQL warehouse id to run against")
    args = parser.parse_args()

    sql_text = FORECAST_SQL.read_text()
    statements = extract_create_statements(sql_text)
    forecast_statement = next((s for s in statements if "ai_forecast" in s), None)
    if forecast_statement is None:
        raise RuntimeError("No extracted CREATE statement contains an ai_forecast(...) call")
    expected_horizon_expr = extract_horizon_expression(forecast_statement)
    rename_map = build_rename_map(_RUN_SUFFIX)
    print(f"Run suffix: {_RUN_SUFFIX} (test objects: _test_{_RUN_SUFFIX}_*)")

    deployed_test_names: list[str] = []
    failures: list[str] = []

    try:
        for statement in statements:
            rewritten, real_name = rename_test_targets(statement, rename_map)
            test_name = rename_map[real_name]
            print(f"Deploying test copy of {real_name} as {test_name} ...")

            create_resp = run_sql(args.profile, args.warehouse_id, rewritten)
            err = statement_error(create_resp)
            if err:
                failures.append(f"CREATE failed for {test_name}: {err}")
                continue
            deployed_test_names.append(test_name)
            print(f"  CREATE OK")

            refresh_resp = run_sql(args.profile, args.warehouse_id, f"REFRESH MATERIALIZED VIEW {test_name}")
            err = statement_error(refresh_resp)
            if err:
                failures.append(f"REFRESH failed for {test_name}: {err}")
                continue
            print(f"  REFRESH OK")

            # Only the main forecast MV carries the horizon subquery; the
            # DQ-6 audit MV reads from it and has no ai_forecast call.
            if "ai_forecast" in rewritten:
                show_resp = run_sql(args.profile, args.warehouse_id, f"SHOW CREATE TABLE {test_name}")
                err = statement_error(show_resp)
                if err:
                    failures.append(f"SHOW CREATE TABLE failed for {test_name}: {err}")
                    continue
                rows = show_resp.get("result", {}).get("data_array", [])
                ddl_text = "\n".join(row[0] for row in rows if row)
                horizon_err = check_horizon_matches_ddl(ddl_text, expected_horizon_expr, test_name)
                if horizon_err:
                    failures.append(horizon_err)
                else:
                    print(f"  SHOW CREATE TABLE confirms EXACT horizon subquery preserved: {expected_horizon_expr!r}")
    finally:
        # Each drop is independently try/except'd so one failure (e.g. a
        # transient warehouse hiccup, or run_sql's own polling timeout on
        # the drop itself) does not abort cleanup of the remaining test
        # objects -- this must run even if the try block raised.
        #
        # REVERSED ORDER: deployed_test_names is appended in CREATE order
        # (main forecast MV first, then the DQ-6 audit MV, which reads FROM
        # the main MV in its own FROM clause). Dropping in that same
        # (creation) order would drop the main MV while the audit MV --
        # its dependent -- still exists and still references it. Iterating
        # in reverse drops the dependent (audit MV) first, then the
        # dependency (main forecast MV) second, matching how the
        # statements actually relate to each other.
        cleanup_failures: list[str] = []
        for test_name in reversed(deployed_test_names):
            print(f"Dropping {test_name} ...")
            try:
                drop_resp = run_sql(args.profile, args.warehouse_id, f"DROP MATERIALIZED VIEW IF EXISTS {test_name}")
                err = statement_error(drop_resp)
                if err:
                    cleanup_failures.append(f"{test_name}: {err}")
            except Exception as exc:  # noqa: BLE001 -- cleanup must not raise
                cleanup_failures.append(f"{test_name}: {exc}")
        if cleanup_failures:
            print("WARNING: cleanup did not fully succeed -- test objects may remain:", file=sys.stderr)
            for cf in cleanup_failures:
                print(f"  - {cf}", file=sys.stderr)

    if failures:
        print("FAIL: forecast MV deployment validation failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("PASS: forecast MV DDL deploys, refreshes, and preserves its horizon subquery")
    return 0


if __name__ == "__main__":
    sys.exit(main())
