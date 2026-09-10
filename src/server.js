import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import OpenAI, { toFile } from 'openai';
import pg from 'pg';
import XLSX from 'xlsx';
import fs from 'fs';
import archiver from 'archiver';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import pptxgen from 'pptxgenjs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 10, fileSize: 50 * 1024 * 1024 },
});
const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false,
});
const GENERATED_DIR = path.join(__dirname, '../public/generated');
fs.mkdirSync(GENERATED_DIR, { recursive: true });
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120000, maxRetries: 2 })
  : null;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public'), { extensions: ['html'] }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const aiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const imageLimiter = rateLimit({ windowMs: 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false });
const plans = {
  free: { name: 'رایگان', amount: 0, days: 30, messagesPerDay: 200, imagesPerDay: 30, model: 'gpt-5.6-luna' },
  pro: { name: 'Pro', amount: 249000, days: 30, messagesPerDay: 500, imagesPerDay: 60, model: 'gpt-5.6-terra' },
  business: { name: 'Business', amount: 699000, days: 30, messagesPerDay: 5000, imagesPerDay: 200, model: 'gpt-5.6-sol' },
};
const q = (text, params = []) => pool.query(text, params);
const normalizeEmail = (v) => String(v || '').trim().toLowerCase();
const normalizeUsername = (v) => String(v || '').trim().toLowerCase();
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

function sign(user) { return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' }); }
function setSession(res, user) {
  res.cookie('amnayar_session', sign(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 86400000,
  });
}
function auth(req, res, next) {
  try {
    const token = req.cookies.amnayar_session;
    if (!token) return res.status(401).json({ error: 'برای ادامه وارد حساب شوید.' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'نشست شما منقضی شده است.' });
  }
}
function owner(req, res, next) {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'دسترسی مالک لازم است.' });
  next();
}
function safeUser(u) {
  return { id: u.id, email: u.email, username: u.username, role: u.role, created_at: u.created_at };
}

