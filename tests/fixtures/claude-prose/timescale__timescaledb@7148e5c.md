I found one real bug: the new `refresh_newest_first` option is accepted by the SQL function but never takes effect.

- tsl/src/bgw_policy/continuous_aggregate_api.c:724 — `policy_refresh_cagg_add` never reads the new 11th argument (`PG_GETARG_DATUM(10)`). Separately, `policy_refresh_cagg_add_internal` never writes `refresh_newest_first` into the job's config. So when you call `add_continuous_aggregate_policy(..., refresh_newest_first => false)`, the config has no such key. `policy_refresh_cagg_get_refresh_newest_first` then falls back to its default of `true`, and batches still run newest-first (`DESC`). The only way to get oldest-first today is to edit the config by hand with `alter_job`.

The test doesn't catch this. `cagg_refresh_policy_incremental` now passes `refresh_newest_first => false`, but its expected output around that call is unchanged, which fits the flag being ignored.

To fix it:
1. Add a `NullableDatum refresh_newest_first` argument to `policy_refresh_cagg_add_internal`.
2. Read it from argument 10 in `policy_refresh_cagg_add`.
3. Write it into the config with `ts_jsonb_add_bool`.
4. Update the other caller in `tsl/src/bgw_policy/policies_v2.c:215`.
5. Change the test so it actually checks that oldest-first order is used.

I found no other problems in the diff. The `psprintf` template has no stray `%` besides the `ASC`/`DESC` placeholder, and the update and downgrade scripts' function signatures match `policy_api.sql`.
