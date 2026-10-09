import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../app.js';
import { requireBusinessAccess } from '../lib/authz.js';
import { getPool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { readSnapshot } from './snapshot.js';

/**
 * Emailing an invoice to a customer.
 *
 * The message is built HERE, from the invoice as saved, and never from HTML the
 * browser supplies. If the caller could send arbitrary HTML this would be an
 * open mail relay for anyone with an account — a phishing tool with our sending
 * domain on it. The caller chooses an invoice and a recipient; everything the
 * recipient reads comes from stored data, escaped.
 *
 * Sending goes through Resend's HTTP API. Without RESEND_API_KEY and EMAIL_FROM
 * the endpoint answers 501 and the front end falls back to opening the user's
 * own email app, so nothing breaks before an email account is set up.
 */

export function emailConfigured(): boolean {
  return !!(process.env['RESEND_API_KEY'] && process.env['EMAIL_FROM']);
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const bodyIn = z
  .object({
    invoiceRef: z.string().min(1).max(120),
    to: z.string().email().max(300),
    message: z.string().max(2000).optional(),
  })
  .strict();

interface Line { desc?: string; qty?: number; rate?: number; amount?: number }
interface Pay { include?: boolean; bankName?: string; accountName?: string; accountType?: string; accountNumber?: string; routingNumber?: string; notes?: string }

export default async function emailRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/businesses/:id/invoices/send',
    // Per address, per hour: a stolen session cannot be turned into a spam run.
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (req) => {
      const p = await authenticate(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { businessId } = await requireBusinessAccess(p, id, 'accountant');

      if (!emailConfigured()) {
        throw new HttpError(501, 'email_not_configured', 'Sending email from the platform is not set up yet.');
      }
      const parsed = bodyIn.safeParse(req.body);
      if (!parsed.success) throw badRequest('That email request was malformed: check the address.');
      const { invoiceRef, to, message } = parsed.data;

      const snap = (await readSnapshot(businessId)) as { invoices?: Array<Record<string, any>> };
      const inv = (snap.invoices ?? []).find((i) => i['id'] === invoiceRef);
      if (!inv) throw notFound('That invoice');

      const { rows } = await getPool().query(
        `SELECT name, email, address, currency, bank_name, account_name, account_type,
                account_number, routing_number, payment_instructions
           FROM businesses WHERE id = $1`,
        [businessId],
      );
      const b = rows[0] as Record<string, string>;
      const sym = esc(b['currency'] || '$');
      const money = (n: unknown) =>
        sym + Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      const subtotal = Number(inv['amount']);
      const tax = (subtotal * Number(inv['taxRate'] ?? 0)) / 100;
      const total = subtotal + tax;
      const lines: Line[] = Array.isArray(inv['lines']) && inv['lines'].length
        ? inv['lines']
        : [{ desc: inv['desc'] || 'Services rendered', qty: 1, rate: subtotal, amount: subtotal }];

      // Payment details follow what was chosen on the invoice; older invoices
      // without a choice fall back to the business's own details.
      const pay: Pay = inv['payment'] ?? {
        include: true, bankName: b['bank_name'], accountName: b['account_name'], accountType: b['account_type'],
        accountNumber: b['account_number'], routingNumber: b['routing_number'], notes: b['payment_instructions'],
      };
      const payRows: Array<[string, string]> = [];
      if (pay.include) {
        if (pay.bankName) payRows.push(['Bank', pay.bankName]);
        if (pay.accountName) payRows.push(['Account name', pay.accountName]);
        if (pay.accountType) payRows.push(['Account type', pay.accountType]);
        if (pay.accountNumber) payRows.push(['Account number', pay.accountNumber]);
        if (pay.routingNumber) payRows.push(['Routing / ABA', pay.routingNumber]);
      }
      const payNotes = pay.include ? pay.notes ?? '' : '';

      const biz = esc(b['name']);
      const td = 'padding:8px 10px;border-bottom:1px solid #eee;font-size:14px';
      const html = `<!doctype html><html><body style="margin:0;background:#f5f5f3;font-family:Arial,Helvetica,sans-serif;color:#1a1a18">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden">
<tr><td style="background:#0B1E33;color:#fff;padding:20px 24px"><div style="font-size:18px;font-weight:bold">${biz}</div><div style="color:#8FD9E8;font-size:13px;margin-top:4px">Invoice ${esc(inv['id'])}</div></td></tr>
<tr><td style="padding:24px">
${message ? `<p style="margin:0 0 16px;font-size:14px;white-space:pre-line">${esc(message)}</p>` : `<p style="margin:0 0 16px;font-size:14px">Hi ${esc(inv['client'])}, please find your invoice below.</p>`}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;font-size:13px;color:#4b5563"><tr><td>Invoice date: <strong>${esc(inv['date'])}</strong></td><td align="right">Due: <strong>${esc(inv['due'])}</strong></td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f5f5f3"><th align="left" style="${td}">Description</th><th align="center" style="${td}">Qty</th><th align="right" style="${td}">Rate</th><th align="right" style="${td}">Amount</th></tr>
${lines.map((l) => `<tr><td style="${td}">${esc(l.desc)}</td><td align="center" style="${td}">${esc(l.qty)}</td><td align="right" style="${td}">${money(l.rate)}</td><td align="right" style="${td}">${money(l.amount)}</td></tr>`).join('')}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;font-size:14px"><tr><td align="right">Subtotal&nbsp;&nbsp;<strong>${money(subtotal)}</strong></td></tr>
${tax ? `<tr><td align="right">Tax (${esc(inv['taxRate'])}%)&nbsp;&nbsp;<strong>${money(tax)}</strong></td></tr>` : ''}
<tr><td align="right" style="font-size:18px;padding-top:6px">Total due&nbsp;&nbsp;<strong>${money(total)}</strong></td></tr></table>
${payRows.length || payNotes ? `<div style="margin-top:20px;padding:14px;border:1px solid #eee;border-radius:6px;font-size:13px;line-height:1.6"><div style="font-weight:bold;margin-bottom:6px">Payment instructions</div>${payRows.map(([k, v]) => `<div><strong>${esc(k)}:</strong> ${esc(v)}</div>`).join('')}${payNotes ? `<div style="margin-top:6px;white-space:pre-line">${esc(payNotes)}</div>` : ''}</div>` : ''}
<p style="margin:24px 0 0;font-size:13px;color:#6b6b67">Thank you for your business.${b['email'] ? ` Questions? Reply to this email or write to ${esc(b['email'])}.` : ''}</p>
</td></tr></table></td></tr></table></body></html>`;

      const text = [
        `Invoice ${inv['id']} from ${b['name']}`,
        message || `Hi ${inv['client']}, please find your invoice below.`,
        '',
        `Invoice date: ${inv['date']}   Due: ${inv['due']}`,
        ...lines.map((l) => `- ${l.desc ?? ''}  ${l.qty ?? 1} x ${Number(l.rate ?? 0).toFixed(2)} = ${Number(l.amount ?? 0).toFixed(2)}`),
        `Subtotal: ${subtotal.toFixed(2)}`,
        ...(tax ? [`Tax: ${tax.toFixed(2)}`] : []),
        `TOTAL DUE: ${total.toFixed(2)}`,
        ...(payRows.length ? ['', 'Payment instructions', ...payRows.map(([k, v]) => `${k}: ${v}`)] : []),
        ...(payNotes ? [payNotes] : []),
      ].join('\n');

      let res: Response;
      try {
        res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${process.env['RESEND_API_KEY']}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: process.env['EMAIL_FROM'],
            to: [to],
            subject: `Invoice ${inv['id']} from ${b['name']}`,
            html,
            text,
            ...(b['email'] ? { reply_to: b['email'] } : {}),
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new HttpError(502, 'email_failed', 'The email service did not respond. Nothing was sent; try again.', err);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new HttpError(502, 'email_failed', 'The email service refused the message. Nothing was sent.', { status: res.status, detail });
      }

      await audit({
        userId: p.userId, businessId, action: 'invoice.email', entity: 'invoice', entityId: String(inv['id']),
        detail: { to, invoice: inv['id'] }, ip: req.ip, requestId: String(req.id),
      });
      return { ok: true };
    },
  );
}
