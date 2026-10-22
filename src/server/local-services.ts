import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Auth, Files, Repository, Services } from './contracts';
import { AppError } from './contracts';
import type { Order, OrderView, Product, Settings, Submission, User } from '../shared/types';

const normalize = (row: any) => row ? { ...row, published: !!row.published, is_demo: !!row.is_demo } : null;
const joined = `SELECT o.*, p.title AS product_title, p.subject, u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email FROM orders o JOIN products p ON p.id=o.product_id JOIN profiles u ON u.id=o.user_id`;
const defaults: Settings = { store_name: 'Akhil Notes', upi_id: '', payee_name: '', payments_enabled: false, support_email: '' };

export function localServices(dataDir: string, options: { seed?: boolean; memory?: boolean } = {}): Services & { db: DatabaseSync } {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(options.memory ? ':memory:' : resolve(dataDir, 'notes.sqlite'));
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer');
    CREATE TABLE IF NOT EXISTS auth_users(id TEXT PRIMARY KEY REFERENCES profiles(id), password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT REFERENCES profiles(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, title TEXT NOT NULL, subject TEXT NOT NULL, description TEXT NOT NULL, overview TEXT NOT NULL, price INTEGER NOT NULL, pages INTEGER NOT NULL, level TEXT NOT NULL, color TEXT NOT NULL, published INTEGER NOT NULL, file_key TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES profiles(id), product_id TEXT NOT NULL REFERENCES products(id), amount INTEGER NOT NULL, status TEXT NOT NULL, transaction_id TEXT UNIQUE, payer_name TEXT, paid_at TEXT, note TEXT, rejection_reason TEXT, created_at TEXT NOT NULL, submitted_at TEXT, reviewed_at TEXT, reviewed_by TEXT, payee_name TEXT NOT NULL, upi_id TEXT NOT NULL, is_demo INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_order ON orders(user_id,product_id) WHERE status IN ('awaiting_payment','pending','approved');
    CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id,created_at);
    CREATE INDEX IF NOT EXISTS orders_status ON orders(status,submitted_at);
    CREATE TABLE IF NOT EXISTS payment_references(transaction_id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id));
    CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
  `);
  const audit = (actor: string, action: string, target: string) => db.prepare('INSERT INTO audit_log VALUES(?,?,?,?,?)').run(crypto.randomUUID(), actor, action, target, new Date().toISOString());
  const tx = <T>(fn: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const order = (id: string): OrderView | null => normalize(db.prepare(`${joined} WHERE o.id=?`).get(id));
  const repo: Repository = {
    async profile(id) { return (db.prepare('SELECT * FROM profiles WHERE id=?').get(id) as User) || null; },
    async saveProfile(u) { db.prepare('INSERT INTO profiles VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email').run(u.id, u.phone, u.email, u.name, u.role); },
    async products(all = false) { return db.prepare(`SELECT * FROM products ${all ? '' : 'WHERE published=1'} ORDER BY updated_at DESC,id`).all().map(normalize); },
    async product(id) { return normalize(db.prepare('SELECT * FROM products WHERE id=?').get(id)); },
    async saveProduct(p) { db.prepare(`INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,subject=excluded.subject,description=excluded.description,overview=excluded.overview,price=excluded.price,pages=excluded.pages,level=excluded.level,color=excluded.color,published=excluded.published,file_key=excluded.file_key,updated_at=excluded.updated_at`).run(p.id, p.title, p.subject, p.description, p.overview, p.price, p.pages, p.level, p.color, Number(p.published), p.file_key, p.updated_at); },
    async settings() { const row = db.prepare('SELECT data FROM settings WHERE id=1').get() as any; return row ? JSON.parse(row.data) : defaults; },
    async saveSettings(s, actor) { tx(() => { db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(s)); audit(actor, 'settings.updated', 'store'); }); },
    async orders(userId) { return db.prepare(`${joined} ${userId ? 'WHERE o.user_id=?' : ''} ORDER BY o.created_at DESC`).all(...(userId ? [userId] : [])).map(normalize); },
    async order(id) { return order(id); },
    async createOrder(o) { return tx(() => {
      const existing = db.prepare(`SELECT id FROM orders WHERE user_id=? AND product_id=? ORDER BY created_at DESC LIMIT 1`).get(o.user_id, o.product_id) as any;
      if (existing) return order(existing.id)!;
      db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(o.id, o.user_id, o.product_id, o.amount, o.status, null, null, null, null, null, o.created_at, null, null, null, o.payee_name, o.upi_id, Number(o.is_demo));
      return order(o.id)!;
    }); },
    async submitOrder(id, userId, s) { tx(() => {
      const o = order(id); if (!o || o.user_id !== userId) throw new AppError(404, 'Order not found.');
      if (!['awaiting_payment', 'rejected'].includes(o.status)) throw new AppError(409, 'This order has already been submitted or approved.');
      const duplicate = db.prepare('SELECT id FROM orders WHERE transaction_id=? AND id<>?').get(s.transaction_id, id);
      const historical = db.prepare('SELECT 1 FROM payment_references WHERE transaction_id=? AND order_id<>?').get(s.transaction_id,id);
      if (duplicate || historical) throw new AppError(409, 'This transaction reference has already been submitted. Please check it or contact support.');
      db.prepare('INSERT INTO payment_references VALUES(?,?) ON CONFLICT(transaction_id) DO NOTHING').run(s.transaction_id,id);
      db.prepare(`UPDATE orders SET status='pending',transaction_id=?,payer_name=?,paid_at=?,note=?,submitted_at=?,rejection_reason=NULL,reviewed_at=NULL,reviewed_by=NULL WHERE id=?`).run(s.transaction_id, s.payer_name, s.paid_at, s.note, new Date().toISOString(), id);
      audit(userId, 'payment.submitted', id);
    }); },
    async decideOrder(id, actor, approve, reason) { tx(() => {
      const o = order(id); if (!o) throw new AppError(404, 'Order not found.');
      if (o.status !== 'pending') throw new AppError(409, 'This order is no longer awaiting review. Refresh the list.');
      db.prepare('UPDATE orders SET status=?,reviewed_at=?,reviewed_by=?,rejection_reason=? WHERE id=?').run(approve ? 'approved' : 'rejected', new Date().toISOString(), actor, approve ? null : reason, id);
      audit(actor, approve ? 'payment.approved' : 'payment.rejected', id);
    }); },
    async owns(uid, pid) { return !!db.prepare(`SELECT 1 FROM orders WHERE user_id=? AND product_id=? AND status='approved'`).get(uid, pid); },
    async rateLimit(key, limit, seconds) { const now = Date.now(); db.prepare('DELETE FROM rate_limits WHERE expires<?').run(now); const row = db.prepare('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').get(key, now + seconds * 1000) as any; return row.count <= limit; }
  };
  const passwordHash = (password: string) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
  const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
  const issue = (user: User) => { const token = randomBytes(32).toString('hex'); db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token), user.id, Date.now() + 604800000); return { user, token }; };
  const auth: Auth = {
    async register(input) {
      if (db.prepare('SELECT 1 FROM profiles WHERE phone=?').get(input.phone)) throw new AppError(409, 'Unable to register this phone number. Try logging in instead.');
      const u: User = { id: crypto.randomUUID(), name: input.name, phone: input.phone, email: input.email, role: 'customer' };
      tx(() => { db.prepare('INSERT INTO profiles VALUES(?,?,?,?,?)').run(u.id, u.phone, u.email, u.name, u.role); db.prepare('INSERT INTO auth_users VALUES(?,?)').run(u.id, passwordHash(input.password)); });
      return issue(u);
    },
    async login(phone, password) {
      const record = db.prepare('SELECT p.*, a.password FROM profiles p JOIN auth_users a ON a.id=p.id WHERE p.phone=?').get(phone) as any;
      const hash = record?.password || `00000000000000000000000000000000:${'00'.repeat(64)}`;
      const [salt, expected] = hash.split(':');
      if (!timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expected, 'hex')) || !record) throw new AppError(401, 'Phone number or password is incorrect.');
      const { password: _, ...user } = record; return issue(user);
    },
    async resolve(token) { if (!token) return null; const row = db.prepare('SELECT user_id FROM sessions WHERE token=? AND expires>?').get(tokenHash(token), Date.now()) as any; if (!row) return null; const user = await repo.profile(row.user_id); return user ? { user, token } : null; },
    async logout(token) { if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(tokenHash(token)); }
  };
  const filePath = (key: string) => { if (!/^[a-zA-Z0-9/-]+\.pdf$/.test(key)) throw new AppError(400, 'Invalid file key.'); const path = resolve(dataDir, 'pdfs', key); if (!path.startsWith(resolve(dataDir, 'pdfs') + '\\') && !path.startsWith(resolve(dataDir, 'pdfs') + '/')) throw new AppError(400, 'Invalid file path.'); return path; };
  const files: Files = {
    async put(key, data) { const path = filePath(key); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); },
    async get(key) { const path = filePath(key); if (!existsSync(path)) return null; const buf = readFileSync(path); return { body: new Uint8Array(buf), size: buf.length }; }
  };
  if (options.seed !== false) {
    const adminPhone = (process.env.LOCAL_ADMIN_PHONE || '9000000000').replace(/^\+91/, '');
    if (!db.prepare('SELECT 1 FROM profiles WHERE phone=?').get(`+91${adminPhone}`)) {
      const id = crypto.randomUUID(); db.prepare('INSERT INTO profiles VALUES(?,?,?,?,?)').run(id, `+91${adminPhone}`, 'admin@example.test', 'Store admin', 'admin');
      db.prepare('INSERT INTO auth_users VALUES(?,?)').run(id, passwordHash(process.env.LOCAL_ADMIN_PASSWORD || 'LocalAdmin!2026'));
    }
    if (!(db.prepare('SELECT COUNT(*) AS n FROM products').get() as any).n) {
      const samples = [
        ['Physics', 'Physics, made clear.', 'Mechanics & waves', 'From Newton\'s laws to wave motion, connect the ideas with concise explanations and worked examples.', 14900, 86, 'sage', 'Laws of motion\nWork, energy and power\nRotational motion\nOscillations and waves\nPractice questions with worked solutions'],
        ['Chemistry', 'A stronger foundation.', 'Physical chemistry', 'Build your understanding of the fundamentals, one concept and one carefully worked problem at a time.', 12900, 72, 'peach', 'Mole concept and stoichiometry\nAtomic structure\nThermodynamics\nChemical equilibrium\nRevision questions'],
        ['Mathematics', 'Make the numbers click.', 'Calculus essentials', 'A practical companion to limits, derivatives and integration, with the steps that textbooks sometimes skip.', 17900, 104, 'lavender', 'Limits and continuity\nDifferentiation\nApplications of derivatives\nIndefinite and definite integrals\nWorked examples'],
        ['Biology', 'See the bigger picture.', 'Cell & human biology', 'Clear explanations and a structured revision path through cells, biological processes and human physiology.', 9900, 64, 'sand', 'Cell structure and function\nBiomolecules\nCell division\nHuman physiology\nQuick revision checklist']
      ];
      for (const [subject, title, level, description, price, pages, color, overview] of samples) {
        const id = crypto.randomUUID(); const key = `${id}/sample.pdf`;
        const p: Product = { id, subject: subject as string, title: title as string, level: level as string, description: description as string, price: price as number, pages: pages as number, color: color as string, overview: overview as string, published: true, file_key: key, updated_at: new Date().toISOString() };
        db.prepare('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(p.id, p.title, p.subject, p.description, p.overview, p.price, p.pages, p.level, p.color, 1, key, p.updated_at);
        const content = `BT /F1 22 Tf 60 740 Td (Akhil Notes - DEMO PDF) Tj 0 -42 Td /F1 14 Tf (${subject} sample download) Tj 0 -30 Td (Local testing only. Upload your real notes in the admin portal.) Tj ET`;
        let pdf = '%PDF-1.4\n'; const offsets = [0]; const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
        objects.forEach((obj, i) => { offsets.push(pdf.length); pdf += `${i+1} 0 obj\n${obj}\nendobj\n`; }); const xref = pdf.length; pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
        const path = filePath(key); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, pdf);
      }
    }
  }
  return { repo, auth, files, local: true, db };
}
