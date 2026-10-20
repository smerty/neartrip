const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LoginLimiter } = require('../utils/login-limiter');

test('failures are isolated by client IP, successes do not consume failure budgets', () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    for (let i = 0; i < 100; i++) {
        const attempt = limiter.begin('192.0.2.1', 'guess' + i);
        assert.ok(attempt.finish);
        attempt.finish(false);
    }
    assert.equal(limiter.begin('192.0.2.1', 'alice').retryAfter, 300);
    for (let i = 0; i < 120; i++) {
        const attempt = limiter.begin('192.0.2.2', 'alice');
        assert.ok(attempt.finish);
        attempt.finish(true);
    }
    now = 300001;
    const recovered = limiter.begin('192.0.2.1', 'alice');
    assert.ok(recovered.finish);
    recovered.finish(true);
});

test('distributed account guessing gets short bounded backoff without a permanent account lockout', () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    for (let i = 0; i < 12; i++) {
        const attempt = limiter.begin('ip' + i, 'alice');
        assert.ok(attempt.finish);
        attempt.finish(false);
        if (i >= 4) {
            const blocked = limiter.begin('another-ip', 'alice');
            assert.ok(blocked.retryAfter >= 1 && blocked.retryAfter <= 2);
        }
        now += 2001;
    }
    const valid = limiter.begin('legitimate-ip', 'alice');
    assert.ok(valid.finish);
    valid.finish(true);
    const next = limiter.begin('legitimate-ip', 'alice');
    assert.ok(next.finish);
    next.finish(true);
});

test('password-check concurrency and limiter storage stay bounded, including concurrent failures', () => {
    const limiter = new LoginLimiter(() => 0);
    const attempts = Array.from({ length: 4 }, (_, i) => limiter.begin('ip', 'account' + i));
    assert.ok(attempts.every(a => a.finish));
    assert.equal(limiter.begin('other', 'other').retryAfter, 1);
    attempts.forEach(a => { a.finish(false); a.finish(false); });
    assert.equal(limiter.busy, 0);
    for (let i = 0; i < 11000; i++) {
        const attempt = limiter.begin('ip' + i, 'name' + i);
        attempt.finish?.(false);
    }
    assert.ok(limiter.entries.size <= 10000);
});


test('unconfigured proxy fallback cannot hard-block a shared peer, but retains account backoff and concurrency caps', () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    const options = { limitIp: false };
    for (let i = 0; i < 120; i++) {
        const attempt = limiter.begin('shared-proxy', 'attacker' + i, options);
        assert.ok(attempt.finish);
        attempt.finish(false);
    }
    for (let i = 0; i < 110; i++) {
        const attempt = limiter.begin('shared-proxy', 'target', options);
        assert.ok(attempt.finish);
        attempt.finish(false);
        now += 2001;
    }
    const legitimate = limiter.begin('shared-proxy', 'target', options);
    assert.ok(legitimate.finish, 'even the targeted account has no five-minute peer lockout');
    legitimate.finish(true);
    const inFlight = Array.from({length: 4}, (_, i) => limiter.begin('shared-proxy', 'member' + i, options));
    assert.ok(inFlight.every(a => a.finish));
    assert.equal(limiter.begin('shared-proxy', 'another-member', options).retryAfter, 1);
    inFlight.forEach(a => a.finish(true));
    for (let i = 0; i < 5; i++) limiter.begin('shared-proxy', 'guess', options).finish(false);
    assert.equal(limiter.begin('shared-proxy', 'guess', options).retryAfter, 1);
});

test('unknown username churn cannot consume account storage or block a configured member', () => {
    const limiter = new LoginLimiter(() => 0);
    for (let i = 0; i < 11000; i++) {
        const attempt = limiter.begin('shared-proxy', 'unknown' + i, { limitIp: false, knownAccount: false });
        assert.ok(attempt.finish);
        attempt.finish(false);
    }
    assert.equal(limiter.entries.size, 0);
    const valid = limiter.begin('shared-proxy', 'configured-member', { limitIp: false, knownAccount: true });
    assert.ok(valid.finish);
    valid.finish(true);
});

test('a full budget table evicts idle tracking instead of denying unrelated correct logins', () => {
    const limiter = new LoginLimiter(() => 0);
    for (let i = 0; i < 10000; i++) {
        limiter.begin('ip' + i, 'unknown' + i, { knownAccount: false }).finish(false);
    }
    assert.equal(limiter.entries.size, 10000);
    const inFlight = Array.from({ length: 4 }, (_, i) => limiter.begin('new-ip' + i, 'configured-member' + i));
    assert.ok(inFlight.every(a => a.finish));
    assert.ok(limiter.entries.size <= 10000);
    inFlight.forEach(a => a.finish(true));
});

test('expired IP budgets renew while overlapping checks keep the entry pinned', () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    const options = { knownAccount: false };
    let held = limiter.begin('192.0.2.1', 'old', options);
    now = 300001;
    let rolling = limiter.begin('192.0.2.1', 'new', options);
    let blockedAt;
    for (let i = 1; i <= 200; i++) {
        held.finish(false);
        held = rolling;
        const next = limiter.begin('192.0.2.1', 'guess' + i, options);
        if (!next.finish) {
            blockedAt = i;
            assert.equal(next.retryAfter, 300);
            break;
        }
        rolling = next;
    }
    assert.equal(blockedAt, 100, 'overlapping checks must not bypass the renewed failure budget');
    held.finish(false);
    assert.equal(limiter.busy, 0);
    assert.equal(limiter.entries.get('ip:192.0.2.1').pending, 0);
    limiter.begin('192.0.2.2', 'unrelated-member').finish(true);
    now += 300001;
    const recovered = limiter.begin('192.0.2.1', 'member', options);
    assert.ok(recovered.finish);
    recovered.finish(true);
});
