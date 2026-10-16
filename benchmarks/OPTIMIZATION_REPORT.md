# Rust profiling and optimization — October 15, 2026

The application changes target costs measured at 2,000 concurrent rovers. The original JavaScript service and original Rust build are rerun alongside the optimized build; all full-service totals include the admin UI.

## Profiling evidence

The host blocks `perf` (`perf_event_paranoid=4`). Instead, isolated source copies measure registry mutex wait/hold wall time, the compiler-reported size of the per-rover async future, and `/proc` resident memory. Timing probes are absent from the application source and from the final benchmark binaries. This is targeted instrumentation, not a sampled CPU flame graph or comprehensive allocation trace.

| Measurement | Original Rust | Optimized Rust |
|---|---:|---:|
| Per-rover future storage | 27,608 bytes | 9,176 bytes |
| Registry calls per second, steady median | 43,546 | 43,236 |
| Registry lock hold time per second | 99.7 ms | 20.1 ms |
| Registry lock wait time per second | 100.2 ms | 4.9 ms |

Registry timing rows are medians of instrumented one-second intervals with over 42,000 operations, excluding startup. Wait time sums wall time across threads and is not equivalent to CPU time. The size measurement covers the future value, excluding Tokio's task header and separately allocated objects. At 2,000 tasks its storage reduction is approximately 35.2 MiB; RSS savings differ because allocator overhead, blocking threads, and other allocations also contribute. Raw evidence: [profile-baseline.json](profile-baseline.json), [profile-optimized.json](profile-optimized.json).

## Changes

- Index session IDs with a hash map while keeping records in their original ordered vector. Per-packet counter updates and position/station/close updates no longer scan up to 2,000 records while holding the shared lock. Rebuild indices only when pruning actually removes records.
- Reduce retained per-rover buffers: handshake and rover input from 4 KiB to 1 KiB, and upstream input from 16 KiB to 4 KiB. TCP framing remains incremental. A new integration test verifies byte-for-byte forwarding of a 128 KiB correction burst across repeated reads.
- Coalesce disconnect snapshots into the existing approximately one-second publication cycle instead of rewriting the complete history on every disconnect. Run periodic serialization and filesystem work on Tokio's blocking pool. Serialize snapshot writers to prevent races over the shared temporary filename. Startup and shutdown still publish snapshots.

Session fields, insertion order, seven-day history retention, authentication, checksums, GGA forwarding, and station selection are preserved. The admin UI now observes disconnects on the next periodic snapshot rather than an immediate per-close write. Larger correction bursts can require additional read calls because buffers are smaller; the benchmark tests the established approximately 20 KiB/s per-rover workload, not maximum bulk-transfer speed.

## Validation

All 15 Rust unit tests and four integration tests pass. New tests cover index correctness after pruning, concurrent counter updates and snapshot writes, the admin JSON fields after disconnect, and correction bursts larger than the read buffer. `git diff --check` and Python syntax compilation pass. `cargo fmt` was unavailable because this toolchain has no rustfmt component; added Rust code was formatted manually.

## Uninstrumented benchmark results

Three fresh-process repeats of each service at every count; the second repeat reverses variant order. The separate caster and rover generator architecture is used at all counts. CPU 100% means one logical CPU. RSS is sampled every 100 ms and summed across the Node parent and Rust child. Values are medians of per-run measurements.

| Rovers | Service | CPU % | Peak RSS MiB | Delivered MiB/s | p99 delivery ms |
|---:|---|---:|---:|---:|---:|
| 500 | Old JavaScript | 15.88 | 83.17 | 9.62 | 2.04 |
| 500 | Original Rust | 14.64 | 83.97 | 9.61 | 1.52 |
| 500 | Optimized Rust | 13.27 | 77.28 | 9.62 | 1.23 |
| 1,000 | Old JavaScript | 30.78 | 104.22 | 19.21 | 2.95 |
| 1,000 | Original Rust | 29.53 | 100.80 | 19.21 | 1.36 |
| 1,000 | Optimized Rust | 26.29 | 86.50 | 19.19 | 1.47 |
| 2,000 | Old JavaScript | 61.25 | 107.64 | 38.39 | 15.09 |
| 2,000 | Original Rust | 71.02 | 137.77 | 38.46 | 1.48 |
| 2,000 | Optimized Rust | 52.41 | 108.51 | 38.47 | 1.23 |

At 2,000 rovers, optimized Rust reduces full-service CPU by **26%** and peak RSS by **21%** versus original Rust. Delivered throughput is essentially unchanged. Against JavaScript, optimized Rust uses **14% less CPU**, with resident memory within approximately **1%**. Median p99 latency is lower than original Rust at 500/2,000, slightly higher at 1,000; these measurements do not establish a universal latency improvement.

Every configured rover received corrections during the measurement window and within one second of its end in all 27 streaming runs. All processes survived, with no recorded client exceptions. Actual offered rate stayed near 19.7 Hz per rover in the 2,000-rover runs; neither generator saturated one CPU core. See raw per-rover minimum frame counts and generator CPU in [optimized-results.json](optimized-results.json).

Supplementary single-run checks: all 300 sourcetable requests completed for each Rust version; both maintained 100 healthy rovers during 200 malformed/aborted connections, with one observed caster connection per rover. All eight protocol probes preserve the expected behavior: fragmented headers/GGA, GNGGA, and coalesced header+GGA stream successfully; bad checksums and missing credentials do not dial a caster; oversized unfinished headers are not accepted. Single supplementary churn/mixed rates are sanity checks, not robust performance estimates.

These remain short fixed-load loopback tests (approximately ten measured seconds after ramp/settling), not maximum capacity or long-term leak measurements. No slow-reader stress was performed. The old JavaScript implementation still omits GGA forwarding and validation work, so this is an implementation comparison rather than a language-only comparison. No profiling probes run during these timing measurements.

Reproduce with [README.md](README.md). Harness: [optimize_compare.py](optimize_compare.py). Original measurements remain in the earlier result files.
