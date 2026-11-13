import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createBilling } from './billing.js';
import { catalogPage } from './catalog.js';
import { RealtimeClient } from '@supabase/realtime-js';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../public/', import.meta.url)).replace(/\/$/, '');
const supabase = process.env.SUPABASE_URL?.replace(/\/$/, '');
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const adminLogin = process.env.FLY_DELIVERY_ADMIN_LOGIN?.trim();
const adminPassword = process.env.FLY_DELIVERY_ADMIN_PASSWORD;
const adminBridge = process.env.FD_ADMIN_BRIDGE_TOKEN;
const customerLookupKey = process.env.FD_CUSTOMER_LOOKUP_KEY;
const routes = new Set(['/cliente/', '/loja/', '/admin/']);
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};
const titles = { loja:'Estabelecimento', admin:'Administração' };
const apps = new Set(['cliente','loja','admin']);
const assetLinksFile = resolve(root, '.well-known/assetlinks.json');

function cookiesFor(req) {
  const app = req.headers['x-fd-app'];
  if (app === 'entregador') throw new HttpError(410,'O aplicativo de entregadores foi encerrado. A entrega é feita pelo estabelecimento.');
  const scope = apps.has(app) ? app : 'cliente';
  return { sessionCookie:'fd_' + scope + '_access', refreshCookie:'fd_' + scope + '_refresh' };
}
const limit = 3 * 1024 * 1024;
const maxImageSourceBytes = 20 * 1024 * 1024;
const maxImageBytes = 50_000;

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

async function readImage(req) {
  const types = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp' };
  const type = req.headers['content-type'];
  if (!types[type]) throw new HttpError(400,'Envie uma foto JPG, PNG ou WebP.');
  const bytes = await requestBody(req,maxImageSourceBytes);
  const valid = (type === 'image/jpeg' && bytes.subarray(0,3).toString('hex') === 'ffd8ff') ||
    (type === 'image/png' && bytes.subarray(0,8).toString('hex') === '89504e470d0a1a0a') ||
    (type === 'image/webp' && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP');
  if (!valid) throw new HttpError(400,'A foto não corresponde ao formato informado.');
  return { bytes,type,extension:types[type] };
}

async function compactImage(image) {
  if (image.bytes.length <= maxImageBytes) return image;
  try {
    const source = sharp(image.bytes,{limitInputPixels:40_000_000}).autoOrient();
    for (const [edge,quality] of [[960,80],[800,72],[640,72],[480,70],[360,64],[256,56],[192,50]]) {
      const bytes = await source.clone().resize(edge,edge,{fit:'inside',withoutEnlargement:true})
        .webp({quality}).toBuffer();
      if (bytes.length <= maxImageBytes) return {bytes,type:'image/webp',extension:'webp'};
    }
  } catch {
    throw new HttpError(400,'Não foi possível abrir esta foto. Escolha outra imagem JPG, PNG ou WebP.');
  }
  throw new HttpError(400,'Não foi possível reduzir esta foto a 50 KB. Escolha outra imagem.');
}

const profilePhotoPath = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

function menuPhotoKey(url,store) {
  const prefix = supabase + '/storage/v1/object/public/fly-delivery-menu/';
  if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length);
  return profilePhotoPath.test(key) && key.startsWith(store + '/') ? key : null;
}

