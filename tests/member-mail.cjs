const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fixture(env) {
    let options, message;
    const context = { module: { exports: {} }, URL, process: { env }, require: () => ({ createTransport(value) {
        options = value;
        return { sendMail(value) { message = value; } };
    } }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/member-mail.js'), 'utf8'), context);
    return { create: context.module.exports.createMailer, options: () => options, message: () => message };
}
const settings = { PUBLIC_HOSTNAME: 'rtk.k6sh.com', SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'login@example.com' };
test('mail defaults to TLS on 465 and builds links from PUBLIC_HOSTNAME', () => {
    const mail = fixture({ ...settings, SMTP_USER: 'user', SMTP_PASSWORD: 'secret' });
    mail.create().send('invited@example.com', 'token');
    assert.equal(mail.options().port, 465);
    assert.equal(mail.options().secure, true);
    assert.equal(mail.options().auth.pass, 'secret');
    assert.equal(mail.message().to, 'invited@example.com');
    assert.match(mail.message().html, /href="https:\/\/rtk\.k6sh\.com\/login#token"/);
    assert.match(mail.message().text, /https:\/\/rtk\.k6sh\.com\/login#token/);
});
test('STARTTLS must be required when direct TLS is disabled', () => {
    const mail = fixture({ ...settings, SMTP_PORT: '587', SMTP_SECURE: 'false' });
    mail.create();
    assert.equal(mail.options().port, 587);
    assert.equal(mail.options().secure, false);
    assert.equal(mail.options().requireTLS, true);
});
test('mail needs settings and rejects a hostname containing a URL path or credentials', () => {
    assert.equal(fixture({}).create(), null);
    for (const PUBLIC_HOSTNAME of ['rtk.k6sh.com/path', 'user@rtk.k6sh.com']) {
        assert.throws(() => fixture({ ...settings, PUBLIC_HOSTNAME }).create());
    }
});
