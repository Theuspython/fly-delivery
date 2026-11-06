const base = Deno.env.get('SUPABASE_URL');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const railwayBridgeDigest = '657bcd8e0014f38e777f0ff960486939cbd7dc1e362822355386371f1439e29a';

class Failure extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call(path: string, { method = 'POST', body, token, admin = false }: {
  method?: string; body?: unknown; token?: string; admin?: boolean;
} = {}) {
  const key = admin ? serviceKey : anonKey;
  if (!base || !key) throw new Failure(503,'O cadastro de acessos está indisponível.');
  const headers = new Headers({ apikey:key, 'Content-Type':'application/json' });
  if (admin || token) headers.set('Authorization','Bearer ' + (admin ? key : token));
  const response = await fetch(base + path, {
    method, headers, body:body === undefined ? undefined : JSON.stringify(body),
    signal:AbortSignal.timeout(7000)
  });
  const data = await response.json().catch(() => null);
  return { response,data };
}

async function rpc(name: string, body: unknown, token: string) {
  const { response,data } = await call('/rest/v1/rpc/' + name,{ body,token });
  if (response.ok) return data;
  if (response.status === 401) throw new Failure(401,'Entre novamente para continuar.');
  if (data?.code === 'P0001' && data.message?.startsWith('FD: ')) throw new Failure(409,data.message.slice(4));
  throw new Failure(502,'O cadastro não pôde ser concluído. Tente novamente.');
}

const categories = new Set(['Hambúrguer','Pizza','Japonesa','Brasileira','Açaí','Telecerveja','Marmitex','Outros']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 8 && new TextEncoder().encode(value).length <= 72;

function operatorEmail(input: Record<string,unknown>) {
  const { login,operatorId,role } = input;
  if (typeof login !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,39}$/.test(login) ||
      typeof operatorId !== 'string' || !/^[a-f0-9]{40}$/.test(operatorId) || role !== 'merchant') {
    throw new Failure(400,'Confira o login.');
  }
  return 'fd-m-' + operatorId + '@fly-delivery-piloto.up.railway.app';
}

function signIn(email: string,password: string) {
  return call('/auth/v1/token?grant_type=password',{ body:{ email,password } });
}

async function provision(request: Request, input: Record<string,unknown>) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) throw new Failure(401,'Entre para continuar.');
  const identity = await call('/auth/v1/user',{ method:'GET',token });
  if (!identity.response.ok) throw new Failure(401,'Entre novamente para continuar.');
  const admin = await rpc('fd_api',{ action:'session',input:{} },token);
  if (admin?.role !== 'admin' || admin.id !== identity.data?.id) throw new Failure(403,'Acesso restrito à administração.');

  const { kind,role,login,password,request_id,store_id } = input;
  const email = operatorEmail(input);
  if (kind !== 'store' || role !== 'merchant' ||
      typeof request_id !== 'string' || !uuid.test(request_id) || !validPassword(password)) {
    throw new Failure(400,'Confira o login e a senha, que deve ter pelo menos 8 caracteres.');
  }
  if (kind === 'store' && (store_id ? typeof store_id !== 'string' || !uuid.test(store_id) :
      typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.trim().length > 80 ||
      !Array.isArray(input.categories) || !input.categories.length || input.categories.length > categories.size ||
      input.categories.some(category => !categories.has(String(category))))) {
    throw new Failure(400,'Confira o nome e as categorias do estabelecimento.');
  }
  const operator = { role,login,request_id };
  const created = await call('/auth/v1/admin/users',{ admin:true,body:{
    email,password,email_confirm:true,app_metadata:{ fly_delivery_operator:operator }
  } });
  let user = created.data;
  if (!created.response.ok) {
    const code = created.data?.error_code ?? created.data?.code;
    if (['email_exists','user_already_exists'].includes(code)) {
      const existing = await signIn(email,password);
      if (!existing.response.ok) throw new Failure(409,'Este login já está em uso.');
      user = existing.data?.user;
    } else if (code === 'weak_password') {
      throw new Failure(400,'Escolha uma senha mais forte.');
    } else throw new Failure(502,'Não foi possível criar o acesso. Tente novamente.');
  }
  if (!user?.id || user.app_metadata?.fly_delivery_operator?.login !== login ||
      user.app_metadata?.fly_delivery_operator?.role !== role) throw new Failure(409,'Este login já está em uso.');
  return rpc('fd_api',{ action:'assign_operator',input:{ role,login,request_id,store_id,
    user_id:user.id,name:input.name,categories:input.categories } },token);
}

async function operatorLogin(request: Request,input: Record<string,unknown>) {
  await requireRailway(request);
  const email = operatorEmail(input);
  if (!validPassword(input.password)) throw new Failure(400,'Confira o login e a senha.');
  const result = await signIn(email,input.password);
  if (result.response.status === 429) throw new Failure(429,'Muitas tentativas. Aguarde e tente de novo.');
  if (!result.response.ok || !result.data?.access_token || result.data.user?.app_metadata?.fly_delivery_operator?.role !== input.role) {
    throw new Failure(400,'Login ou senha incorretos.');
  }
  const profile = await rpc('fd_api',{ action:'session',input:{} },result.data.access_token);
  if (profile?.role !== input.role) throw new Failure(403,'Este acesso ainda precisa ser habilitado pela administração.');
  const { access_token,refresh_token,expires_in } = result.data;
  return { access_token,refresh_token,expires_in };
}

