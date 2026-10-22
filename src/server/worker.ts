import { createApp } from './app';
import { cloudServices, type CloudEnv } from './cloud-services';
export default {
  async fetch(request: Request, env: CloudEnv): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try {
      response = url.pathname.startsWith('/api/') ? await createApp(cloudServices(env)).fetch(request) : await env.ASSETS.fetch(request);
    } catch { response = Response.json({ error:'The store is not configured yet. Please contact the administrator.' }, { status:503 }); }
    response = new Response(response.body, response);
    response.headers.set('X-Content-Type-Options','nosniff');
    response.headers.set('Referrer-Policy','same-origin');
    response.headers.set('X-Frame-Options','DENY');
    response.headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    response.headers.set('Strict-Transport-Security','max-age=31536000');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    return response;
  }
};
