# Rust port benchmark — October 15, 2026

Compared JavaScript `9bb4082` with Rust port `3a4829c`, release build. Three fresh-process repetitions per workload; values below are medians of run-level metrics. Full service includes the admin UI in both versions. No application code was changed.

**Assessment:** keep the Rust port for correctness and lower streaming CPU use. It is not a large whole-service memory reduction or a demonstrated maximum-throughput increase.

## Streaming results

| Workload | Implementation | Delivered MiB/s | CPU % | Peak RSS MiB | p50 ms | p99 ms |
|---|---|---:|---:|---:|---:|---:|
| 100 rovers | Old full service | 1.92 | 4.37 | 69.45 | 0.36 | 1.49 |
| 100 rovers | New full service | 1.93 | 2.97 | 69.75 | 0.59 | 1.57 |
| 100 rovers | Rust core alone | 1.92 | 3.16 | 8.38 | 0.50 | 1.19 |
| 300 rovers | Old full service | 5.76 | 10.52 | 80.43 | 0.51 | 11.96 |
| 300 rovers | New full service | 5.76 | 7.92 | 77.03 | 0.54 | 1.86 |
| 300 rovers | Rust core alone | 5.77 | 7.91 | 15.57 | 0.64 | 2.39 |
| 100 rovers + malformed connections | Old full service | 1.93 | 6.35 | 70.66 | 0.52 | 3.78 |
| 100 rovers + malformed connections | New full service | 1.92 | 4.95 | 72.11 | 0.60 | 1.31 |
| 100 rovers + malformed connections | Rust core alone | 1.92 | 4.75 | 10.22 | 0.61 | 2.61 |

All configured healthy rovers received correction frames in every streaming run. Every run maintained exactly one observed caster connection per rover. CPU 100% means one logical CPU; RSS is sampled, summed across parent and child for the new full service. Latency measures a complete synthetic 1 KiB frame from caster write to rover receipt.

At 300 rovers, the full Rust service used 25% less CPU and reduced p99 latency by 84%. Memory fell only 4%. At 100 rovers, median latency was higher with Rust; there is no universal latency improvement.

## Short connection churn

| Implementation | Sourcetable requests/s | CPU % | p99 ms |
|---|---:|---:|---:|
| Old full service | 6633 | 104.6 | 4.29 |
| New full service | 6442 | 165.9 | 3.79 |
| Rust core alone | 6508 | 151.9 | 4.10 |

All 300 requests completed per run at concurrency 20. These brief tests show no clear connection-rate win and higher CPU use with Rust. Rates vary between runs; do not interpret the small full-service rate difference as a proven regression. A likely optimization target is `Registry::flush`: every disconnect synchronously serializes and rewrites session history, and session operations scan a mutex-protected vector. This is a source-based hypothesis, not a profiling result.

## Unusual clients

| Case | Old JavaScript | New Rust |
|---|---|---|
| Split request headers | No corrections | Streams successfully |
| Split GGA sentence | No corrections | Streams successfully |
| GNGGA talker | No corrections | Streams successfully |
| Header and GGA in one write | GGA ignored; no corrections | Streams successfully |
| Bad GGA checksum | Dials caster and streams | Ignores fix; no caster dial |
| Missing configured credentials | Accepts and streams | Rejects before caster dial |
| Oversized incomplete header | Accepts mountpoint prematurely | Does not accept |
| GGA forwarding | None observed | Observed at caster |

Neither service crashed in these probes or in the mixed workload. The mixed run sent 200 garbage/invalid-GGA/oversized-header connections while 100 legitimate rovers continued streaming. This establishes basic isolation, not comprehensive denial-of-service resistance.

The caster deliberately streams without requiring GGA, otherwise the old core could not participate. A real caster requiring rover location can make that correctness difference decisive. These results compare implementations, including protocol, logging, and architecture changes; they do not isolate the effect of Rust as a language.

## Method and limits

One active local caster, 1 KiB frames at 20 Hz per rover, one GPGGA per second, two-second warmup, approximately five measured seconds. Local loopback removes WAN variability but the Python generator and services share the host. This is fixed offered load, not a maximum-capacity benchmark. It does not test slow readers, long-running leaks, prolonged slow handshakes, idle timeout enforcement, or large station catalogs. Latency includes warmup; CPU and delivery rate cover the measured window. The first old/100-rover sample was rerun without an overlapping test compilation.

Host: : Intel(R) Core(TM) i9-14900K, 10 logical CPUs; Linux-6.8.0-138-generic-x86_64-with-glibc2.35; Node v22.22.0; rustc 1.97.1 (8bab26f4f 2026-07-14).

Validation: all 13 Rust unit tests and 3 integration tests pass. The historical JavaScript test suite has 5 failures and 11 passes: four NTRIP mock/throw expectations and one closest-station expectation. The benchmark exercises real sockets independently of those mocks.

Reproduction and metric definitions: [README.md](README.md). Raw per-run observations: [results.json](results.json). Harness: [compare.py](compare.py).
