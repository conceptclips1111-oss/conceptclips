import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthResult, Repository, Services } from './contracts';
import { AppError } from './contracts';
import { serverKey, supabaseTransport } from './supabase-transport';
import type { Settings, User } from '../shared/types';

export type CloudEnv = { SUPABASE_URL: string; SUPABASE_ANON_KEY: string; SUPABASE_SERVICE_ROLE_KEY: string; PDFS: R2Bucket; ASSETS: Fetcher };
export function cloudServices(env: CloudEnv): Services {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY || !env.PDFS) throw new AppError(503, 'The store is not configured yet.');
  const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, global:{fetch:supabaseTransport()} };
  const db = createClient(env.SUPABASE_URL.trim(), serverKey(env.SUPABASE_SERVICE_ROLE_KEY), options);
  const authClient = () => createClient(env.SUPABASE_URL.trim(), env.SUPABASE_ANON_KEY.trim(), options);
  function check(error: any) {
    if (!error) return;
    if (error.code === '23505') throw new AppError(409, 'This transaction reference or order already exists. Please refresh and check.');
    if (['P0001','P0002'].includes(error.code)) throw new AppError(error.message.startsWith('NOT_FOUND') ? 404 : 409, error.message.replace(/^[A-Z_]+: ?/, ''));
    throw new AppError(503, 'The database is temporarily unavailable. Please try again.');
  }
  const repo: Repository = {
    async profile(id) { const { data, error } = await db.from('profiles').select('*').eq('id',id).maybeSingle(); check(error); return data; },
    async saveProfile(u) { const { error } = await db.from('profiles').upsert(u); check(error); },
    async products(all = false) { let q = db.from('products').select('*').order('updated_at', { ascending:false }); if (!all) q = q.eq('published',true); const { data, error } = await q; check(error); return data || []; },
    async product(id) { const { data, error } = await db.from('products').select('*').eq('id',id).maybeSingle(); check(error); return data; },
    async saveProduct(p) { const { error } = await db.from('products').upsert(p); check(error); },
    async settings() { const { data, error } = await db.from('store_settings').select('data').eq('id',1).single(); check(error); return data!.data as Settings; },
    async saveSettings(s, actor) { const { error } = await db.rpc('update_store_settings', { p_settings:s, p_actor:actor }); check(error); },
    async orders(uid) { let q = db.from('order_details').select('*').order('created_at', { ascending:false }).limit(10000); if (uid) q = q.eq('user_id',uid); const { data, error } = await q; check(error); return data || []; },
    async order(id) { const { data, error } = await db.from('order_details').select('*').eq('id',id).maybeSingle(); check(error); return data; },
    async createOrder(o) { const { data, error } = await db.rpc('create_store_order', { p_order:o }); check(error); return await repo.order(data) as any; },
    async submitOrder(id, uid, s) { const { error } = await db.rpc('submit_store_payment', { p_id:id, p_user:uid, p_submission:s }); check(error); },
    async decideOrder(id, actor, approve, reason) { const { error } = await db.rpc('review_store_payment', { p_id:id, p_actor:actor, p_approve:approve, p_reason:reason }); check(error); },
    async owns(uid, pid) { const { count, error } = await db.from('orders').select('id',{ count:'exact', head:true }).eq('user_id',uid).eq('product_id',pid).eq('status','approved'); check(error); return !!count; },
    async rateLimit(key, limit, seconds) { const { data, error } = await db.rpc('take_rate_limit', { p_key:key, p_limit:limit, p_seconds:seconds }); check(error); return data === true; }
  };
  const result = async (session: any, id: string): Promise<AuthResult> => { const user = await repo.profile(id); if (!user) throw new AppError(503,'Your account profile is unavailable. Please contact the store admin.'); return { user, token:session.access_token, refresh:session.refresh_token }; };
  return { local:false, repo,
    auth: {
      async register(input) {
        // Administrative signup permits unverified phone/password accounts with no SMS delivery.
        // Public auth metadata can never assign admin privileges: the database trigger forces customer.
        const { data, error } = await db.auth.admin.createUser({ phone:input.phone, password:input.password, phone_confirm:true, user_metadata:{ name:input.name, contact_email:input.email } });
        if (error || !data.user) throw new AppError(409,'Unable to create this account. Check the details or try logging in.');
        const { data: login, error: loginError } = await authClient().auth.signInWithPassword({ phone:input.phone, password:input.password });
        if (loginError || !login.session) throw new AppError(503,'Account created, but login is unavailable. Please try logging in again.');
        return result(login.session, data.user.id);
      },
      async login(phone, password) { const { data, error } = await authClient().auth.signInWithPassword({ phone,password }); if (error || !data.session) throw new AppError(401,'Phone number or password is incorrect.'); return result(data.session,data.user.id); },
      async resolve(token, refresh) {
        if (token) { const { data, error } = await authClient().auth.getUser(token); if (!error && data.user) { const user = await repo.profile(data.user.id); return user ? { user,token } : null; } }
        if (!refresh) return null;
        const { data, error } = await authClient().auth.refreshSession({ refresh_token:refresh }); if (error || !data.session || !data.user) return null; return result(data.session,data.user.id);
      },
      async logout(token) { if (token) await db.auth.admin.signOut(token,'global'); }
    },
    files: {
      async put(key, data) { await env.PDFS.put(key, data, { httpMetadata:{ contentType:'application/pdf' } }); },
      async get(key) { const o = await env.PDFS.get(key); return o ? { body:o.body as unknown as BodyInit, size:o.size } : null; }
    }
  };
}
