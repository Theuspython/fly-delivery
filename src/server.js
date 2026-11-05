import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RealtimeClient } from '@supabase/realtime-js';

const root = fileURLToPath(new URL('../public/', import.meta.url)).replace(/\/$/, '');
const supabase = process.env.SUPABASE_URL?.replace(/\/$/, '');
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const googleMapsKey = process.env.GOOGLE_MAPS_BROWSER_KEY;
const routes = new Set(['/cliente/', '/loja/', '/entregador/', '/admin/']);
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};
const titles = { loja:'Estabelecimento', entregador:'Entregador', admin:'Administração' };
const apps = new Set(['cliente','loja','entregador','admin']);

function cookiesFor(req) {
  const app = req.headers['x-fd-app'];
  const scope = apps.has(app) ? app : 'cliente';
  return { sessionCookie:'fd_' + scope + '_access', refreshCookie:'fd_' + scope + '_refresh' };
}
const limit = 3 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function requestBody(req, maxBytes = limit) {
  if (Number(req.headers['content-length']) > maxBytes) throw new HttpError(413, 'Arquivo muito grande.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Arquivo muito grande.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function readCookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map(entry => {
    const index = entry.indexOf('=');
    return [entry.slice(0, index).trim(), entry.slice(index + 1)];
  }).filter(([name]) => name));
}

function setSession(req, res, tokens) {
  const { sessionCookie, refreshCookie } = cookiesFor(req);
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  const attributes = 'Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
  res.setHeader('Set-Cookie', [
    sessionCookie + '=' + (tokens?.access_token ?? '') + '; ' + attributes + '; Max-Age=' + (tokens ? tokens.expires_in + 60 : 0),
    refreshCookie + '=' + (tokens?.refresh_token ?? '') + '; ' + attributes + '; Max-Age=' + (tokens ? 2592000 : 0)
  ]);
}

async function upstream(path, { method = 'POST', token, body, type = 'application/json' } = {}) {
  if (!supabase || !publishableKey) throw new HttpError(503, 'O banco de dados ainda não foi configurado.');
  const headers = { apikey: publishableKey, 'Content-Type': type };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(supabase + path, {
    method, headers, body: type === 'application/json' && body !== undefined ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(path.startsWith('/functions/') ? 25000 : 12000)
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const message = data?.message ?? data?.msg ?? data?.error_description;
    if (data?.code === 'P0001' && message?.startsWith('FD: ')) throw new HttpError(409, message.slice(4));
    if (response.status === 401) throw new HttpError(401, 'Entre novamente para continuar.');
    if (path.startsWith('/functions/') && data?.code === 'FD_ONBOARDING' && typeof message === 'string') {
      throw new HttpError(response.status, message);
    }
    if (response.status === 429) throw new HttpError(429, 'Muitas tentativas. Aguarde e tente de novo.');
    if (path.startsWith('/auth/')) {
      const messages = {
        invalid_credentials: 'E-mail ou senha incorretos.',
        email_not_confirmed: 'Confirme seu e-mail antes de entrar.',
        weak_password: 'Escolha uma senha mais forte.',
        user_already_exists: 'Esse e-mail já tem conta. Entre para continuar.',
        over_email_send_rate_limit: 'Aguarde antes de solicitar outro e-mail.',
        email_address_not_authorized: 'O envio de e-mails de cadastro ainda precisa ser configurado.'
      };
      throw new HttpError(400, messages[data?.error_code ?? data?.code] ?? 'Não foi possível concluir o acesso.');
    }
    console.error('Supabase request failed', response.status, data?.code);
    throw new HttpError(response.status === 403 ? 403 : 502, 'Não foi possível concluir a operação.');
  }
  return data;
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Formato inválido.');
  try {
    return JSON.parse((await requestBody(req, 96 * 1024)).toString());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Dados inválidos.');
  }
}

function profileFields(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  let phone = typeof input?.phone === 'string' ? input.phone.replace(/\D/g,'') : '';
  if (phone.length > 11 && phone.startsWith('55')) phone = phone.slice(2);
  if (name.length < 3 || name.length > 120 || !/^[1-9][0-9]{9,10}$/.test(phone)) {
    throw new HttpError(400, 'Informe seu nome e um celular válido com DDD.');
  }
  return { name,phone };
}

async function streamOrders(req,res) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403,'Origem da requisição inválida.');
  const token = readCookies(req).fd_cliente_access;
  if (!token) throw new HttpError(401,'Entre para continuar.');
  const identity = await upstream('/auth/v1/user',{ method:'GET',token });
  if (res.destroyed) return;
  const url = new URL('/realtime/v1',supabase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const client = new RealtimeClient(url.toString(),{
    params:{ apikey:publishableKey }, accessToken:async () => token, transport:WebSocket
  });
  const notify = () => { if (!res.writableEnded && !res.destroyed) res.write('event: orders\ndata: {}\n\n'); };
  const channel = client.channel('fd-customer-orders').on('postgres_changes',{
    event:'*',schema:'public',table:'fd_order_updates',filter:'customer_id=eq.' + identity.id
  },notify);

  res.writeHead(200,{
    'Content-Type':'text/event-stream','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'
  });
  res.write('retry: 3000\n\n');
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'),15000);
  const timeout = setTimeout(() => res.end(),240000);
  res.once('close',() => {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    client.disconnect().catch(() => {});
  });
  channel.subscribe(status => {
    if (status === 'SUBSCRIBED') notify();
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') res.end();
  });
}

