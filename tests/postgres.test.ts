import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('production migration, profile trigger, atomic payment functions and access restrictions', async()=>{
  // Real PostgreSQL engine in WASM; auth.users/roles stand in for Supabase's managed auth schema.
  // This validates SQL independently of the SQLite development adapter, without cloud credentials.
  const pg = new PGlite();
  try {
    await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,phone text,raw_user_meta_data jsonb);`);
    await pg.exec(readFileSync(new URL('../supabase/migrations/001_store.sql',import.meta.url),'utf8'));
    const customer=crypto.randomUUID(), admin=crypto.randomUUID(), product=crypto.randomUUID(), order=crypto.randomUUID();
    await pg.query('insert into auth.users values($1,$2,$3)',[customer,'919111111111',JSON.stringify({name:'Customer',contact_email:'customer@example.test',role:'admin'})]);
    await pg.query('insert into auth.users values($1,$2,$3)',[admin,'919222222222',JSON.stringify({name:'Admin',contact_email:'admin@example.test'})]);
    const profile=await pg.query<{role:string}>('select role from profiles where id=$1',[customer]); assert.equal(profile.rows[0].role,'customer');
    await pg.query("update profiles set role='admin' where id=$1",[admin]);
    await pg.query(`insert into products values($1,'Physics notes','Physics','Detailed notes for testing','Laws of motion',14900,60,'Mechanics','sage',true,'private/test.pdf',now())`,[product]);
    const create=()=>pg.query<{create_store_order:string}>('select create_store_order($1)',[JSON.stringify({id:order,user_id:customer,product_id:product,amount:1})]);
    await assert.rejects(create,/Payments are temporarily paused/);
    await pg.query('select update_store_settings($1,$2)',[JSON.stringify({store_name:'Test Store',upi_id:'store@bank',payee_name:'Store',payments_enabled:true,support_email:''}),admin]);
    assert.equal((await create()).rows[0].create_store_order,order);
    assert.equal((await create()).rows[0].create_store_order,order);
    const priced=await pg.query<{amount:number;upi_id:string}>('select amount,upi_id from orders where id=$1',[order]); assert.equal(priced.rows[0].amount,14900); assert.equal(priced.rows[0].upi_id,'store@bank');
    const payment={transaction_id:'PGTEST123456',payer_name:'Customer',paid_at:new Date().toISOString(),note:''};
    await pg.query('select submit_store_payment($1,$2,$3)',[order,customer,JSON.stringify(payment)]);
    await assert.rejects(pg.query('select review_store_payment($1,$2,true,$3)',[order,customer,'']),/Admin access required/);
    await pg.query('select review_store_payment($1,$2,false,$3)',[order,admin,'Please check the reference.']);
    assert.equal((await create()).rows[0].create_store_order,order);
    await pg.query('select submit_store_payment($1,$2,$3)',[order,customer,JSON.stringify({...payment,transaction_id:'PGTEST654321'})]);
    await pg.query('select review_store_payment($1,$2,true,$3)',[order,admin,'']);
    const status=await pg.query<{status:string;transaction_id:string}>('select status,transaction_id from order_details where id=$1',[order]); assert.equal(status.rows[0].status,'approved'); assert.equal(status.rows[0].transaction_id,'PGTEST654321');
    await assert.rejects(pg.query('select review_store_payment($1,$2,false,$3)',[order,admin,'Too late']),/no longer awaiting review/);
    assert.equal((await pg.query('select * from payment_references')).rows.length,2);
    assert.equal((await pg.query('select * from audit_log')).rows.length,5);
    const limit=()=>pg.query<{take_rate_limit:boolean}>('select take_rate_limit($1,1,60)',['pg-limit']);
    assert.equal((await limit()).rows[0].take_rate_limit,true); assert.equal((await limit()).rows[0].take_rate_limit,false);
    await pg.exec('set role authenticated');
    await assert.rejects(pg.query('select * from orders'),/permission denied/);
    await assert.rejects(pg.query('select * from order_details'),/permission denied/);
    await assert.rejects(pg.query('select * from payment_references'),/permission denied/);
    await assert.rejects(pg.query('select review_store_payment($1,$2,true,$3)',[order,customer,'']),/permission denied/);
    await pg.exec('reset role');
  } finally { await pg.close(); }
});
