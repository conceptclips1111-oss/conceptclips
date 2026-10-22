import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app';
import { localServices } from '../src/server/local-services';
import type { User, Product, OrderView } from '../src/shared/types';

let services: ReturnType<typeof localServices>; let app: ReturnType<typeof createApp>; let directory: string;
let alice: string; let bob: string; let admin: string; let product: Product;
const request = async (path: string, method = 'GET', body?: unknown, token = '', extra: Record<string,string> = {}) => {
  const headers: Record<string,string> = { Origin:'http://localhost:8788', ...extra }; if(token) headers.Cookie=`session=${token}`;
  if (body !== undefined) headers['Content-Type']='application/json';
  return app.request(`http://localhost:8788/api${path}`, { method, headers, body:body === undefined ? undefined : JSON.stringify(body) });
};
const json = async (r: Response) => await r.json() as any;
const payment = (reference='123456789012') => ({ transaction_id:reference, payer_name:'Alice Example', paid_at:new Date().toISOString(), note:'Test payment' });
async function createOrder(token=alice) { const r=await request('/orders','POST',{product_id:product.id},token); assert.equal(r.status,201,JSON.stringify(await r.clone().json())); return await json(r) as OrderView; }
beforeEach(async () => {
  directory=mkdtempSync(join(tmpdir(),'akhil-notes-test-')); services=localServices(directory,{seed:false,memory:true}); app=createApp(services);
  const a=await services.auth.register({name:'Alice Example',phone:'+919111111111',email:'alice@example.test',password:'AliceSecret!123'}); alice=a.token;
  const b=await services.auth.register({name:'Bob Example',phone:'+919222222222',email:'bob@example.test',password:'BobSecret!1234'}); bob=b.token;
  const c=await services.auth.register({name:'Admin Example',phone:'+919333333333',email:'admin@example.test',password:'AdminSecret!123'});
  services.db.prepare("UPDATE profiles SET role='admin' WHERE id=?").run(c.user.id); admin=c.token;
  product={id:crypto.randomUUID(),title:'Mechanics notes',subject:'Physics',description:'Useful mechanics revision notes.',overview:'Laws of motion\nEnergy and power',price:14900,pages:80,level:'Mechanics essentials',color:'sage',published:true,file_key:'test/sample.pdf',updated_at:new Date().toISOString()};
  await services.repo.saveProduct(product); await services.files.put(product.file_key!,new TextEncoder().encode('%PDF-1.4\nSample test PDF'));
});
afterEach(() => { services.db.close(); rmSync(directory,{recursive:true,force:true}); });