async function init() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  await q(`CREATE TABLE IF NOT EXISTS users(
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','owner')),
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS conversations(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'گفت‌وگوی جدید',
    previous_response_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS messages(
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Kept for compatibility with old test data. New public pages no longer create or sell credit orders.
  await q(`CREATE TABLE IF NOT EXISTS credit_orders(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    package_name TEXT NOT NULL,
    credits INTEGER NOT NULL,
    amount BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at TIMESTAMPTZ
  )`);

  await q(`CREATE TABLE IF NOT EXISTS checks(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS subscriptions(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL CHECK (plan IN ('free','pro','business')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','expired','cancelled')),
    amount_toman BIGINT NOT NULL DEFAULT 0,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMPTZ NOT NULL,
    authority TEXT,
    ref_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS payment_orders(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    amount_toman BIGINT NOT NULL,
    authority TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled')),
    ref_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ
  )`);
  await q(`CREATE TABLE IF NOT EXISTS ai_usage(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
    kind TEXT NOT NULL CHECK (kind IN ('message','image')),
    count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, usage_date, kind)
  )`);

  if (process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD) {
    const email = normalizeEmail(process.env.OWNER_EMAIL);
    const existing = await q('SELECT id FROM users WHERE email=$1', [email]);
    if (!existing.rowCount) {
      const hash = await bcrypt.hash(process.env.OWNER_PASSWORD, 12);
      await q('INSERT INTO users(email,username,password_hash,credits,role,email_verified) VALUES($1,$2,$3,0,$4,true)', [email, 'owner', hash, 'owner']);
    } else {
      await q('UPDATE users SET role=\'owner\', email_verified=true WHERE email=$1', [email]);
    }
  }
}

app.get('/api/health', (req, res) => res.json({
  ok: true,
  service: 'amnayar-modern',
  ai: Boolean(openai),
  model: process.env.OPENAI_MODEL || 'gpt-5.6-sol',
}));

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'ایمیل معتبر وارد کنید.' });
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'نام کاربری باید ۳ تا ۲۴ کاراکتر انگلیسی، عدد یا _ باشد.' });
    if (password.length < 8) return res.status(400).json({ error: 'رمز عبور حداقل ۸ کاراکتر باشد.' });
    const dup = await q('SELECT email,username FROM users WHERE email=$1 OR username=$2', [email, username]);
    if (dup.rowCount) return res.status(409).json({ error: 'ایمیل یا نام کاربری قبلاً ثبت شده است.' });
    const hash = await bcrypt.hash(password, 12);
    const r = await q('INSERT INTO users(email,username,password_hash,credits,role) VALUES($1,$2,$3,0,\'user\') RETURNING *', [email, username, hash]);
    setSession(res, r.rows[0]);
    res.json({ user: safeUser(r.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطای سرور.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const identifier = String(req.body.identifier || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const r = await q('SELECT * FROM users WHERE email=$1 OR username=$1', [identifier]);
    if (!r.rowCount || !(await bcrypt.compare(password, r.rows[0].password_hash))) return res.status(401).json({ error: 'نام کاربری/ایمیل یا رمز عبور نادرست است.' });
    setSession(res, r.rows[0]);
    res.json({ user: safeUser(r.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطای سرور.' });
  }
});
app.post('/api/auth/logout', (req, res) => { res.clearCookie('amnayar_session'); res.json({ ok: true }); });
async function getPlan(userId) {
  const r = await q(`SELECT plan,status,starts_at,ends_at,amount_toman FROM subscriptions WHERE user_id=$1 AND status='active' AND ends_at>NOW() ORDER BY ends_at DESC LIMIT 1`, [userId]);
  return r.rowCount ? { key: r.rows[0].plan, ...plans[r.rows[0].plan], ...r.rows[0] } : { key: 'free', ...plans.free, status: 'active' };
}
async function getUsage(userId, kind) {
  const r = await q(`SELECT count FROM ai_usage WHERE user_id=$1 AND usage_date=CURRENT_DATE AND kind=$2`, [userId, kind]);
  return r.rowCount ? r.rows[0].count : 0;
}
async function canUseUsage(userId, kind, limit) {
  return (await getUsage(userId, kind)) < limit;
}
async function recordUsage(userId, kind) {
  await q(`INSERT INTO ai_usage(user_id,usage_date,kind,count) VALUES($1,CURRENT_DATE,$2,1)
    ON CONFLICT(user_id,usage_date,kind) DO UPDATE SET count=ai_usage.count+1`, [userId, kind]);
}
app.get('/api/me', auth, async (req, res) => {
  const r = await q('SELECT id,email,username,role,created_at FROM users WHERE id=$1', [req.user.id]);
  if (!r.rowCount) return res.status(401).json({ error: 'کاربر پیدا نشد.' });
  const plan = await getPlan(req.user.id);
  const [messages, images] = await Promise.all([getUsage(req.user.id,'message'), getUsage(req.user.id,'image')]);
  res.json({ user: r.rows[0], plan: { key: plan.key, name: plan.name, amount: plan.amount, ends_at: plan.ends_at || null, messagesUsed: messages, messagesLimit: plan.messagesPerDay, imagesUsed: images, imagesLimit: plan.imagesPerDay } });
});

// Free, unlimited structural checks. No credit balance and no purchase flow are involved.
function luhn(s) {
  let sum = 0, alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let n = Number(s[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
function iranNational(s) {
  if (!/^\d{10}$/.test(s) || /^([0-9])\1{9}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
  const r = sum % 11;
  const c = Number(s[9]);
  return r < 2 ? c === r : c === 11 - r;
}
function iban(s) {
  s = s.replace(/\s/g, '').toUpperCase();
  if (!/^IR\d{24}$/.test(s)) return false;
  const moved = s.slice(4) + '1827' + s.slice(2, 4);
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

app.get('/api/plans', (req,res)=>res.json({plans:Object.entries(plans).map(([key,p])=>({key,...p}))}));
app.get('/api/billing/status', auth, async (req,res)=>{
  const plan=await getPlan(req.user.id);
  const [messages,images]=await Promise.all([getUsage(req.user.id,'message'),getUsage(req.user.id,'image')]);
  const orders=(await q(`SELECT id,plan,amount_toman,status,ref_id,created_at,paid_at FROM payment_orders WHERE user_id=$1 ORDER BY id DESC LIMIT 10`,[req.user.id])).rows;
  res.json({plan:{key:plan.key,name:plan.name,amount:plan.amount,ends_at:plan.ends_at||null,messagesLimit:plan.messagesPerDay,imagesLimit:plan.imagesPerDay,messagesUsed:messages,imagesUsed:images},orders});
});
app.post('/api/billing/create-payment', auth, async (req,res)=>{
  const planKey=String(req.body?.plan||'');
  const plan=plans[planKey];
  if(!plan || planKey==='free') return res.status(400).json({error:'طرح اشتراکی نامعتبر است.'});
  if(!process.env.ZARINPAL_MERCHANT_ID) return res.status(503).json({error:'درگاه پرداخت هنوز در Render تنظیم نشده است. بعد از ثبت Merchant ID، پرداخت فعال می‌شود.'});
  try{
    const order=(await q(`INSERT INTO payment_orders(user_id,plan,amount_toman) VALUES($1,$2,$3) RETURNING id`,[req.user.id,planKey,plan.amount])).rows[0];
    const callback=`${process.env.APP_URL||'https://amnayar-modern.onrender.com'}/api/billing/zarinpal/callback?order=${order.id}`;
    const amountRial=plan.amount*10;
    const response=await fetch('https://api.zarinpal.com/pg/v4/payment/request.json',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({merchant_id:process.env.ZARINPAL_MERCHANT_ID,amount:amountRial,callback_url:callback,description:`اشتراک ${plan.name} امنا یار - سفارش ${order.id}`})});
    const data=await response.json();
    if(data?.data?.code!==100) throw new Error(data?.errors?.message||'ZARINPAL_REQUEST_FAILED');
    await q('UPDATE payment_orders SET authority=$1 WHERE id=$2',[data.data.authority,order.id]);
    res.json({ok:true,paymentUrl:`https://www.zarinpal.com/pg/StartPay/${data.data.authority}`});
  }catch(e){console.error('Payment request error',e);res.status(502).json({error:'ساخت پرداخت ناموفق بود. تنظیمات درگاه را بررسی کنید.'});}
});
app.get('/api/billing/zarinpal/callback', async (req,res)=>{
  const orderId=Number(req.query.order||0); const authority=String(req.query.Authority||''); const status=String(req.query.Status||'');
  if(!orderId||!authority) return res.redirect('/pricing.html?payment=failed');
  try{
    const r=await q('SELECT * FROM payment_orders WHERE id=$1 AND authority=$2',[orderId,authority]);
    if(!r.rowCount) return res.redirect('/pricing.html?payment=failed');
    const order=r.rows[0];
    if(order.status==='paid') return res.redirect('/pricing.html?payment=success&ref='+encodeURIComponent(order.ref_id||''));
    if(status!=='OK') { await q("UPDATE payment_orders SET status='cancelled' WHERE id=$1",[order.id]); return res.redirect('/pricing.html?payment=cancelled'); }
    const plan=plans[order.plan];
    const verify=await fetch('https://api.zarinpal.com/pg/v4/payment/verify.json',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({merchant_id:process.env.ZARINPAL_MERCHANT_ID,amount:order.amount_toman*10,authority})});
    const data=await verify.json();
    if(![100,101].includes(data?.data?.code)) { await q("UPDATE payment_orders SET status='failed' WHERE id=$1",[order.id]); return res.redirect('/pricing.html?payment=failed'); }
    const refId=String(data.data.ref_id||'');
    await q("UPDATE payment_orders SET status='paid',ref_id=$1,paid_at=NOW() WHERE id=$2",[refId,order.id]);
    await q("UPDATE subscriptions SET status='expired' WHERE user_id=$1 AND status='active'",[order.user_id]);
    await q(`INSERT INTO subscriptions(user_id,plan,status,amount_toman,starts_at,ends_at,authority,ref_id) VALUES($1,$2,'active',$3,NOW(),NOW()+INTERVAL '30 days',$4,$5)`,[order.user_id,order.plan,order.amount_toman,authority,refId]);
    res.redirect(`/pricing.html?payment=success&ref=${encodeURIComponent(refId)}`);
  }catch(e){console.error('Payment callback error',e);res.redirect('/pricing.html?payment=failed');}
});

