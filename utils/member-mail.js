const nodemailer = require('nodemailer');
function createMailer() {
    const env = process.env;
    if (!env.SMTP_HOST || !env.MAIL_FROM || !env.PUBLIC_HOSTNAME) return null;
    const base = new URL('https://' + env.PUBLIC_HOSTNAME);
    if (base.host !== env.PUBLIC_HOSTNAME || base.username || base.password) throw new Error('Invalid PUBLIC_HOSTNAME');
    const transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 465),
        secure: env.SMTP_SECURE !== 'false',
        requireTLS: env.SMTP_SECURE === 'false',
        ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
    return { send(email, token) {
        const url = new URL('/login', base); url.hash = token;
        const href = url.href.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        return transport.sendMail({ from: env.MAIL_FROM, to: email, subject: 'Sign in to NearTRIP',
            html: `<p><a href="${href}">Sign in to NearTRIP</a></p><p>This link expires in 15 minutes and can be used once. If you did not request it, ignore this email.</p>`,
            text: `Sign in to NearTRIP:\n\n${url.href}\n\nThis link expires in 15 minutes and can be used once. If you did not request it, ignore this email.` });
    } };
}
module.exports = { createMailer };
