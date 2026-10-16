#!/usr/bin/env python3
"""Instrument an isolated source snapshot, never production source."""
import pathlib,sys
root=pathlib.Path(sys.argv[1])
p=root/'src/registry.rs'; s=p.read_text()
s=s.replace('const HISTORY_SECS:', '''use std::sync::atomic::{AtomicU64, Ordering};
static CALLS: AtomicU64 = AtomicU64::new(0);
static WAIT: AtomicU64 = AtomicU64::new(0);
static HOLD: AtomicU64 = AtomicU64::new(0);
pub fn profile_dump() {
    eprintln!("REGISTRY_PROFILE calls={} wait_ns={} hold_ns={}", CALLS.swap(0,Ordering::Relaxed), WAIT.swap(0,Ordering::Relaxed), HOLD.swap(0,Ordering::Relaxed));
}
const HISTORY_SECS:''')
s=s.replace('let mut guard = self.inner.lock()', 'let begin = std::time::Instant::now();\n        let mut guard = self.inner.lock()')
s=s.replace('f(&mut guard)\n', '''let acquired = std::time::Instant::now();
        let result = f(&mut guard);
        let done = std::time::Instant::now();
        drop(guard);
        CALLS.fetch_add(1, Ordering::Relaxed);
        WAIT.fetch_add(acquired.duration_since(begin).as_nanos() as u64, Ordering::Relaxed);
        HOLD.fetch_add(done.duration_since(acquired).as_nanos() as u64, Ordering::Relaxed);
        result
''')
p.write_text(s)
p=root/'src/main.rs'; s=p.read_text().replace('registry_flush.flush();','registry_flush.flush();\n            neartrip::registry::profile_dump();'); s=s.replace('move || registry.flush()', 'move || { registry.flush(); neartrip::registry::profile_dump(); }')
p.write_text(s)
p=root/'src/server.rs'; s=p.read_text().replace('tokio::spawn(async move {\n                            handle_client', 'let task = async move {\n                            handle_client').replace('handle_client(socket, peer, configs, registry).await;\n                        });','''handle_client(socket, peer, configs, registry).await;
                        };
                        static ONCE: std::sync::Once = std::sync::Once::new();
                        ONCE.call_once(|| eprintln!("SESSION_TASK_BYTES {}", std::mem::size_of_val(&task)));
                        tokio::spawn(task);'''); p.write_text(s)