async function operatorChangePassword(request: Request,input: Record<string,unknown>) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) throw new Failure(401,'Entre para continuar.');
  const { current_password,password,confirmation } = input;
  if (!validPassword(current_password) || !validPassword(password) || password !== confirmation || current_password === password) {
    throw new Failure(400,'Informe a senha atual e confirme uma nova senha diferente, com pelo menos 8 caracteres.');
  }
  const identity = await call('/auth/v1/user',{ method:'GET',token });
  if (!identity.response.ok) throw new Failure(401,'Entre novamente para continuar.');
  const user = identity.data;
  const profile = await rpc('fd_api',{ action:'session',input:{} },token);
  if (profile?.id !== user?.id || profile?.role !== 'merchant' || user?.app_metadata?.fly_delivery_operator?.role !== 'merchant') {
    throw new Failure(403,'A alteração de senha está disponível para o login do estabelecimento.');
  }
  const verified = await signIn(user.email,current_password);
  if (!verified.response.ok || verified.data?.user?.id !== user.id) throw new Failure(400,'A senha atual está incorreta.');
  const updated = await call('/auth/v1/admin/users/' + user.id,{ method:'PUT',admin:true,body:{ password } });
  if (!updated.response.ok) throw new Failure(400,'Não foi possível alterar a senha. Escolha uma senha mais forte.');
  await call('/auth/v1/logout?scope=global',{ token:verified.data.access_token }).catch(() => {});
  return { ok:true };
}

async function activate(input: Record<string,unknown>) {
  const { token,password } = input;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token) ||
    typeof password !== 'string' || password.length < 10 || new TextEncoder().encode(password).length > 72 ||
    !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Failure(400,'Use um link válido e uma senha de 10 a 72 caracteres com letras e números.');
  }
  const verification = await call('/auth/v1/verify',{ body:{ type:'recovery',token_hash:token } });
  const user = verification.data?.user;
  if (!verification.response.ok || user?.app_metadata?.fly_delivery_setup !== true || !verification.data?.access_token) {
    throw new Failure(400,'Link expirado ou já utilizado. Peça um novo acesso à administração.');
  }
  const profile = await rpc('fd_api',{ action:'session',input:{} },verification.data.access_token);
  if (profile?.role !== 'merchant') {
    throw new Failure(403,'O acesso ainda não foi vinculado pela administração.');
  }
  const update = await call('/auth/v1/admin/users/' + user.id,{ method:'PUT',admin:true,body:{
    password,app_metadata:{ fly_delivery_setup:false }
  } });
  if (!update.response.ok) {
    throw new Failure(409,'Não foi possível gravar a senha. Peça um novo link à administração.');
  }
  return { ok:true };
}

async function requireRailway(request: Request) {
  const bridge = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
  if (!bridge) throw new Failure(403,'Operação restrita ao servidor.');
  const hashed = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bridge));
  const digest = Array.from(new Uint8Array(hashed),byte => byte.toString(16).padStart(2,'0')).join('');
  let difference = 0;
  for (let i=0; i<railwayBridgeDigest.length; i++) difference |= digest.charCodeAt(i) ^ railwayBridgeDigest.charCodeAt(i);
  if (difference !== 0) throw new Failure(403,'Operação restrita ao servidor.');
  return bridge;
}

async function adminLogin(request: Request) {
  const bridge = await requireRailway(request);
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey('raw',bytes.encode(bridge),{ name:'HMAC',hash:'SHA-256' },false,['sign']);
  const signature = await crypto.subtle.sign('HMAC',key,bytes.encode('fly-delivery/railway-admin/v1'));
  const password = 'Fd!7' + Array.from(new Uint8Array(signature),byte => byte.toString(16).padStart(2,'0')).join('');
  const email = 'fd-admin-' + railwayBridgeDigest.slice(0,24) + '@fly-delivery-piloto.up.railway.app';

  const signIn = () => call('/auth/v1/token?grant_type=password',{ body:{ email,password } });
  let login = await signIn();
  if ((login.data?.error_code ?? login.data?.code) === 'invalid_credentials') {
    const created = await call('/auth/v1/admin/users',{ admin:true,body:{
      email,password,email_confirm:true,app_metadata:{ fly_delivery_railway_admin:true }
    } });
    const code = created.data?.error_code ?? created.data?.code;
    if (!created.response.ok && !['email_exists','user_already_exists'].includes(code)) {
      throw new Failure(503,'Não foi possível iniciar a sessão administrativa. Tente novamente.');
    }
    login = await signIn();
  }
  if (login.response.status === 429) throw new Failure(429,'Muitas tentativas. Aguarde e tente de novo.');
  if (!login.response.ok || login.data?.user?.app_metadata?.fly_delivery_railway_admin !== true || !login.data?.access_token) {
    throw new Failure(503,'Não foi possível iniciar a sessão administrativa. Tente novamente.');
  }
  const { response,data } = await call('/rest/v1/rpc/fd_grant_railway_admin',{ admin:true,body:{
    email_address:email, verified_user:login.data.user.id
  } });
  if (!response.ok || data !== true) throw new Failure(503,'Não foi possível habilitar a sessão administrativa.');
  const { access_token,refresh_token,expires_in } = login.data;
  return { access_token,refresh_token,expires_in };
}