app.post('/api/check', auth, async (req, res) => {
  try {
    const kind = String(req.body.kind || '');
    const input = String(req.body.input || '').replace(/\s/g, '');
    const rules = {
      card: () => /^\d{16}$/.test(input) && luhn(input),
      national: () => iranNational(input),
      iban: () => iban(input),
    };
    if (!rules[kind]) return res.status(400).json({ error: 'نوع استعلام نامعتبر است.' });
    const valid = rules[kind]();
    const result = valid ? 'معتبر' : 'نامعتبر';
    await q('INSERT INTO checks(user_id,kind,input_hash,result) VALUES($1,$2,$3,$4)', [req.user.id, kind, sha256(input), result]);
    res.json({ valid, result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطای ثبت استعلام.' });
  }
});

app.get('/api/dashboard', auth, async (req, res) => {
  const [u, checks] = await Promise.all([
    q('SELECT id,email,username,role,created_at FROM users WHERE id=$1', [req.user.id]),
    q('SELECT id,kind,result,created_at FROM checks WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.user.id]),
  ]);
  if (!u.rowCount) return res.status(401).json({ error: 'کاربر پیدا نشد.' });
  res.json({ user: u.rows[0], checks: checks.rows });
});

// AI conversations and chat. OpenAI is optional at deploy time; the UI explains when the server key is missing.
app.get('/api/conversations', auth, async (req, res) => {
  const r = await q('SELECT id,title,created_at,updated_at FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50', [req.user.id]);
  res.json({ conversations: r.rows });
});
app.post('/api/conversations', auth, async (req, res) => {
  const title = String(req.body.title || 'گفت‌وگوی جدید').slice(0, 80);
  const r = await q('INSERT INTO conversations(user_id,title) VALUES($1,$2) RETURNING *', [req.user.id, title]);
  res.json({ conversation: r.rows[0] });
});
app.get('/api/conversations/:id/messages', auth, async (req, res) => {
  const r = await q('SELECT m.id,m.role,m.content,m.created_at FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.id=$1 AND c.user_id=$2 ORDER BY m.id ASC', [req.params.id, req.user.id]);
  res.json({ messages: r.rows });
});
app.delete('/api/conversations/:id', auth, async (req, res) => {
  await q('DELETE FROM conversations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

function detectImageRequest(text) {
  const t = String(text || '').toLowerCase();
  const create = /(بساز|بسازش|ایجاد کن|تولید کن|طراحی کن|رندر کن|نقاشی کن|تصویرسازی کن|generate|create|make|draw|design|render)/.test(t);
  const subject = /(تصویر|عکس|پوستر|لوگو|بنر|نقاشی|ایلوستریشن|illustration|image|photo|poster|logo|banner)/.test(t);
  return create && subject;
}
function detectFileRequest(text) {
  const t = String(text || '').toLowerCase();
  return {
    xlsx: /(اکسل|excel|xlsx|spreadsheet)/.test(t),
    csv: /\bcsv\b|فایل csv/.test(t),
    pdf: /(پی.?دی.?اف|pdf)/.test(t),
    docx: /(ورد|word|docx|سند word)/.test(t),
    pptx: /(پاورپوینت|powerpoint|pptx|اسلاید)/.test(t),
    txt: /(فایل متنی|text file|\.txt\b)/.test(t),
    md: /(markdown|مارک.?داون|\.md\b)/.test(t),
    zip: /(zip|زیپ|پروژه|نرم.?افزار|اپلیکیشن|برنامه کامل|فایل پروژه)/.test(t),
  };
}
function extractMarkdownTable(text) {
  const lines = String(text || '').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  for (let i=0;i<lines.length-1;i++) {
    if (lines[i].includes('|') && /^\|?\s*:?-{3,}/.test(lines[i+1].replace(/\|/g,'').trim())) {
      const table=[];
      const parse=(line)=>line.replace(/^\|/,'').replace(/\|$/,'').split('|').map(x=>x.trim());
      table.push(parse(lines[i]));
      i+=2;
      while(i<lines.length && lines[i].includes('|') && !/^#{1,6}\s/.test(lines[i])) { table.push(parse(lines[i])); i++; }
      return table;
    }
  }
  return [];
}
function safeFileName(name) { return String(name).replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,80) || 'output'; }
function extractCodeBlocks(text) {
  const blocks=[]; const re=/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g; let m;
  while((m=re.exec(String(text)))) blocks.push({lang:(m[1]||'txt').toLowerCase(),code:m[2].trimEnd()});
  return blocks;
}
function extForLang(lang) {
  return ({javascript:'js',js:'js',typescript:'ts',ts:'ts',python:'py',py:'py',html:'html',css:'css',json:'json',sql:'sql',bash:'sh',shell:'sh',sh:'sh',jsx:'jsx',tsx:'tsx',java:'java',csharp:'cs',cs:'cs',cpp:'cpp',c:'c',php:'php','c++':'cpp',go:'go',rust:'rs',ruby:'rb',kotlin:'kt',swift:'swift',yaml:'yml',yml:'yml',xml:'xml'}[lang] || 'txt');
}
async function writeArtifact(kind, answer, userText) {
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const attachments=[];
  const base=`amnayar-${id}`;
  if (kind==='xlsx' || kind==='csv') {
    let table=extractMarkdownTable(answer);
    if (!table.length) table=[['متن خروجی'],[String(answer).slice(0,50000)]];
    const ws=XLSX.utils.aoa_to_sheet(table);
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'AmnaYar');
    if(kind==='xlsx') {
      const file=`${base}.xlsx`; XLSX.writeFile(wb,path.join(GENERATED_DIR,file));
      attachments.push({type:'file',name:'فایل اکسل AmnaYar.xlsx',url:`/generated/${file}`});
    } else {
      const file=`${base}.csv`; const csv=XLSX.utils.sheet_to_csv(ws); fs.writeFileSync(path.join(GENERATED_DIR,file),csv,'utf8');
      attachments.push({type:'file',name:'فایل CSV AmnaYar.csv',url:`/generated/${file}`});
    }
  } else if(kind==='txt' || kind==='md') {
    const file=`${base}.${kind}`; fs.writeFileSync(path.join(GENERATED_DIR,file),answer,'utf8');
    attachments.push({type:'file',name:`خروجی AmnaYar.${kind}`,url:`/generated/${file}`});
  } else if(kind==='pdf') {
    const file=`${base}.pdf`; const out=fs.createWriteStream(path.join(GENERATED_DIR,file));
    const doc=new PDFDocument({margin:48}); doc.pipe(out); doc.fontSize(18).text('AmnaYar AI'); doc.moveDown();
    doc.fontSize(11).text(String(answer),{width:500,align:'left'}); doc.end();
    await new Promise((resolve,reject)=>{out.on('finish',resolve);out.on('error',reject);});
    attachments.push({type:'file',name:'فایل PDF AmnaYar.pdf',url:`/generated/${file}`});
  } else if(kind==='docx') {
    const file=`${base}.docx`; const paragraphs=String(answer).split(/\r?\n/).map(line=>new Paragraph({children:[new TextRun(line||' ')]}));
    const doc=new Document({sections:[{children:[new Paragraph({text:'AmnaYar AI',heading:HeadingLevel.TITLE}),...paragraphs]}]});
    const buf=await Packer.toBuffer(doc); fs.writeFileSync(path.join(GENERATED_DIR,file),buf);
    attachments.push({type:'file',name:'سند Word AmnaYar.docx',url:`/generated/${file}`});
  } else if(kind==='pptx') {
    const file=`${base}.pptx`; const ppt=new pptxgen(); ppt.layout='LAYOUT_WIDE';
    const chunks=String(answer).split(/\n(?=#{1,3}\s)/).filter(Boolean); const parts=chunks.length?chunks:[String(answer)];
    parts.slice(0,20).forEach((part,i)=>{const slide=ppt.addSlide(); const ls=part.split(/\r?\n/).filter(Boolean); slide.addText((ls[0]||`اسلاید ${i+1}`).replace(/^#+\s*/,''),{x:.6,y:.4,w:12,h:.6,fontSize:24,bold:true}); slide.addText(ls.slice(1).join('\n')||part,{x:.7,y:1.2,w:11.8,h:5.5,fontSize:16,breakLine:false});});
    await ppt.writeFile({fileName:path.join(GENERATED_DIR,file)}); attachments.push({type:'file',name:'فایل PowerPoint AmnaYar.pptx',url:`/generated/${file}`});
  } else if(kind==='zip') {
    const blocks=extractCodeBlocks(answer); const file=`${base}-project.zip`; const out=fs.createWriteStream(path.join(GENERATED_DIR,file)); const archive=archiver('zip',{zlib:{level:9}}); archive.pipe(out);
    if(blocks.length) blocks.forEach((b,i)=>archive.append(b.code,{name:`${i===0?'main':`file-${i+1}`}.${extForLang(b.lang)}`}));
    archive.append(`# AmnaYar generated project\n\nRequest:\n${userText}\n`,{name:'README.md'}); archive.append(String(answer),{name:'AI-OUTPUT.txt'}); await archive.finalize();
    await new Promise((resolve,reject)=>{out.on('close',resolve);out.on('error',reject);});
    attachments.push({type:'file',name:'فایل پروژه ZIP AmnaYar.zip',url:`/generated/${file}`});
  }
  return attachments;
}

app.post('/api/chat', auth, aiLimiter, upload.array('files', 10), async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'هوش مصنوعی هنوز فعال نشده است. کلید OPENAI_API_KEY باید در Render تنظیم شود.' });
  const plan = await getPlan(req.user.id);
  if (!(await canUseUsage(req.user.id, 'message', plan.messagesPerDay))) return res.status(429).json({ error: `سهم روزانه طرح ${plan.name} شما تمام شده است. برای ادامه، طرح Pro یا Business را فعال کنید.`, code:'PLAN_LIMIT', plan:plan.key });
  const conversationId = Number(req.body.conversationId);
  const message = String(req.body.message || '').trim();
  const imageDataUrl = typeof req.body.imageDataUrl === 'string' ? req.body.imageDataUrl : '';
  const uploadedFiles = Array.isArray(req.files) ? req.files : [];
  if (!message && !imageDataUrl && !uploadedFiles.length) return res.status(400).json({ error: 'پیام یا فایل خالی است.' });
  if (!conversationId) return res.status(400).json({ error: 'گفت‌وگو انتخاب نشده است.' });
  const conv = await q('SELECT * FROM conversations WHERE id=$1 AND user_id=$2', [conversationId, req.user.id]);
  if (!conv.rowCount) return res.status(404).json({ error: 'گفت‌وگو پیدا نشد.' });

  const text = message || (uploadedFiles.length ? 'فایل‌های پیوست را بررسی کن و بر اساس محتوای آن‌ها پاسخ بده.' : 'این تصویر را بررسی کن و توضیح بده.');
  const content = [{ type: 'input_text', text }];
  if (imageDataUrl && /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(imageDataUrl)) {
    content.push({ type: 'input_image', image_url: imageDataUrl, detail: 'auto' });
  }

  const uploadedForCleanup = [];
  try {
    for (const file of uploadedFiles) {
      const lower = String(file.originalname || '').toLowerCase();
      const mime = String(file.mimetype || '').toLowerCase();
      if (mime.startsWith('image/')) {
        // Send uploaded images directly as data URLs. This avoids file-id compatibility
        // problems and matches the Responses API image-input contract.
        const base64 = file.buffer.toString('base64');
        const safeMime = mime === 'image/jpg' ? 'image/jpeg' : mime;
        content.push({ type: 'input_image', image_url: `data:${safeMime};base64,${base64}`, detail: 'auto' });
      } else if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm|flac|aac)$/i.test(lower)) {
        try {
          const transcript = await openai.audio.transcriptions.create({
            file: await toFile(file.buffer, file.originalname, { type: file.mimetype }),
            model: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe',
          });
          if (transcript?.text) content.push({ type: 'input_text', text: `متن استخراج‌شده از فایل صوتی «${file.originalname}»:\n${transcript.text}` });
        } catch (audioError) {
          console.error('Audio transcription error', audioError);
          content.push({ type: 'input_text', text: `فایل صوتی «${file.originalname}» دریافت شد، اما تبدیل صوت به متن انجام نشد.` });
        }
      } else if (mime.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(lower)) {
        content.push({ type: 'input_text', text: `فایل ویدیویی «${file.originalname}» دریافت شد. در این نسخه تحلیل مستقیم ویدیو توسط مدل فعال نیست؛ اگر هدف تحلیل گفتار ویدیو است، فایل صوتی آن را نیز ارسال کنید.` });
      } else {
        const openaiFile = await openai.files.create({
          file: await toFile(file.buffer, file.originalname, { type: file.mimetype }),
          purpose: 'user_data',
        });
        uploadedForCleanup.push(openaiFile.id);
        content.push({ type: 'input_file', file_id: openaiFile.id });
      }
    }
  } catch (uploadError) {
    console.error('OpenAI file upload error', uploadError);
    return res.status(400).json({ error: 'آپلود یا پردازش فایل انجام نشد. حجم یا نوع فایل را بررسی کنید.' });
  }

  const wantsImageRequest = detectImageRequest(message);
  if (wantsImageRequest && !(await canUseUsage(req.user.id, 'image', plan.imagesPerDay))) return res.status(429).json({ error: `سهم روزانه ساخت تصویر در طرح ${plan.name} شما تمام شده است.`, code:'PLAN_LIMIT', plan:plan.key });

  try {
    const request = {
      model: plan.model || process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      instructions: 'تو AmnaYar AI، دستیار حرفه‌ای و دقیق امنا یار هستی. پاسخ‌ها را فارسی روان، روشن، کاربردی و ساختاریافته بده. هرگز اطلاعات، منبع، عدد، نام، قابلیت یا نتیجه‌ای را حدس نزن و جعل نکن؛ اگر مطمئن نیستی صریح بگو که مطمئن نیستی. برای درخواست فایل، محتوای مناسب همان قالب را آماده کن؛ برای Excel/CSV در صورت امکان جدول Markdown منظم بده و برای کدنویسی کد را داخل code block کامل و قابل اجرا قرار بده. برای اطلاعات روز، خبر، قیمت، قوانین، مشخصات محصولات و هر موضوعی که ممکن است تغییر کرده باشد از جست‌وجوی وب استفاده کن و نتیجه را با منبع قابل‌اعتماد پشتیبانی کن. برای مسائل پزشکی، حقوقی و مالی پرریسک با احتیاط و بدون ادعای قطعیت پاسخ بده. اطلاعات محرمانه مثل رمز، کلید API و اطلاعات بانکی حساس را درخواست نکن. اگر کاربر درخواست ساخت تصویر، فایل یا پروژه کرد، تا حد امکان خودِ خروجی را بساز و لینک آن را ارائه کن؛ فقط توضیح دادن درباره اینکه چگونه ساخته شود کافی نیست.',
      tools: [{ type: 'web_search' }],
      input: [{ role: 'user', content }],
    };
    if (conv.rows[0].previous_response_id) request.previous_response_id = conv.rows[0].previous_response_id;

    let response;
    try {
      response = await openai.responses.create(request);
    } catch (firstError) {
      // If the conversation was created with a different model/version, the old
      // previous_response_id can be incompatible. Retry once as a fresh response
      // so upgrading the AI never breaks an existing conversation.
      const msg = String(firstError?.message || '').toLowerCase();
      const incompatible = /previous_response|response.*not found|not found.*response|cannot.*continue|incompatible/.test(msg);
      if (!incompatible || !request.previous_response_id) throw firstError;
      delete request.previous_response_id;
      response = await openai.responses.create(request);
    }
    let answer = response.output_text?.trim() || 'پاسخی دریافت نشد.';
    const fileReq = detectFileRequest(message);
    let attachments = [];
    const wantsImage = detectImageRequest(message);
    if (wantsImage) {
      try {
        const imageResult = await openai.images.generate({
          model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
          prompt: `Create the requested image faithfully. Do not add unrelated text, logos, watermarks, or invented requirements. User request: ${message}`,
          size: 'auto', quality: 'auto', output_format: 'png',
        });
        const item=imageResult?.data?.[0];
        if (item?.b64_json) {
          await recordUsage(req.user.id, 'image');
          attachments.push({type:'image',name:'تصویر ساخته‌شده توسط AmnaYar AI',dataUrl:`data:image/png;base64,${item.b64_json}`});
        }
      } catch(imageError) {
        console.error('Auto image generation error', imageError);
        const detail = imageError?.status === 429 ? 'سقف یا اعتبار سرویس OpenAI فعلاً اجازه ساخت تصویر نمی‌دهد.' : 'ساخت تصویر انجام نشد، اما پاسخ متنی آماده است.';
        answer += `\n\n⚠️ ${detail}`;
      }
    }
    const fileKind = Object.entries(fileReq).find(([k,v])=>v)?.[0];
    if (fileKind) {
      try { attachments.push(...await writeArtifact(fileKind, answer, message)); } catch(fileError) { console.error('Artifact generation error', fileError); answer += '\n\n⚠️ ساخت فایل خروجی انجام نشد.'; }
    }
    await q('INSERT INTO messages(conversation_id,user_id,role,content) VALUES($1,$2,\'user\',$3),($1,$2,\'assistant\',$4)', [conversationId, req.user.id, text, answer]);
    await q('UPDATE conversations SET previous_response_id=$1,updated_at=NOW(),title=CASE WHEN title=\'گفت‌وگوی جدید\' THEN LEFT($2,80) ELSE title END WHERE id=$3 AND user_id=$4', [response.id, text, conversationId, req.user.id]);
    await recordUsage(req.user.id, 'message');
    for (const fileId of uploadedForCleanup) {
      try { await openai.files.delete(fileId); } catch {}
    }
    res.json({ answer, responseId: response.id, attachments });
  } catch (e) {
    for (const fileId of uploadedForCleanup) {
      try { await openai.files.delete(fileId); } catch {}
    }
    console.error('AI error', e);
    const detail = e?.status === 401 ? 'کلید OpenAI روی سرور معتبر نیست.' : e?.status === 429 ? 'سقف یا اعتبار سرویس OpenAI فعلاً اجازه پاسخ‌گویی نمی‌دهد.' : e?.status === 400 ? 'فایل دریافت شد، اما قالب یا محتوای آن برای تحلیل قابل پردازش نبود. یک تصویر JPG یا PNG را امتحان کنید.' : 'ارتباط با موتور هوش مصنوعی برقرار نشد.';
    res.status(502).json({ error: detail });
  }
});

app.post('/api/generate-image', auth, imageLimiter, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'هوش مصنوعی هنوز فعال نشده است. کلید OPENAI_API_KEY باید در Render تنظیم شود.' });
  const plan = await getPlan(req.user.id);
  if (!(await canUseUsage(req.user.id, 'image', plan.imagesPerDay))) return res.status(429).json({ error: `سهم روزانه ساخت تصویر در طرح ${plan.name} شما تمام شده است. برای ادامه، Pro یا Business را فعال کنید.`, code:'PLAN_LIMIT', plan:plan.key });
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'توضیح تصویر را وارد کنید.' });
  if (prompt.length > 4000) return res.status(400).json({ error: 'توضیح تصویر بیش از حد طولانی است.' });
  try {
    const result = await openai.images.generate({
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
      prompt: `Create the requested image. Preserve the user's intent exactly. If the prompt is in Persian, understand it semantically. Do not add unrelated text, logos, watermarks, or invented requirements. User request: ${prompt}`,
      size: 'auto',
      quality: 'auto',
      output_format: 'png',
    });
    const item = result?.data?.[0];
    if (!item?.b64_json) throw new Error('IMAGE_DATA_MISSING');
    await recordUsage(req.user.id, 'image');
    res.json({ image: `data:image/png;base64,${item.b64_json}`, model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2' });
  } catch (e) {
    console.error('Image generation error', e);
    const detail = e?.status === 401 ? 'کلید OpenAI روی سرور معتبر نیست.' : e?.status === 429 ? 'سقف یا اعتبار سرویس OpenAI فعلاً اجازه ساخت تصویر نمی‌دهد.' : 'ساخت تصویر با موتور هوش مصنوعی ناموفق بود. دوباره تلاش کنید.';
    res.status(502).json({ error: detail });
  }
});

app.get('/api/owner/stats', auth, owner, async (req, res) => {
  const [users, checks, messages, revenue, activeSubscriptions] = await Promise.all([
    q("SELECT COUNT(*)::int count FROM users WHERE role='user'"),
    q('SELECT COUNT(*)::int count FROM checks'),
    q('SELECT COUNT(*)::int count FROM messages'),
    q("SELECT COALESCE(SUM(amount_toman),0)::bigint total FROM payment_orders WHERE status='paid'"),
    q("SELECT COUNT(*)::int count FROM subscriptions WHERE status='active' AND ends_at>NOW()"),
  ]);
  res.json({ users: users.rows[0].count, checks: checks.rows[0].count, messages: messages.rows[0].count, revenue: Number(revenue.rows[0].total), activeSubscriptions: activeSubscriptions.rows[0].count });
});
app.get('/api/owner/export.xlsx', auth, owner, async (req, res) => {
  const users = (await q('SELECT id,email,username,role,created_at FROM users ORDER BY id DESC')).rows;
  const checks = (await q('SELECT c.id,u.email,u.username,c.kind,c.result,c.created_at FROM checks c JOIN users u ON u.id=c.user_id ORDER BY c.id DESC')).rows;
  const messages = (await q('SELECT m.id,u.email,u.username,m.role,m.content,m.created_at FROM messages m JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 5000')).rows;
  const payments = (await q('SELECT p.id,u.email,u.username,p.plan,p.amount_toman,p.status,p.ref_id,p.created_at,p.paid_at FROM payment_orders p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC')).rows;
  const subscriptions = (await q('SELECT s.id,u.email,u.username,s.plan,s.status,s.amount_toman,s.starts_at,s.ends_at,s.ref_id FROM subscriptions s JOIN users u ON u.id=s.user_id ORDER BY s.id DESC')).rows;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(users), 'Users');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(checks), 'Checks');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(messages), 'Messages');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(payments), 'Payments');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(subscriptions), 'Subscriptions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="amnayar-report.xlsx"');
  res.send(buf);
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html')));
app.get('/ai', (req, res) => res.sendFile(path.join(__dirname, '../public/ai.html')));
app.get('/owner', (req, res) => res.sendFile(path.join(__dirname, '../public/owner.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, '../public/pricing.html')));
app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

init().then(() => app.listen(PORT, () => console.log(`AmnaYar running on ${PORT}`))).catch(e => { console.error(e); process.exit(1); });
