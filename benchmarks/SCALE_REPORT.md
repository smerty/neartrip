# Higher-concurrency rover benchmark — October 15, 2026

Compared the same JavaScript `9bb4082` and Rust `3a4829c` full services, including admin UI, with three fresh-process repetitions at 500, 1,000, and 2,000 rovers. All tests use one GPGGA per second and 1 KiB synthetic correction frames targeting 20 Hz per rover. Values below are medians across repeats.

**Both services kept every configured rover receiving data through 2,000 concurrent rovers.** Rust retained lower tail latency, but its CPU and memory advantage did not hold at 2,000.

| Rovers | Full service | Delivered MiB/s | CPU % | Peak RSS MiB | p50 ms | p99 ms |
|---:|---|---:|---:|---:|---:|---:|
| 500 | Old JavaScript | 9.58 | 15.85 | 83.78 | 0.73 | 2.59 |
| 500 | Rust + Node admin | 9.59 | 13.26 | 83.73 | 0.63 | 2.01 |
| 1,000 | Old JavaScript | 19.18 | 31.04 | 103.64 | 0.69 | 3.08 |
| 1,000 | Rust + Node admin | 19.18 | 28.01 | 100.84 | 0.64 | 2.57 |
| 2,000 | Old JavaScript | 38.47 | 60.47 | 107.14 | 0.27 | 4.75 |
| 2,000 | Rust + Node admin | 38.49 | 68.19 | 136.16 | 0.10 | 1.19 |

At 2,000 rovers, Rust used **13% more CPU** and **27% more resident memory**, with **75% lower p99 latency**. CPU 100% is one logical CPU, not the whole host. At 500 and 1,000, Rust used less CPU and had lower p99 latency. These are full-service costs; the old service still performs less protocol validation and never forwards GGA upstream.

## Generator limit and corrected comparison

The original combined Python caster/rover process reached approximately 100% of one CPU core at 2,000 rovers. Its offered rate fell to roughly 16.7–18.9 Hz depending on the service/run. Those rows remain in `scale-results.json` for diagnosis and are excluded from the main 2,000-rover table.

Repeating 2,000 rovers with the caster in a separate process restored approximately 19.7 Hz per rover for both services. Neither generator process saturated a core. Every rover received at least 198 frames during each approximately ten-second measurement window. All rovers were still receiving within one second of measurement end. No application process crashed, and no client exceptions were recorded.

The 500/1,000 rows use the combined generator; the 2,000 rows use separate generators. Compare old versus new within a row count. Cross-count latency changes also include this generator architecture change.

## What this establishes

The port handles substantially more than the earlier 300-rover test, with useful latency benefits. It does not establish maximum capacity. The high-concurrency CPU reversal makes profiling the session registry worthwhile: it scans a mutex-protected vector for per-session updates and clones/serializes the registry for periodic snapshots. That is a source-based optimization hypothesis, not an established bottleneck from this experiment.

Connections ramp in batches of 50 every 25 ms. The harness waits for first correction delivery (up to 20 seconds), settles for two seconds, then measures for approximately ten seconds. RSS is sampled every 100 ms and summed across the Node parent and Rust child. No test traffic touches external casters. Normal application logging remains enabled. Synthetic frames test transport rather than decoded RTCM behavior. These runs do not test long-term memory retention, wonky clients at these larger counts, or slow readers.

Same Intel i9-14900K host, 10 visible logical CPUs, Node v22.22.0, Rust 1.97.1. Server and load-generator processes share the machine. The mock caster streams without requiring GGA so the old service can participate.

Reproduce with [README.md](README.md). Raw observations: [scale-results.json](scale-results.json) and [scale-split-results.json](scale-split-results.json). Harnesses: [scale.py](scale.py), [scale_split.py](scale_split.py).
