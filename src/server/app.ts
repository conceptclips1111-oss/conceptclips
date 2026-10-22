import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { AppError, type AuthResult, type Services } from './contracts';
import type { Order, Product, User } from '../shared/types';

const phone = z.string().trim().transform(v => v.replace(/[\s()-]/g, '')).transform(v => /^\d{10}$/.test(v) ? `+91${v}` : v).pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid phone number with country code.'));
const credentials = z.object({ phone, password: z.string().min(10, 'Use at least 10 characters.').max(128) });
const registration = credentials.extend({ name: z.string().trim().min(2).max(80), email: z.email().max(254) });
const productSchema = z.object({ title: z.string().trim().min(3).max(120), subject: z.string().trim().min(2).max(50), description: z.string().trim().min(10).max(400), overview: z.string().trim().min(10).max(8000), price: z.number().int().min(100).max(10000000), pages: z.number().int().min(1).max(10000), level: z.string().trim().min(2).max(60), color: z.enum(['sage', 'peach', 'lavender', 'sand']), published: z.boolean() });
const settingsSchema = z.object({ store_name: z.string().trim().min(2).max(80), upi_id: z.string().trim().max(100), payee_name: z.string().trim().max(100), payments_enabled: z.boolean(), support_email: z.union([z.literal(''), z.email()]) }).superRefine((v, ctx) => { if (v.payments_enabled && (!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/.test(v.upi_id) || !v.payee_name)) ctx.addIssue({ code: 'custom', message: 'Add a valid UPI ID and payee name before enabling payments.' }); });
const submissionSchema = z.object({ transaction_id: z.string().trim().transform(v => v.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9]{8,40}$/, 'Enter an 8–40 character UPI transaction reference, using letters and numbers.')), payer_name: z.string().trim().min(2).max(100), paid_at: z.iso.datetime({ offset: true }), note: z.string().trim().max(500).default('') });
const publicProduct = (p: Product) => { const { file_key, ...rest } = p; return { ...rest, has_pdf: !!file_key }; };