async function api(req, res, url) {
  const isRead = req.method === 'GET' && ['/api/catalog','/api/maps/browser-config','/api/order-updates'].includes(url.pathname);
  if (!isRead) {
    if (req.method !== 'POST') throw new HttpError(405, 'Método indisponível.');
    const origin = req.headers.origin;
    if (!origin || new URL(origin).host !== req.headers.host || req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpError(403, 'Origem da requisição inválida.');
    }
  }
  if (url.pathname === '/api/order-updates') return streamOrders(req,res);
  if (url.pathname === '/api/maps/browser-config') {
    const key = await upstream('/rest/v1/rpc/fd_google_browser_key',{ body:{} }).catch(() => null) || googleMapsKey;
    if (!key) throw new HttpError(503, 'O Google Maps ainda não está configurado. Você pode usar o GPS.');
    return json(res, 200, { key });
  }
  const { sessionCookie, refreshCookie } = cookiesFor(req);
  const cookies = readCookies(req);
  const access = cookies[sessionCookie];
  if (url.pathname === '/api/catalog') {
    const data = await upstream('/rest/v1/rpc/fd_api', { body: { action: 'catalog', input: {} } });
    return json(res, 200, data);
  }
  if (url.pathname === '/api/login' || url.pathname === '/api/signup') {
    const input = await readJson(req);
    const email = typeof input?.email === 'string' ? input.email.trim() : '';
    const password = input?.password;
    if (!email.includes('@') || email.length > 254 || typeof password !== 'string' || password.length < 8 || password.length > 128) {
      throw new HttpError(400, 'Informe um e-mail válido e uma senha de 8 a 128 caracteres.');
    }
    const signup = url.pathname.endsWith('/signup');
    if (signup && sessionCookie !== 'fd_cliente_access') throw new HttpError(403, 'O cadastro público é destinado aos clientes.');
    if (signup && input.confirmation !== password) throw new HttpError(400,'As senhas precisam ser iguais.');
    const credentials = { email,password };
    let data;
    if (!signup && sessionCookie === 'fd_admin_access') {
      data = await upstream('/functions/v1/fd-onboarding',{ body:{ action:'admin_login',input:credentials } })
        .catch(error => { if (error.status === 409) throw error; return null; });
    }
    if (!data?.access_token) {
      data = await upstream(signup ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password', {
        body:signup ? { ...credentials,data:{ fly_delivery_customer:profileFields(input) } } : credentials
      });
    }
    if (data.access_token) setSession(req, res, data);
    return json(res, 200, { signedIn: Boolean(data.access_token) });
  }
  if (url.pathname === '/api/logout') {
    if (access) {
      await upstream('/auth/v1/logout?scope=local', { token: access }).catch(() => {});
    }
    setSession(req, res, null);
    return json(res, 200, {});
  }
  if (url.pathname === '/api/refresh') {
    if (!cookies[refreshCookie]) throw new HttpError(401, 'Entre para continuar.');
    const tokens = await upstream('/auth/v1/token?grant_type=refresh_token', {
      body: { refresh_token: cookies[refreshCookie] }
    });
    setSession(req, res, tokens);
    return json(res, 200, {});
  }
  if (url.pathname === '/api/provision' || url.pathname === '/api/activate') {
    const provision = url.pathname === '/api/provision';
    if (provision && !access) throw new HttpError(401, 'Entre para continuar.');
    const input = await readJson(req);
    const data = await upstream('/functions/v1/fd-onboarding', {
      token:provision ? access : undefined,
      body:{ action:provision ? 'provision' : 'activate', input }
    });
    return json(res, 200, data);
  }
  if (url.pathname === '/api/command') {
    if (!access) throw new HttpError(401, 'Entre para continuar.');
    const { action, input } = await readJson(req) ?? {};
    if (typeof action !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) {
      throw new HttpError(400, 'Comando inválido.');
    }
    const payload = action === 'customer_profile' && ('name' in input || 'phone' in input) ? profileFields(input) : input;
    const data = await upstream('/rest/v1/rpc/fd_api', { token: access, body: { action, input:payload } });
    return json(res, 200, data);
  }
  if (url.pathname === '/api/upload') {
    if (!access) throw new HttpError(401, 'Entre para continuar.');
    const types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    const type = req.headers['content-type'];
    const store = url.searchParams.get('store') ?? '';
    if (!types[type] || !/^[0-9a-f-]{36}$/.test(store)) throw new HttpError(400, 'Envie uma foto JPG, PNG ou WebP.');
    const bytes = await requestBody(req);
    const valid = (type === 'image/jpeg' && bytes.subarray(0, 3).toString('hex') === 'ffd8ff') ||
      (type === 'image/png' && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') ||
      (type === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
    if (!valid) throw new HttpError(400, 'A foto não corresponde ao formato informado.');
    const key = store + '/' + crypto.randomUUID() + '.' + types[type];
    await upstream('/storage/v1/object/fly-delivery-menu/' + key, { token: access, body: bytes, type });
    return json(res, 201, { url: supabase + '/storage/v1/object/public/fly-delivery-menu/' + key });
  }
  throw new HttpError(404, 'Rota não encontrada.');
}

export function createApp() {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://maps.googleapis.com https://maps.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.google.com; worker-src 'self' blob:; frame-src https://*.google.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') return json(res, 200, { status: 'ok' });
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Método indisponível.');
      if (url.pathname === '/') {
        res.writeHead(308, { Location: '/cliente/' + url.search });
        return res.end();
      }
      if (routes.has(url.pathname + '/')) {
        res.writeHead(308, { Location: url.pathname + '/' + url.search });
        return res.end();
      }
      const path = routes.has(url.pathname) ? '/index.html' : decodeURIComponent(url.pathname);
      const file = resolve(root, '.' + path);
      const type = mime[extname(file)];
      if (!file.startsWith(root + sep) || !type || !(await stat(file).catch(() => null))?.isFile()) {
        throw new HttpError(404, 'Página não encontrada.');
      }
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=3600' : 'no-cache'
      });
      if (req.method === 'HEAD') return res.end();
      const page = url.pathname.split('/')[1];
      if (path === '/index.html' && titles[page]) {
        const html = (await readFile(file, 'utf8'))
          .replace('href="/cliente.webmanifest"', 'href="/' + page + '.webmanifest"')
          .replace('Fly Delivery · Peça bem, coma feliz', 'Fly Delivery · ' + titles[page]);
        return res.end(html);
      }
      res.end(await readFile(file));
    } catch (error) {
      if (!res.headersSent) {
        if (!(error instanceof HttpError)) console.error(error.name, error.message);
        json(res, error.status ?? 500, { error: error.status ? error.message : 'Ocorreu um erro. Tente novamente.' });
      } else res.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, '0.0.0.0', () => console.log('Fly Delivery na porta ' + port));
}
