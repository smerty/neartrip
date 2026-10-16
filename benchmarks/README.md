# Core port benchmark

`compare.py` compares the last JavaScript service (`9bb4082`) with the Rust port (`3a4829c`). It runs the original applications without changing their logic or disabling their normal logs. `old` includes its in-process admin UI; `new` includes the Node admin parent plus its Rust child; `rust-core` runs just the release binary. Full-service totals are the deployment comparison; core-only numbers show the Rust listener's cost.

Prepare isolated snapshots and dependencies (from the repository root):

```bash
mkdir -p /tmp/neartrip-benchmark/{old,new}
git archive 9bb4082 | tar -x -C /tmp/neartrip-benchmark/old
git archive 3a4829c | tar -x -C /tmp/neartrip-benchmark/new
npm ci --prefix /tmp/neartrip-benchmark/old --cache /tmp/neartrip-benchmark/npm-cache --no-audit --no-fund
ln -s /tmp/neartrip-benchmark/old/node_modules /tmp/neartrip-benchmark/new/node_modules
cargo build --release --target-dir /tmp/neartrip-benchmark/target
python3 benchmarks/compare.py
```

Requires Linux `/proc`, Python 3.10+, Node, Rust, and permission to listen on loopback. All configuration, runtime logs, and processes use `/tmp/neartrip-benchmark`; only result files are written here. Do not run concurrent copies. Services are fresh for every workload. Normal logging is retained; console output goes to a file. Existing snapshot logs persist but neither implementation reloads session history at startup.

Three repetitions, reversed mode order in the second repetition:

- 300 complete sourcetable requests, concurrency 20. Rates include connection establishment and response completion. This is a short connection-churn test, not sustained saturation throughput.
- 100 and 300 rovers, one valid GPGGA/second, one station. A loopback caster sends timestamped 1 KiB synthetic correction frames at 20 Hz per rover, independently of GGA. This accommodates the old core's failure to forward GGA. These are transport frames, not decoded RTCM.
- 100 healthy rovers plus 200 malformed/aborted connections over roughly four seconds: garbage, invalid GGA, and oversized unfinished headers.
- Isolated compatibility probes: valid requests, split headers, split GGA, GNGGA, bad checksums, missing authentication, combined header+GGA, oversized unfinished headers.

Streaming has two seconds of warmup and approximately five measured seconds. CPU and delivery throughput cover the measurement window; latency includes warmup. Latency is caster write to receipt of a complete frame, not GPS-fix-to-correction latency. RSS is summed process resident memory sampled every 100 ms, excluding the load generator, kernel buffers, and page cache; shared pages may be double-counted for the two-process service. CPU 100% means one logical CPU. All clients share this machine with the servers, so latency includes load-generator scheduling.

This tests delivered throughput at a fixed offered rate, not maximum capacity. It does not establish long-term memory growth, production WAN latency, slow-reader safety, or 120-second idle-timeout behavior. Probe results are observations, not assertions. `alive` verifies process survival only. Functional outcomes must be considered alongside speed: the old implementation's lower work can reflect missing validation or GGA forwarding.

## Higher-concurrency follow-up

Run `python3 benchmarks/scale.py` for three repetitions of 500, 1,000, and 2,000 rovers against both full services. This uses the same snapshots and frame/GGA workload as above, with the following improvements:

- Ramp connections in batches of 50, spaced 25 ms apart; allow up to 20 seconds for every rover to receive its first frame, then settle for two seconds.
- Measure for approximately ten seconds, with latency samples restricted to that window.
- Count rovers receiving during the window and within one second of its end; record the minimum per-rover frame count.
- Record actual emitted frame rate, generator CPU use, and interframe gaps to identify generator saturation.
- Use an 8,192-entry mock-caster listen backlog.

Results are saved separately in `scale-results.json`. At 2,000 rovers the combined caster/rover Python process saturated one CPU core, reducing actual offered rate. These rows are diagnostic and should not establish relative server capacity.

Run `python3 benchmarks/scale_split.py` to repeat 2,000 rovers with the mock caster in a separate process. Results go to `scale-split-results.json`; use these for the 2,000-rover comparison. Caster CPU is measured across setup/warmup/measurement/rover cleanup, while rover-generator CPU covers the measurement window. A control socket reads the caster's emitted-frame count near each measurement boundary; small count differences can reflect in-flight frames and scheduling. Neither counter is a packet-loss measurement.

Run benchmarks sequentially. All load-generator processes and the service still share the host; these remain short fixed-load transport tests, not a production capacity certification or long-term memory test.

## Profile and optimization comparison

The baseline Rust binary must be preserved before building the optimized source:

```bash
cargo build --release --manifest-path /tmp/neartrip-benchmark/new/Cargo.toml --target-dir /tmp/neartrip-benchmark/baseline-target
cp /tmp/neartrip-benchmark/baseline-target/release/neartrip /tmp/neartrip-benchmark/baseline-neartrip
cargo build --release --target-dir /tmp/neartrip-benchmark/target
cp /tmp/neartrip-benchmark/target/release/neartrip /tmp/neartrip-benchmark/optimized-neartrip
python3 benchmarks/optimize_compare.py
```

`optimized-results.json` contains three repetitions of all three services at 500, 1,000, and 2,000 rovers, using separate caster/rover processes at every count. It also contains one supplementary connection-churn and mixed-malformed-client check per Rust variant, plus protocol probes on the optimized variant. These supplementary single runs are sanity checks, not stable rate estimates.

For targeted profiling, copy each source version into its own `/tmp` directory, run `python3 benchmarks/instrument_profile.py SNAPSHOT_DIRECTORY` exactly once on each fresh copy, and build that instrumented snapshot with a separate target directory. Then run `python3 benchmarks/profile_run.py ABSOLUTE_BINARY_PATH OUTPUT_NAME`. The latter saves `OUTPUT_NAME.json` here, including one `/proc` memory sample, registry lock timing counters, and the size of the per-rover async task. It runs one 2,000-rover workload with separate load generators.

The host's `perf_event_paranoid=4` blocks `perf`, so these are targeted wall-time contention measurements and structural task-memory measurements, not a sampled CPU flame graph or full allocation trace. Timing instrumentation adds overhead; only uninstrumented variants are used in `optimized-results.json`. Raw profiling evidence is in `profile-baseline.json` and `profile-optimized.json`. The application binary contains none of this timing instrumentation.

Session snapshots now coalesce disconnect updates into the normal approximately one-second publication interval, and write on the blocking pool. The admin UI can therefore see a disconnect on the next snapshot rather than an immediate per-disconnect write. Session history retention, JSON fields, and ordering are preserved. Smaller I/O buffers can require more reads for large bursts; the integration suite verifies byte-for-byte delivery of a 128 KiB correction burst, while the performance test models the original 20 KiB/s per-rover workload.