async function serveProfilePhoto(req,res,url) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403,'Origem da requisição inválida.');
  const scope = url.searchParams.get('scope');
  const path = url.searchParams.get('path') ?? '';
  if (!['cliente','loja'].includes(scope) || !profilePhotoPath.test(path)) throw new HttpError(400,'Foto inválida.');
  const token = readCookies(req)['fd_' + scope + '_access'];
  if (!token) throw new HttpError(401,'Entre para ver a foto.');
  if (!supabase || !publishableKey) throw new HttpError(503,'As fotos estão indisponíveis.');
  const response = await fetch(supabase + '/storage/v1/object/authenticated/fly-delivery-profiles/' + path,{
    headers:{ apikey:publishableKey,Authorization:'Bearer ' + token },signal:AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new HttpError(response.status === 401 ? 401 : 404,'Foto indisponível.');
  const type = response.headers.get('content-type')?.split(';')[0];
  if (!['image/jpeg','image/png','image/webp'].includes(type)) throw new HttpError(502,'Foto indisponível.');
  const bytes = Buffer.from(await response.arrayBuffer());
  res.writeHead(200,{ 'Content-Type':type,'Cache-Control':'private, no-store' });
  res.end(bytes);
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

async function upstream(path, { method = 'POST', token, body, type = 'application/json', timeout = path.startsWith('/functions/') ? 25000 : 12000 } = {}) {
  if (!supabase || !publishableKey) throw new HttpError(503, 'O banco de dados ainda não foi configurado.');
  const headers = { apikey: publishableKey, 'Content-Type': type };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(supabase + path, {
    method, headers, body: type === 'application/json' && body !== undefined ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(timeout)
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const message = data?.message ?? data?.msg ?? data?.error_description;
    if (data?.code === '57014' && path.endsWith('/fd_admin_history_cleanup')) {
      throw new HttpError(504,'O período levou muito tempo para processar. Consulte uma prévia com um intervalo menor.');
    }
    if (data?.code === 'P0001' && message?.startsWith('FD: ')) throw new HttpError(message==='FD: Fatura não encontrada.'?404:409, message.slice(4));
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

async function removePhoto(bucket,key,token) {
  for (let attempt=0;attempt<2;attempt++) {
    try {
      await upstream('/storage/v1/object/'+bucket,{method:'DELETE',token,body:{prefixes:[key]},timeout:4000});
      return;
    } catch (error) {
      if (attempt===1 || (error.status && error.status<500 && error.status!==429)) {
        console.error('Could not remove a replaced photo',bucket,error.status ?? error.name);
        return;
      }
    }
  }
}

const billing = createBilling({rpc:(action,input)=>upstream('/rest/v1/rpc/fd_billing_backend',{
  body:{secret:process.env.FD_BILLING_BRIDGE_TOKEN,action,input}
})});
const billingRate = new Map();
function limitBilling(req,max){
  const key=String(req.headers['x-real-ip']??req.socket.remoteAddress??'unknown').slice(0,80)+':'+new URL(req.url,'http://localhost').pathname;
  const now=Date.now();
  for(const [id,value] of billingRate)if(value.until<=now)billingRate.delete(id);
  const entry=billingRate.get(key)??{count:0,until:now+60000};
  if(entry.count>=max||(!billingRate.has(key)&&billingRate.size>=4096))throw new HttpError(429,'Muitas solicitações de pagamento. Aguarde um minuto.');
  entry.count++;billingRate.set(key,entry);
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

const adminFailures = new Map();
const adminAttemptWindow = 15 * 60 * 1000;

function verifyAdminLogin(req,input) {
  if (!adminLogin || adminLogin === 'PREENCHER' || !adminPassword || adminPassword === 'PREENCHER' || !adminBridge) {
    throw new HttpError(503,'Preencha FLY_DELIVERY_ADMIN_LOGIN e FLY_DELIVERY_ADMIN_PASSWORD no Railway e aplique as alterações.');
  }
  const now = Date.now();
  const client = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '').slice(0,64);
  for (const [key,attempt] of adminFailures) {
    if (attempt.until <= now) adminFailures.delete(key);
  }
  const key = adminFailures.has(client) || adminFailures.size < 2048 ? client : 'overflow';
  const attempt = adminFailures.get(key) ?? { count:0, until:now + adminAttemptWindow };
  if (attempt.count >= 10) throw new HttpError(429,'Muitas tentativas. Aguarde alguns minutos.');
  const login = typeof input?.login === 'string' ? input.login.trim() : '';
  const password = typeof input?.password === 'string' ? input.password : '';
  const digest = value => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(login),digest(adminLogin)) || !timingSafeEqual(digest(password),digest(adminPassword))) {
    adminFailures.set(key,{ count:attempt.count+1,until:attempt.until });
    throw new HttpError(401,'Login ou senha incorretos.');
  }
  adminFailures.delete(key);
}

function cpfLoginId(value) {
  const cpf = typeof value === 'string' ? value.replace(/\D/g,'') : '';
  const valid = cpf.length === 11 && !/^(\d)\1+$/.test(cpf) && [9,10].every(length => {
    const sum = Array.from(cpf.slice(0,length)).reduce((total,digit,index) => total + Number(digit)*(length+1-index),0);
    return ((sum*10)%11)%10 === Number(cpf[length]);
  });
  if (!valid) throw new HttpError(400,'Informe um CPF válido.');
  if (!customerLookupKey || !adminBridge) throw new HttpError(503,'O acesso de clientes está indisponível.');
  return createHmac('sha256',customerLookupKey).update(cpf).digest('hex').slice(0,40);
}

function operatorIdentity(value,role) {
  const login = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(login)) {
    throw new HttpError(400,'Use um login de 3 a 40 caracteres, com letras, números, ponto, hífen ou sublinhado.');
  }
  if (!customerLookupKey || !adminBridge) throw new HttpError(503,'O acesso está indisponível.');
  const operatorId = createHmac('sha256',customerLookupKey).update('operator:' + role + ':' + login).digest('hex').slice(0,40);
  return { login,operatorId,role };
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
    params:{ apikey:publishableKey }, transport:WebSocket
  });
  await client.setAuth(token);
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

let catalogCache;
let catalogRequest;
function catalogSnapshot() {
  if (catalogCache && catalogCache.expires > Date.now()) return Promise.resolve(catalogCache.stores);
  if (catalogRequest) return catalogRequest;
  const request = upstream('/rest/v1/rpc/fd_api', {body:{action:'catalog',input:{}}}).then(stores => {
    if (catalogRequest === request) catalogCache = {stores,expires:Date.now()+4000};
    return stores;
  }).finally(() => {
    if (catalogRequest === request) catalogRequest = null;
  });
  catalogRequest = request;
  return request;
}

async function api(req, res, url) {
  const isRead = req.method === 'GET' && ['/api/catalog','/api/order-updates','/api/profile-photo'].includes(url.pathname);
  if (!isRead) {
    if (req.method !== 'POST') throw new HttpError(405, 'Método indisponível.');
    const origin = req.headers.origin;
    if (!origin || new URL(origin).host !== req.headers.host || req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpError(403, 'Origem da requisição inválida.');
    }
  }
  if (url.pathname === '/api/profile-photo' && req.method === 'GET') return serveProfilePhoto(req,res,url);
  if (url.pathname === '/api/order-updates') return streamOrders(req,res);
  const { sessionCookie, refreshCookie } = cookiesFor(req);
  const cookies = readCookies(req);
  const access = cookies[sessionCookie];
  if (url.pathname === '/api/catalog') {
    const stores = await catalogSnapshot();
    const view = url.searchParams.get('view');
    if (view === 'page') return json(res,200,catalogPage(stores,url.searchParams));
    if (view === 'store') return json(res,200,stores.find(store => store.id === url.searchParams.get('id')) ?? null);
    return json(res,200,stores);
  }
  if (url.pathname === '/api/login' || url.pathname === '/api/signup') {
    const input = await readJson(req);
    const signup = url.pathname.endsWith('/signup');
    if (signup && sessionCookie !== 'fd_cliente_access') {
      throw new HttpError(403,'O cadastro público é destinado aos clientes.');
    }
    if (sessionCookie === 'fd_admin_access') {
      verifyAdminLogin(req,input);
      const data = await upstream('/functions/v1/fd-onboarding',{
        token:adminBridge,body:{ action:'admin_login',input:{} }
      });
      if (!data?.access_token) throw new HttpError(502,'Não foi possível iniciar a sessão administrativa.');
      setSession(req,res,data);
      return json(res,200,{ signedIn:true });
    }
    if (sessionCookie === 'fd_cliente_access' && (signup || Object.hasOwn(input ?? {},'cpf'))) {
      const password = input?.password;
      if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) {
        throw new HttpError(400,'Use uma senha com pelo menos 8 caracteres e até 72 bytes.');
      }
      const loginId = cpfLoginId(input.cpf);
      const data = await upstream('/functions/v1/fd-onboarding',{
        token:adminBridge,body:{ action:signup ? 'customer_register' : 'customer_login',
          input:{ loginId,password,...(signup ? profileFields(input) : {}) } }
      });
      if (!data?.access_token) throw new HttpError(502,'Não foi possível concluir o acesso.');
      setSession(req,res,data);
      return json(res,200,{ signedIn:true });
    }
    const operatorRole = sessionCookie === 'fd_loja_access' ? 'merchant' : null;
    if (operatorRole && typeof input?.login === 'string' && !input.login.includes('@')) {
      const identity = operatorIdentity(input.login,operatorRole);
      const data = await upstream('/functions/v1/fd-onboarding',{
        token:adminBridge,body:{ action:'operator_login',input:{ ...identity,password:input.password } }
      });
      if (!data?.access_token) throw new HttpError(502,'Não foi possível iniciar a sessão.');
      setSession(req,res,data);
      return json(res,200,{ signedIn:true });
    }
    const credential = operatorRole ? (input?.login ?? input?.email) : input?.email;
    const email = typeof credential === 'string' ? credential.trim() : '';
    const password = input?.password;
    if (!email.includes('@') || email.length > 254 || typeof password !== 'string' || password.length < 8 || password.length > 128) {
      throw new HttpError(400, 'Informe um e-mail válido e uma senha de 8 a 128 caracteres.');
    }
    const data = await upstream('/auth/v1/token?grant_type=password',{ body:{ email,password } });
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
  if (url.pathname === '/api/provision' || url.pathname === '/api/activate' || url.pathname === '/api/change-password') {
    const provision = url.pathname === '/api/provision';
    const change = url.pathname === '/api/change-password';
    if (provision && (sessionCookie !== 'fd_admin_access' || !access)) throw new HttpError(401,'Entre na administração para continuar.');
    if (change && (sessionCookie !== 'fd_loja_access' || !access)) throw new HttpError(401,'Entre no estabelecimento para continuar.');
    const input = await readJson(req);
    if (provision && input?.kind !== 'store') throw new HttpError(400,'A administração cadastra apenas estabelecimentos.');
    const payload = provision ? { ...input,...operatorIdentity(input?.login,'merchant') } : input;
    const data = await upstream('/functions/v1/fd-onboarding',{
      token:provision || change ? access : undefined,
      body:{ action:provision ? 'provision' : change ? 'operator_change_password' : 'activate',input:payload }
    });
    if (change) setSession(req,res,null);
    return json(res,200,data);
  }
  if (url.pathname === '/api/billing/checkout' || url.pathname === '/api/billing/verify') {
    if(!access||sessionCookie!=='fd_loja_access')throw new HttpError(401,'Entre no estabelecimento para continuar.');
    limitBilling(req,15);
    const identity=await upstream('/rest/v1/rpc/fd_api',{token:access,body:{action:'session',input:{}}});
    if(identity.role!=='merchant')throw new HttpError(403,'Acesso restrito ao estabelecimento.');
    const input=await readJson(req);
    if(!input||typeof input!=='object'||Array.isArray(input))throw new HttpError(400,'Dados de pagamento inválidos.');
    const data=url.pathname.endsWith('/checkout')?await billing.checkout(identity.id,input.id):await billing.confirm(input,identity.id);
    return json(res,200,data);
  }
  if (url.pathname === '/api/command') {
    if (!access) throw new HttpError(401, 'Entre para continuar.');
    const { action, input } = await readJson(req) ?? {};
    if (typeof action !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) {
      throw new HttpError(400, 'Comando inválido.');
    }
    if (action === 'admin_history_cleanup') {
      if (sessionCookie !== 'fd_admin_access') throw new HttpError(403,'Acesso exclusivo da administração.');
      const data = await upstream('/rest/v1/rpc/fd_admin_history_cleanup',{ token:access,body:{input},timeout:50000 });
      return json(res,200,data);
    }
    const payload = action === 'customer_profile' && ('name' in input || 'phone' in input) ? profileFields(input) : input;
    const data = await upstream('/rest/v1/rpc/fd_api', { token: access, body: { action, input:payload } });
    if (['set_product_availability','save_product','delete_product','save_menu_product_order','save_menu_category_order',
      'merchant_delete_coupon'].includes(action)) {
      catalogCache = catalogRequest = null;
    }
    if (action==='save_store_profile' || action==='save_product' || action==='delete_product') {
      const {replaced_photo,...saved} = data;
      const key = menuPhotoKey(replaced_photo,action==='save_store_profile' ? input.id : input.store_id);
      if (key) await removePhoto('fly-delivery-menu',key,access);
      return json(res,200,saved);
    }
    return json(res, 200, data);
  }
  if (url.pathname === '/api/upload-profile') {
    if (sessionCookie !== 'fd_cliente_access' || !access) throw new HttpError(401,'Entre como cliente para enviar sua foto.');
    const image = await readImage(req);
    const user = await upstream('/rest/v1/rpc/fd_api',{ token:access,body:{ action:'session',input:{} } });
    if (user?.role !== 'customer') throw new HttpError(403,'Foto exclusiva do perfil do cliente.');
    const previous = await upstream('/rest/v1/rpc/fd_api',{ token:access,body:{ action:'customer_profile',input:{} } });
    if (!previous) throw new HttpError(409,'Complete seu cadastro antes de enviar a foto.');
    const { bytes,type,extension } = await compactImage(image);
    const key = user.id + '/' + crypto.randomUUID() + '.' + extension;
    await upstream('/storage/v1/object/fly-delivery-profiles/' + key,{ token:access,body:bytes,type });
    let updated;
    try {
      updated = await upstream('/rest/v1/rpc/fd_api',{ token:access,body:{ action:'save_customer_photo',input:{ path:key } } });
    } catch (error) {
      await removePhoto('fly-delivery-profiles',key,access);
      throw error;
    }
    const {replaced_photo,...saved} = updated;
    if (typeof replaced_photo==='string' && profilePhotoPath.test(replaced_photo) && replaced_photo.startsWith(user.id + '/')) {
      await removePhoto('fly-delivery-profiles',replaced_photo,access);
    }
    return json(res,201,saved);
  }
  if (url.pathname === '/api/upload') {
    if (sessionCookie !== 'fd_loja_access' || !access) throw new HttpError(401,'Entre no estabelecimento para enviar a foto.');
    const store = url.searchParams.get('store') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(store)) throw new HttpError(400,'Envie uma foto JPG, PNG ou WebP.');
    const image = await readImage(req);
    if (image.bytes.length > maxImageBytes) {
      const user = await upstream('/rest/v1/rpc/fd_api',{ token:access,body:{ action:'session',input:{} } });
      if (user?.role !== 'merchant') throw new HttpError(403,'Envio exclusivo do estabelecimento.');
    }
    const { bytes,type,extension } = await compactImage(image);
    const key = store + '/' + crypto.randomUUID() + '.' + extension;
    await upstream('/storage/v1/object/fly-delivery-menu/' + key,{ token:access,body:bytes,type });
    return json(res,201,{ url:supabase + '/storage/v1/object/public/fly-delivery-menu/' + key });
  }
  throw new HttpError(404, 'Rota não encontrada.');
}

export function createApp() {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (['/entregador','/entregador/','/entregador.webmanifest','/api/maps/browser-config'].includes(url.pathname)) throw new HttpError(410,'Esta função foi encerrada. A entrega é feita pelo estabelecimento.');
      if (url.pathname === '/health') return json(res, 200, { status: 'ok' });
      if (url.pathname==='/api/infinitepay/webhook') {
        if(req.method!=='POST')throw new HttpError(405,'Método indisponível.');
        limitBilling(req,80);
        return json(res,200,await billing.webhook(await readJson(req)));
      }
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
      if (file === assetLinksFile && !/^www\.flydeliverypp\.com\.br(?::443)?$/i.test(req.headers.host ?? '')) {
        throw new HttpError(404, 'Página não encontrada.');
      }
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
  createApp().listen(port, '0.0.0.0', () => {
    console.log('Fly Delivery na porta ' + port);
    const tick=()=>billing.tick().catch(error=>console.error('Billing maintenance failed:',error.status??'unavailable'));
    tick();
    setInterval(tick,30000).unref();
  });
}