export function createApp(services: Services) {
  const app = new Hono<{ Variables: { user: User | null } }>();
  const { repo, auth, files, local } = services;
  const cookies = { httpOnly: true, secure: !local, sameSite: 'Strict' as const, path: '/' };
  function setSession(c: any, result: AuthResult) {
    setCookie(c, 'session', result.token, { ...cookies, maxAge: result.refresh ? 3600 : 604800 });
    if (result.refresh) setCookie(c, 'refresh', result.refresh, { ...cookies, maxAge: 604800 });
  }
  async function read<T>(c: any, schema: z.ZodType<T>): Promise<T> {
    if (!c.req.header('content-type')?.includes('application/json')) throw new AppError(415, 'Send JSON data.');
    const raw = await c.req.text();
    if (raw.length > 20000) throw new AppError(413, 'Request is too large.');
    try { return schema.parse(JSON.parse(raw)); }
    catch (e) { if (e instanceof z.ZodError) throw new AppError(400, e.issues[0].message); throw new AppError(400, 'Invalid JSON request.'); }
  }
  function signedIn(c: any): User { const u = c.get('user'); if (!u) throw new AppError(401, 'Please log in to continue.'); return u; }
  function admin(c: any): User { const u = signedIn(c); if (u.role !== 'admin') throw new AppError(403, 'Admin access required.'); return u; }
  async function limited(c: any, group: string, limit: number, seconds = 900, identity = '') {
    const ip = local ? 'local' : c.req.header('cf-connecting-ip') || 'unknown';
    const rawKey = new TextEncoder().encode(`${group}:${identity || ip}`);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', rawKey))).map(v => v.toString(16).padStart(2, '0')).join('');
    if (!await repo.rateLimit(hash, limit, seconds)) throw new AppError(429, 'Too many attempts. Please try again later.');
  }
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: err.message }, err.status as any);
    // Do not log request bodies, passwords, phone numbers, or database error details.
    console.error('Request failed', c.req.method, c.req.path, err.name);
    return c.json({ error: 'Something went wrong. Please try again.' }, 500);
  });
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      const expected = new URL(c.req.url).origin;
      if (!origin || (origin !== expected && !(local && /^http:\/\/(127\.0\.0\.1|localhost):(5173|8788)$/.test(origin)))) throw new AppError(403, 'Request origin is not allowed.');
      const size = Number(c.req.header('content-length') || 0);
      if (size > 30 * 1024 * 1024) throw new AppError(413, 'Maximum upload size is 30 MB.');
    }
    const token = getCookie(c, 'session');
    const refresh = getCookie(c, 'refresh');
    const session = token || refresh ? await auth.resolve(token, refresh) : null;
    c.set('user', session?.user || null);
    if (session && (session.token !== token || session.refresh && session.refresh !== refresh)) setSession(c, session);
    await next();
  });
  app.get('/api/health', c => c.json({ ok: true, mode: local ? 'local' : 'production' }));
  app.get('/api/settings', async c => c.json({ ...await repo.settings(), local }));
  app.get('/api/catalog', async c => c.json((await repo.products()).map(publicProduct)));
  app.get('/api/catalog/:id', async c => { const p = await repo.product(c.req.param('id')); if (!p?.published) throw new AppError(404, 'Notes not found.'); return c.json(publicProduct(p)); });
  app.get('/api/session', c => c.json({ user: c.get('user'), local }));
  app.post('/api/auth/register', async c => {
    await limited(c, 'register', local ? 100 : 10);
    const input = await read(c, registration);
    const session = await auth.register(input); setSession(c, session); return c.json({ user: session.user }, 201);
  });
  app.post('/api/auth/login', async c => {
    await limited(c, 'login-ip', local ? 200 : 30);
    // Login accepts existing passwords independently of signup password requirements.
    const input = await read(c, z.object({ phone, password: z.string().min(1).max(128) }));
    await limited(c, 'login-account', local ? 200 : 10, 900, input.phone);
    const session = await auth.login(input.phone, input.password); setSession(c, session); return c.json({ user: session.user });
  });
  app.post('/api/auth/logout', async c => { await auth.logout(getCookie(c, 'session')); deleteCookie(c, 'session', cookies); deleteCookie(c, 'refresh', cookies); return c.json({ ok: true }); });
  app.get('/api/orders', async c => c.json(await repo.orders(signedIn(c).id)));
  app.post('/api/orders', async c => {
    const user = signedIn(c); await limited(c, 'orders', 30, 3600, user.id);
    const { product_id } = await read(c, z.object({ product_id: z.string().uuid() }));
    const product = await repo.product(product_id);
    if (!product?.published || !product.file_key) throw new AppError(400, 'These notes are not available for purchase.');
    const settings = await repo.settings();
    if (!local && !settings.payments_enabled) throw new AppError(503, 'Payments are temporarily paused. Please check back soon.');
    const order: Order = { id: crypto.randomUUID(), user_id: user.id, product_id, amount: product.price, status: 'awaiting_payment', transaction_id: null, payer_name: null, paid_at: null, note: null, rejection_reason: null, created_at: new Date().toISOString(), submitted_at: null, reviewed_at: null, reviewed_by: null, upi_id: settings.upi_id, payee_name: settings.payee_name, is_demo: !settings.payments_enabled };
    return c.json(await repo.createOrder(order), 201);
  });
  app.get('/api/orders/:id', async c => {
    const user = signedIn(c); const order = await repo.order(c.req.param('id'));
    if (!order || order.user_id !== user.id) throw new AppError(404, 'Order not found.'); return c.json(order);
  });
  app.post('/api/orders/:id/submit', async c => {
    const user = signedIn(c); await limited(c, 'submit', 30, 3600, user.id);
    const input = await read(c, submissionSchema);
    const time = new Date(input.paid_at).getTime();
    if (time > Date.now() + 5 * 60000 || time < Date.now() - 30 * 86400000) throw new AppError(400, 'Enter a payment time within the last 30 days, not in the future.');
    await repo.submitOrder(c.req.param('id'), user.id, input); return c.json({ ok: true });
  });
  app.get('/api/downloads/:id', async c => {
    const user = signedIn(c); const id = c.req.param('id');
    if (!await repo.owns(user.id, id)) throw new AppError(403, 'Purchase approval is required before downloading.');
    await limited(c, 'downloads', 100, 3600, user.id);
    const product = await repo.product(id);
    if (!product?.file_key) throw new AppError(404, 'The PDF is unavailable. Please contact support.');
    const file = await files.get(product.file_key);
    if (!file) throw new AppError(404, 'The PDF is unavailable. Please contact support.');
    c.header('Content-Type', 'application/pdf'); c.header('Content-Length', String(file.size));
    c.header('Content-Disposition', `attachment; filename="${product.title.replace(/[^a-zA-Z0-9 -]/g, '').slice(0, 80) || 'notes'}.pdf"`);
    return c.body(file.body as any);
  });
  app.get('/api/admin/orders', async c => { admin(c); return c.json(await repo.orders()); });
  app.post('/api/admin/orders/:id/decision', async c => {
    const user = admin(c);
    const { approve, reason } = await read(c, z.object({ approve: z.boolean(), reason: z.string().trim().max(500).default('') }));
    if (!approve && !reason) throw new AppError(400, 'Please give the customer a reason for rejection.');
    await repo.decideOrder(c.req.param('id'), user.id, approve, reason); return c.json({ ok: true });
  });
  app.get('/api/admin/products', async c => { admin(c); return c.json((await repo.products(true)).map(publicProduct)); });
  app.post('/api/admin/products', async c => {
    admin(c); const input = await read(c, productSchema);
    if (input.published) throw new AppError(400, 'Save as a draft and upload a PDF before publishing.');
    const product: Product = { ...input, id: crypto.randomUUID(), file_key: null, updated_at: new Date().toISOString() };
    await repo.saveProduct(product); return c.json(publicProduct(product), 201);
  });
  app.patch('/api/admin/products/:id', async c => {
    admin(c); const input = await read(c, productSchema); const p = await repo.product(c.req.param('id'));
    if (!p) throw new AppError(404, 'Notes not found.');
    if (input.published && !p.file_key) throw new AppError(400, 'Upload a PDF before publishing.');
    const next = { ...p, ...input, updated_at: new Date().toISOString() }; await repo.saveProduct(next); return c.json(publicProduct(next));
  });
  app.put('/api/admin/products/:id/pdf', async c => {
    admin(c); const p = await repo.product(c.req.param('id')); if (!p) throw new AppError(404, 'Notes not found.');
    if (!c.req.header('content-type')?.includes('application/pdf')) throw new AppError(400, 'Upload a PDF file.');
    // Stream with a hard cap even when Content-Length is omitted.
    const reader = c.req.raw.body?.getReader(); if (!reader) throw new AppError(400, 'Upload a PDF file.');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 30 * 1024 * 1024) { await reader.cancel(); throw new AppError(413, 'Maximum PDF size is 30 MB.'); } chunks.push(value); }
    const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    if (new TextDecoder().decode(data.slice(0, 5)) !== '%PDF-') throw new AppError(400, 'This file is not a valid PDF.');
    const key = `${p.id}/${crypto.randomUUID()}.pdf`; await files.put(key, data);
    const next = { ...p, file_key: key, updated_at: new Date().toISOString() }; await repo.saveProduct(next); return c.json(publicProduct(next));
  });
  app.get('/api/admin/settings', async c => { admin(c); return c.json(await repo.settings()); });
  app.put('/api/admin/settings', async c => { const user = admin(c); const input = await read(c, settingsSchema); await repo.saveSettings(input, user.id); return c.json(input); });
  app.notFound(c => c.json({ error: 'Route not found.' }, 404));
  return app;
}