test('registration normalizes Indian phone, creates customer, and issues HttpOnly session',async()=>{
  const r=await request('/auth/register','POST',{name:'Test Customer',phone:'98888 88888',email:'test@example.test',password:'SecretPassword12',role:'admin'});
  assert.equal(r.status,201); const data=await json(r); assert.equal(data.user.phone,'+919888888888'); assert.equal(data.user.role,'customer'); assert.match(r.headers.get('set-cookie')!,/HttpOnly/); assert.match(r.headers.get('set-cookie')!,/SameSite=Strict/);
});
test('authentication rejects incorrect passwords and invalid registration',async()=>{
  assert.equal((await request('/auth/login','POST',{phone:'9111111111',password:'incorrect'})).status,401);
  assert.equal((await request('/auth/register','POST',{name:'A',phone:'abc',email:'bad',password:'tiny'})).status,400);
});
test('logging out revokes the local session',async()=>{
  assert.equal((await request('/session','GET',undefined,alice)).status,200);
  assert.equal((await request('/auth/logout','POST',{},alice)).status,200);
  assert.equal((await request('/orders','GET',undefined,alice)).status,401);
});
test('catalogue excludes drafts and private object keys',async()=>{
  const draft={...product,id:crypto.randomUUID(),published:false}; await services.repo.saveProduct(draft);
  const list=await json(await request('/catalog')); assert.equal(list.length,1); assert.equal(list[0].file_key,undefined); assert.equal(list[0].has_pdf,true);
  assert.equal((await request(`/catalog/${draft.id}`)).status,404);
});
test('orders use server price and repeated creation returns the same order',async()=>{
  const r=await request('/orders','POST',{product_id:product.id,amount:1,status:'approved'},alice); const o=await json(r);
  assert.equal(o.amount,14900); assert.equal(o.status,'awaiting_payment'); assert.equal(o.is_demo,true);
  assert.equal((await createOrder()).id,o.id);
});
test('anonymous and other customers cannot see or submit an order',async()=>{
  const o=await createOrder();
  assert.equal((await request(`/orders/${o.id}`)).status,401);
  assert.equal((await request(`/orders/${o.id}`,'GET',undefined,bob)).status,404);
  assert.equal((await request(`/orders/${o.id}/submit`,'POST',payment(),bob)).status,404);
  assert.deepEqual(await json(await request('/orders','GET',undefined,bob)),[]);
});
test('customer cannot access admin or approve their own payment',async()=>{
  const o=await createOrder(); await request(`/orders/${o.id}/submit`,'POST',payment(),alice);
  assert.equal((await request('/admin/orders','GET',undefined,alice)).status,403);
  assert.equal((await request(`/admin/orders/${o.id}/decision`,'POST',{approve:true},alice)).status,403);
  assert.equal((await services.repo.order(o.id))!.status,'pending');
});
test('PDF is protected until admin approval, then only its owner can download',async()=>{
  const o=await createOrder();
  assert.equal((await request(`/downloads/${product.id}`,'GET',undefined,alice)).status,403);
  assert.equal((await request(`/orders/${o.id}/submit`,'POST',payment(),alice)).status,200);
  assert.equal((await request(`/downloads/${product.id}`,'GET',undefined,alice)).status,403);
  assert.equal((await request(`/admin/orders/${o.id}/decision`,'POST',{approve:true},admin)).status,200);
  const download=await request(`/downloads/${product.id}`,'GET',undefined,alice); assert.equal(download.status,200); assert.match(download.headers.get('content-type')!,/application\/pdf/); assert.match(await download.text(),/^%PDF/);
  assert.equal((await request(`/downloads/${product.id}`,'GET',undefined,bob)).status,403);
  assert.equal((await request(`/downloads/${product.id}`)).status,401);
});
test('duplicate transaction references are blocked across accounts',async()=>{
  const a=await createOrder(); const b=await createOrder(bob);
  assert.equal((await request(`/orders/${a.id}/submit`,'POST',payment('ABC123456789'),alice)).status,200);
  const r=await request(`/orders/${b.id}/submit`,'POST',payment('abc123456789'),bob); assert.equal(r.status,409);
});
test('submitting twice or racing review cannot change a completed decision',async()=>{
  const o=await createOrder(); await request(`/orders/${o.id}/submit`,'POST',payment(),alice);
  assert.equal((await request(`/orders/${o.id}/submit`,'POST',payment(),alice)).status,409);
  const results=await Promise.all([request(`/admin/orders/${o.id}/decision`,'POST',{approve:true},admin),request(`/admin/orders/${o.id}/decision`,'POST',{approve:false,reason:'Concurrent review'},admin)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
});
test('rejected orders show a reason and allow correction, not downloads',async()=>{
  const o=await createOrder(); await request(`/orders/${o.id}/submit`,'POST',payment(),alice);
  assert.equal((await request(`/admin/orders/${o.id}/decision`,'POST',{approve:false},admin)).status,400);
  await request(`/admin/orders/${o.id}/decision`,'POST',{approve:false,reason:'Reference does not match.'},admin);
  assert.equal((await createOrder()).id,o.id);
  assert.equal((await json(await request(`/orders/${o.id}`,'GET',undefined,alice))).rejection_reason,'Reference does not match.');
  assert.equal((await request(`/downloads/${product.id}`,'GET',undefined,alice)).status,403);
  assert.equal((await request(`/orders/${o.id}/submit`,'POST',payment('222222222222'),alice)).status,200);
  const other = await createOrder(bob);
  assert.equal((await request(`/orders/${other.id}/submit`,'POST',payment(),bob)).status,409);
});
test('UPI settings are admin-only and existing orders retain their payment destination',async()=>{
  const s={store_name:'Test Store',upi_id:'first@bank',payee_name:'First Payee',payments_enabled:true,support_email:''};
  assert.equal((await request('/admin/settings','PUT',s,alice)).status,403);
  assert.equal((await request('/admin/settings','PUT',s,admin)).status,200);
  const o=await createOrder(); assert.equal(o.upi_id,'first@bank'); assert.equal(o.is_demo,false);
  await request('/admin/settings','PUT',{...s,upi_id:'second@bank'},admin);
  assert.equal((await services.repo.order(o.id))!.upi_id,'first@bank');
  assert.equal((await request('/admin/settings','PUT',{...s,upi_id:''},admin)).status,400);
});
test('cross-origin writes, malformed payment times and invalid references are rejected',async()=>{
  assert.equal((await request('/auth/login','POST',{phone:'9111111111',password:'AliceSecret!123'},'',{Origin:'https://malicious.example'})).status,403);
  const o=await createOrder();
  assert.equal((await request(`/orders/${o.id}/submit`,'POST',payment('short'),alice)).status,400);
  assert.equal((await request(`/orders/${o.id}/submit`,'POST',{...payment(),paid_at:new Date(Date.now()+86400000).toISOString()},alice)).status,400);
});
test('admin publishing requires a private PDF and invalid uploads are rejected',async()=>{
  const {id,file_key,updated_at,...input}=product;
  assert.equal((await request('/admin/products','POST',input,admin)).status,400);
  const p=await json(await request('/admin/products','POST',{...input,published:false},admin));
  assert.equal((await request(`/admin/products/${p.id}`,'PATCH',input,admin)).status,400);
  const bad=await app.request(`http://localhost:8788/api/admin/products/${p.id}/pdf`,{method:'PUT',headers:{Origin:'http://localhost:8788',Cookie:`session=${admin}`,'Content-Type':'application/pdf'},body:'not a pdf'}); assert.equal(bad.status,400);
  const good=await app.request(`http://localhost:8788/api/admin/products/${p.id}/pdf`,{method:'PUT',headers:{Origin:'http://localhost:8788',Cookie:`session=${admin}`,'Content-Type':'application/pdf'},body:'%PDF-1.4\nvalid header test'}); assert.equal(good.status,200);
  assert.equal((await request(`/admin/products/${p.id}`,'PATCH',input,admin)).status,200);
});
test('server rate limit stops repeated attempts',async()=>{
  for(let i=0;i<3;i++) assert.equal(await services.repo.rateLimit('test-limit',3,60),true);
  assert.equal(await services.repo.rateLimit('test-limit',3,60),false);
});