async function customerAuth(request: Request, input: Record<string,unknown>, signup: boolean) {
  await requireRailway(request);
  const { loginId,password } = input;
  if (typeof loginId !== 'string' || !/^[a-f0-9]{40}$/.test(loginId) ||
    typeof password !== 'string' || password.length < 8 || new TextEncoder().encode(password).length > 72) {
    throw new Failure(400,'Confira o CPF e a senha.');
  }
  const email = 'fd-c-' + loginId + '@fly-delivery-piloto.up.railway.app';
  if (signup) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const phone = typeof input.phone === 'string' ? input.phone : '';
    if (name.length < 3 || name.length > 120 || !/^[1-9][0-9]{9,10}$/.test(phone)) {
      throw new Failure(400,'Confira seu nome e celular com DDD.');
    }
    const phoneExists = async () => {
      const result = await call('/rest/v1/rpc/fd_cpf_phone_exists',{ admin:true,body:{ phone_number:phone } });
      if (!result.response.ok) throw new Failure(503,'O cadastro está indisponível. Tente novamente.');
      return result.data === true;
    };
    if (await phoneExists()) throw new Failure(409,'CPF ou celular já cadastrado. Use Entrar.');
    const created = await call('/auth/v1/admin/users',{ admin:true,body:{
      email,password,email_confirm:true,app_metadata:{ fly_delivery_cpf_login:true },
      user_metadata:{ fly_delivery_customer:{ name,phone } }
    } });
    if (!created.response.ok) {
      const code = created.data?.error_code ?? created.data?.code;
      if (['email_exists','user_already_exists'].includes(code) || await phoneExists()) {
        throw new Failure(409,'CPF ou celular já cadastrado. Use Entrar.');
      }
      if (code === 'weak_password') throw new Failure(400,'Escolha uma senha mais forte.');
      if (created.response.status === 429) throw new Failure(429,'Muitas tentativas. Aguarde e tente de novo.');
      throw new Failure(502,'Não foi possível criar sua conta. Tente novamente.');
    }
  }

  const login = await call('/auth/v1/token?grant_type=password',{ body:{ email,password } });
  if (login.response.status === 429) throw new Failure(429,'Muitas tentativas. Aguarde e tente de novo.');
  if (!login.response.ok || login.data?.user?.app_metadata?.fly_delivery_cpf_login !== true || !login.data?.access_token) {
    if (signup) throw new Failure(409,'Conta criada. Use Entrar com seu CPF e sua senha.');
    throw new Failure(400,'CPF ou senha incorretos.');
  }
  const { access_token,refresh_token,expires_in } = login.data;
  return { access_token,refresh_token,expires_in };
}

Deno.serve(async request => {
  const headers = { 'Content-Type':'application/json','Cache-Control':'no-store' };
  try {
    if (request.method !== 'POST') throw new Failure(405,'Método indisponível.');
    if (Number(request.headers.get('Content-Length')) > 16384) throw new Failure(413,'Dados do cadastro muito grandes.');
    const raw = await request.text();
    if (raw.length > 16384) throw new Failure(413,'Dados do cadastro muito grandes.');
    const { action,input } = JSON.parse(raw) ?? {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Failure(400,'Dados inválidos.');
    if (!['provision','activate','admin_login','customer_register','customer_login','operator_login','operator_change_password'].includes(action)) throw new Failure(400,'Ação inválida.');
    const result = action === 'provision' ? await provision(request,input) :
      action === 'activate' ? await activate(input) : action === 'admin_login' ? await adminLogin(request) :
      action === 'operator_login' ? await operatorLogin(request,input) :
      action === 'operator_change_password' ? await operatorChangePassword(request,input) :
      await customerAuth(request,input,action === 'customer_register');
    return new Response(JSON.stringify(result),{ headers });
  } catch (error) {
    if (error instanceof Failure || error instanceof SyntaxError) {
      return new Response(JSON.stringify({ code:'FD_ONBOARDING',message:error instanceof SyntaxError ? 'Dados inválidos.' : error.message }),{
        headers,status:error instanceof Failure ? error.status : 400
      });
    }
    console.error('Fly Delivery onboarding',error instanceof Error ? error.name : 'error');
    return new Response(JSON.stringify({ code:'FD_ONBOARDING',message:'Cadastro indisponível. Tente novamente.' }),{ headers,status:502 });
  }
});
