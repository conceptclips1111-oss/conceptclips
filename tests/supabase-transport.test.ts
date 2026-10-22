import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { serverKey,supabaseTransport } from '../src/server/supabase-transport';

test('new API keys use apikey; real user JWTs and legacy Bearer keys are preserved',async()=>{
  const seen:Headers[]=[];
  const transport=supabaseTransport(async(_input,init)=>{seen.push(new Headers(init?.headers));return Response.json([]);});
  for(const key of ['sb_secret_fake-test-key','sb_publishable_fake-test-key','eyJ.legacy.test']) {
    await transport('https://example.supabase.co/rest/v1/products',{headers:{apikey:key,Authorization:`Bearer ${key}`}});
  }
  assert.equal(seen[0].get('authorization'),null); assert.equal(seen[0].get('apikey'),'sb_secret_fake-test-key');
  assert.equal(seen[1].get('authorization'),null);
  assert.equal(seen[2].get('authorization'),'Bearer eyJ.legacy.test');
  await transport('https://example.supabase.co/auth/v1/user',{headers:{apikey:'sb_publishable_fake-test-key',Authorization:'Bearer real-user-jwt'}});
  assert.equal(seen[3].get('authorization'),'Bearer real-user-jwt');
  assert.equal(seen[0].get('user-agent'),'AkhilNotesBackend/1.0');
});
test('the installed SDK sends database and admin auth requests correctly through the transport',async()=>{
  const seen:{path:string;headers:Headers}[]=[];
  const custom=supabaseTransport(async(input,init)=>{const path=new URL(String(input)).pathname;seen.push({path,headers:new Headers(init?.headers)});return Response.json(path.startsWith('/auth/') ? {id:'fake-user-id',phone:'919000000000'} : []);});
  const client=createClient('https://example.supabase.co','sb_secret_fake-test-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:custom}});
  const result=await client.from('products').select('id'); assert.equal(result.error,null);
  const user=await client.auth.admin.createUser({phone:'+919000000000',password:'NotARealPassword123',phone_confirm:true}); assert.equal(user.error,null);
  assert.equal(seen.length,2);
  for(const request of seen) {assert.equal(request.headers.get('authorization'),null);assert.equal(request.headers.get('apikey'),'sb_secret_fake-test-key');}
});
test('bad key types or corrupted secrets give a fixed message without leaking the value',()=>{
  assert.equal(serverKey(' sb_secret_fake-test-key\n'),'sb_secret_fake-test-key');
  for(const key of ['sb_publishable_NOT_A_SERVER_KEY','sbp_NOT_A_PROJECT_KEY','sb_secret_fake\u0016','eyJ.broken.payload']) {
    assert.throws(()=>serverKey(key),(e:any)=>e.message.includes('(DB_CONFIG)')&&!e.message.includes(key));
  }
});
