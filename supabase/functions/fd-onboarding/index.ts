const base = Deno.env.get('SUPABASE_URL');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

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

function validStore(input: Record<string,unknown>) {
  const { name,address,lat,lng,category,description,fee,delivery_radius:radius,eta } = input;
  return typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 80 &&
    typeof address === 'string' && address.trim().length >= 5 && address.trim().length <= 240 &&
    typeof lat === 'number' && lat >= -90 && lat <= 90 && typeof lng === 'number' && lng >= -180 && lng <= 180 &&
    ['Hambúrguer','Pizza','Japonesa','Brasileira','Açaí','Outros'].includes(String(category)) &&
    typeof description === 'string' && description.trim().length <= 260 &&
    Number.isInteger(fee) && Number(fee) >= 0 && Number(fee) <= 100000 &&
    Number.isInteger(radius) && Number(radius) >= 1 && Number(radius) <= 50 &&
    Number.isInteger(eta) && Number(eta) >= 5 && Number(eta) <= 180;
}

async function provision(request: Request, input: Record<string,unknown>) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) throw new Failure(401,'Entre para continuar.');
  const identity = await call('/auth/v1/user',{ method:'GET',token });
  if (!identity.response.ok) throw new Failure(401,'Entre novamente para continuar.');
  const admin = await rpc('fd_api',{ action:'session',input:{} },token);
  if (admin?.role !== 'admin' || admin.id !== identity.data?.id) {
    throw new Failure(403,'Acesso restrito à administração.');
  }
  const store = input.kind === 'store';
  if (!store && input.kind !== 'courier') throw new Failure(400,'Tipo de cadastro inválido.');
  const email = String(store ? input.owner_email ?? '' : input.email ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || (store && !validStore(input))) {
    throw new Failure(400,'Confira os dados do cadastro.');
  }

  const findTarget = () => rpc('fd_registration_target',{ email_address:email },token);
  let target = await findTarget();
  if (!target) {
    const result = await call('/auth/v1/admin/users',{ admin:true,body:{
      email,password:'Fd!7' + crypto.randomUUID() + crypto.randomUUID().slice(0,16),email_confirm:true,
      app_metadata:{ fly_delivery_setup:true }
    } });
    if (result.response.ok) target = { confirmed:true,setup:true };
    else if (['email_exists','user_already_exists'].includes(result.data?.error_code ?? result.data?.code)) {
      target = await findTarget();
    } else throw new Failure(502,'Não foi possível criar o acesso. Tente novamente.');
  }
  if (!target?.confirmed) throw new Failure(409,'Esta conta já existe. Peça que o responsável confirme o e-mail antes de vinculá-la.');

  const saved = await rpc('fd_api',store
    ? { action:input.id ? 'save_store' : 'register_store',input:{ ...input,owner_email:email } }
    : { action:'set_courier',input:{ email,enabled:true } },token);
  if (!target.setup) return { ...saved,activationToken:null };

  try {
    const link = await call('/auth/v1/admin/generate_link',{ admin:true,body:{ type:'recovery',email } });
    if (link.response.ok && typeof link.data?.hashed_token === 'string') {
      return { ...saved,activationToken:link.data.hashed_token };
    }
  } catch (error) {
    console.error('Fly Delivery activation link',error instanceof Error ? error.name : 'error');
  }
  return { ...saved,activationToken:null,activationPending:true };
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
  if (!['merchant','courier'].includes(profile?.role)) {
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

Deno.serve(async request => {
  const headers = { 'Content-Type':'application/json','Cache-Control':'no-store' };
  try {
    if (request.method !== 'POST') throw new Failure(405,'Método indisponível.');
    if (Number(request.headers.get('Content-Length')) > 16384) throw new Failure(413,'Dados do cadastro muito grandes.');
    const raw = await request.text();
    if (raw.length > 16384) throw new Failure(413,'Dados do cadastro muito grandes.');
    const { action,input } = JSON.parse(raw) ?? {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Failure(400,'Dados inválidos.');
    if (action !== 'provision' && action !== 'activate') throw new Failure(400,'Ação inválida.');
    const result = action === 'provision' ? await provision(request,input) : await activate(input);
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
