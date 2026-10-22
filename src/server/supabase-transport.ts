import { AppError } from './contracts';

export function serverKey(value: string): string {
  const key=value.trim();
  if (/\s|[\x00-\x1f\x7f]/.test(key) || (!key.startsWith('sb_secret_') && !key.startsWith('eyJ'))) {
    throw new AppError(503,'The Supabase backend secret has the wrong format. Configure a secret/service_role key in Cloudflare. (DB_CONFIG)');
  }
  if (key.startsWith('eyJ')) {
    try {
      const payload=JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      if (payload.role!=='service_role') throw new Error('wrong role');
    } catch { throw new AppError(503,'The Supabase backend secret is not a service_role key. Check the Cloudflare secret. (DB_CONFIG)'); }
  }
  return key;
}

/** Server-only requests. Keep opaque API keys out of JWT Bearer headers. */
export function supabaseTransport(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input,init) => {
    const headers=new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value,name)=>headers.set(name,value));
    const key=headers.get('apikey');
    if (key && /^(sb_secret_|sb_publishable_)/.test(key) && headers.get('authorization')===`Bearer ${key}`) {
      headers.delete('authorization');
    }
    headers.set('User-Agent','AkhilNotesBackend/1.0');
    return baseFetch(input,{...init,headers});
  };
}
