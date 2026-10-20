// In-memory, bounded failure budgets. No hard account lockout: account backoff
// lasts at most two seconds, while IP budgets limit repeated guessing.
class LoginLimiter {
    constructor(now = Date.now) {
        this.now = now;
        this.entries = new Map();
        this.busy = 0;
        this.nextSweep = 0;
    }
    begin(ip, username, { limitIp = true } = {}) {
        const now = this.now();
        if (now >= this.nextSweep || this.entries.size >= 10000) {
            for (const [key, value] of this.entries) if (value.until <= now && value.pending === 0) this.entries.delete(key);
            this.nextSweep = now + 60000;
        }
        const keys = limitIp ? ['ip:' + ip, 'account:' + username] : ['account:' + username];
        const existing = keys.map(key => this.entries.get(key));
        if (limitIp && (existing[0]?.failures || 0) >= 100 && existing[0].until > now) {
            return { retryAfter: Math.max(1, Math.ceil((existing[0].until - now) / 1000)) };
        }
        const account = existing.at(-1);
        if (account?.next > now) return { retryAfter: Math.ceil((account.next - now) / 1000) };
        if (this.busy >= 4 || this.entries.size + keys.filter(key => !this.entries.has(key)).length > 10000) return { retryAfter: 1 };
        const entries = keys.map((key, i) => {
            let value = existing[i];
            if (!value) {
                value = { failures: 0, next: 0, until: now + 300000, pending: 0 };
                this.entries.set(key, value);
            } else if (value.until <= now && value.pending === 0) {
                value.failures = 0;
                value.next = 0;
                value.until = now + 300000;
            }
            value.pending++;
            return value;
        });
        this.busy++;
        let finished = false;
        return { finish: success => {
            if (finished) return;
            finished = true;
            this.busy--;
            for (const entry of entries) entry.pending--;
            if (success) {
                entries.at(-1).failures = 0;
                entries.at(-1).next = 0;
            } else {
                const at = this.now();
                for (const entry of entries) entry.failures++;
                if (entries.at(-1).failures >= 5) entries.at(-1).next = at + Math.min(2000, 250 * 2 ** Math.min(3, entries.at(-1).failures - 5));
            }
        } };
    }
}
module.exports = { LoginLimiter };
