import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pg from 'pg';
import XLSX from 'xlsx';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false,
});

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public'), { extensions: ['html'] }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

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
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','hr','owner')),
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



  await q(`DO $$ BEGIN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','hr','owner'));
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  await q(`CREATE TABLE IF NOT EXISTS organizations(
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS organization_members(
    id BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    member_role TEXT NOT NULL DEFAULT 'member' CHECK (member_role IN ('hr','member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id,user_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS stores(
    id BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_code TEXT NOT NULL,
    store_name TEXT NOT NULL,
    address TEXT,
    postal_code TEXT,
    supervisor TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id,store_code)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS employees(
    id BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    personnel_code TEXT NOT NULL,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    store_code TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id,personnel_code)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS attendance_records(
    id BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    personnel_code TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT '',
    overtime_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
    allowed_hours NUMERIC(10,2),
    attendance_percent NUMERIC(6,2),
    excess_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id,personnel_code,period)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS report_imports(
    id BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    rows_imported INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS checks(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'amnayar-modern', version: '3.3.0', ai: false, mode: 'free-checks' }));

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
app.get('/api/me', auth, async (req, res) => {
  const r = await q('SELECT id,email,username,role,created_at FROM users WHERE id=$1', [req.user.id]);
  if (!r.rowCount) return res.status(401).json({ error: 'کاربر پیدا نشد.' });
  res.json({ user: r.rows[0] });
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

const iranBankCodes = {
  '010': 'بانک مرکزی',
  '011': 'بانک صنعت و معدن',
  '012': 'بانک ملت',
  '013': 'بانک رفاه کارگران',
  '014': 'بانک مسکن',
  '015': 'بانک سپه',
  '016': 'بانک کشاورزی',
  '017': 'بانک ملی ایران',
  '018': 'بانک تجارت',
  '019': 'بانک صادرات ایران',
  '020': 'بانک توسعه صادرات',
  '021': 'پست بانک ایران',
  '022': 'بانک توسعه تعاون',
  '051': 'بانک توسعه سرمایه',
  '053': 'بانک کارآفرین',
  '054': 'بانک پارسیان',
  '055': 'بانک اقتصاد نوین',
  '056': 'بانک سامان',
  '057': 'بانک پاسارگاد',
  '058': 'بانک سرمایه',
  '059': 'بانک سینا',
  '060': 'بانک شهر',
  '061': 'بانک دی',
  '062': 'بانک آینده',
  '063': 'بانک انصار',
  '064': 'بانک گردشگری',
  '065': 'بانک حکمت ایرانیان',
  '066': 'بانک ملل',
  '069': 'بانک ایران زمین',
  '070': 'بانک رسالت',
  '073': 'بانک کوثر',
  '075': 'بانک مهر ایران',
  '078': 'بانک خاورمیانه',
  '080': 'بانک نور',
  '090': 'بانک مهر اقتصاد',
  '095': 'بانک ایران و ونزوئلا'
};

const iranCardBanks = {
  '603799': 'بانک ملی ایران',
  '589210': 'بانک سپه',
  '627648': 'بانک توسعه صادرات ایران',
  '627961': 'بانک صنعت و معدن',
  '603770': 'بانک کشاورزی',
  '628023': 'بانک مسکن',
  '627760': 'پست بانک ایران',
  '502229': 'بانک پاسارگاد',
  '639347': 'بانک پاسارگاد',
  '627353': 'بانک تجارت',
  '585983': 'بانک تجارت',
  '603769': 'بانک صادرات ایران',
  '610433': 'بانک ملت',
  '627412': 'بانک اقتصاد نوین',
  '622106': 'بانک پارسیان',
  '639194': 'بانک پارسیان',
  '621986': 'بانک سامان',
  '639346': 'بانک سینا',
  '502938': 'بانک دی',
  '504172': 'بانک رسالت',
  '505416': 'بانک گردشگری',
  '505785': 'بانک ایران زمین',
  '502908': 'بانک توسعه تعاون',
  '639607': 'بانک سرمایه',
  '639217': 'بانک کشاورزی',
  '589463': 'بانک رفاه کارگران',
  '639599': 'بانک قوامین',
  '606373': 'بانک مهر ایران'
};

function cardBank(input) {
  return iranCardBanks[input.slice(0, 6)] || 'بانک از روی پیش‌شماره شناسایی نشد';
}

function ibanDetails(input) {
  const normalized = input.replace(/\s/g, '').toUpperCase();
  const bankCode = normalized.slice(4, 7);
  return {
    bankCode,
    bankName: iranBankCodes[bankCode] || 'بانک از روی کد شبا شناسایی نشد',
    accountNumber: normalized.slice(7)
  };
}

app.post('/api/check', auth, async (req, res) => {
  try {
    const kind = String(req.body.kind || '');
    const input = String(req.body.input || '')
      .replace(/[\s-]/g, '')
      .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
    const city = String(req.body.city || '').trim();
    const rules = {
      card: () => /^\d{16}$/.test(input) && luhn(input),
      national: () => iranNational(input),
      iban: () => iban(input),
    };
    if (!rules[kind]) return res.status(400).json({ error: 'نوع استعلام نامعتبر است.' });
    const valid = rules[kind]();
    const result = valid ? 'معتبر' : 'نامعتبر';
    await q('INSERT INTO checks(user_id,kind,input_hash,result) VALUES($1,$2,$3,$4)', [req.user.id, kind, sha256(input), result]);
    const details = {};
    if (kind === 'national') details.issuingCity = city || 'ثبت نشده';
    if (kind === 'card') details.bankName = valid ? cardBank(input) : 'قابل شناسایی نیست (شماره کارت نامعتبر است)';
    if (kind === 'iban') Object.assign(details, valid ? ibanDetails(input) : { bankCode: '—', bankName: 'قابل شناسایی نیست (شماره شبا نامعتبر است)', accountNumber: '—' });
    res.json({ valid, result, mode: 'structural', details, note: 'این نتیجه فقط اعتبارسنجی ساختاری است و تأیید مالکیت یا فعال بودن حساب محسوب نمی‌شود.' });
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


function digitsFa(v) {
  return String(v ?? '').replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).trim();
}
function numValue(v) {
  const s = digitsFa(v).replace(/,/g, '.').replace(/٪/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function headerKey(v) {
  return String(v ?? '').replace(/[\u200c\u200f\u200e]/g,'').replace(/[\s_\-]+/g,'').replace(/[():：]/g,'').trim().toLowerCase();
}
const columnAliases = {
  storeCode:['کد فروشگاه','کدفروشگاه','storecode','store_code'],
  storeName:['نام فروشگاه','نامفروشگاه','storename','store_name'],
  storeAddress:['آدرس فروشگاه','آدرسفروشگاه','آدرس','storeaddress','address'],
  storePostal:['کد پستی فروشگاه','کدپستيفروشگاه','کد پستی','کدپستی','storepostal','postalcode'],
  supervisor:['سوپروایزر فروشگاه','سوپروایزر','سرپرست فروشگاه','supervisor'],
  personnelCode:['کد پرسنلی','کدپرسنلی','کد پرسنل','personnelcode','personnel_code','employeeid'],
  firstName:['نام پرسنل','نام','firstname','first_name'],
  lastName:['نام خانوادگی پرسنل','نام خانوادگی','نامخانوادگی','lastname','last_name'],
  overtime:['اضافه کار پرسنل','اضافه کار','اضافه‌کار','اضافهکار','overtime','overtimehours'],
  allowed:['ساعت مجاز پرسنل','ساعت مجاز','ساعات مجاز','allowedhours','allowed_hours'],
  attendance:['درصد حضور پرسنل','درصد حضور','درصدحضور','attendance','attendancepercent','attendance_percent'],
  excess:['مازاد حضور پرسنل','مازاد حضور','مازادحضور','excesshours','excess_hours'],
  period:['دوره','ماه','دوره گزارش','period','month']
};
const aliasMap = new Map(Object.entries(columnAliases).flatMap(([k,arr]) => arr.map(a => [headerKey(a), k])));
function mapRow(row) {
  const out = {};
  for (const [k,v] of Object.entries(row)) { const target = aliasMap.get(headerKey(k)); if (target) out[target] = v; }
  return out;
}
function normalizeUploadRow(row, defaultPeriod='') {
  const r=mapRow(row);
  return {
    storeCode: digitsFa(r.storeCode), storeName:String(r.storeName||'').trim(), storeAddress:String(r.storeAddress||'').trim(), storePostal:digitsFa(r.storePostal), supervisor:String(r.supervisor||'').trim(),
    personnelCode:digitsFa(r.personnelCode), firstName:String(r.firstName||'').trim(), lastName:String(r.lastName||'').trim(),
    overtime:numValue(r.overtime) ?? 0, allowed:numValue(r.allowed), attendance:numValue(r.attendance), excess:numValue(r.excess) ?? 0, period:digitsFa(r.period || defaultPeriod)
  };
}
async function getHRContext(req, res) {
  if (req.user.role === 'owner') {
    const orgId = Number(req.query.org_id || 0);
    const r = orgId ? await q('SELECT * FROM organizations WHERE id=$1',[orgId]) : await q('SELECT * FROM organizations ORDER BY id LIMIT 1');
    if (!r.rowCount) { res.status(404).json({error:'هنوز سازمانی ساخته نشده است.'}); return null; }
    return r.rows[0];
  }
  if (req.user.role !== 'hr') { res.status(403).json({error:'دسترسی مدیر منابع انسانی لازم است.'}); return null; }
  const r = await q(`SELECT o.* FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=$1 AND m.member_role='hr' ORDER BY o.id LIMIT 1`,[req.user.id]);
  if (!r.rowCount) { res.status(404).json({error:'سازمانی برای این حساب منابع انسانی تعریف نشده است.'}); return null; }
  return r.rows[0];
}

app.get('/api/hr/dashboard', auth, async (req,res)=>{
  try {
    const org=await getHRContext(req,res); if(!org)return;
    const period=digitsFa(req.query.period||''); const search=String(req.query.search||'').trim();
    const like=`%${search}%`;
    const params=[org.id]; let p=2; const periodClause=period?` AND a.period=$${p++}`:''; const searchClause=search?` AND (e.personnel_code ILIKE $${p} OR e.first_name ILIKE $${p} OR e.last_name ILIKE $${p} OR COALESCE(s.store_name,'') ILIKE $${p})`:''; if(period)params.push(period); if(search)params.push(like);
    const [employees,stores,attendance,stats]=await Promise.all([
      q(`SELECT e.personnel_code,e.first_name,e.last_name,e.store_code,s.store_name,a.overtime_hours,a.allowed_hours,a.attendance_percent,a.excess_hours FROM employees e LEFT JOIN stores s ON s.organization_id=e.organization_id AND s.store_code=e.store_code LEFT JOIN LATERAL (SELECT * FROM attendance_records a0 WHERE a0.organization_id=e.organization_id AND a0.personnel_code=e.personnel_code${period?' AND a0.period=$2':''} ORDER BY a0.id DESC LIMIT 1) a ON true WHERE e.organization_id=$1${search?` AND (e.personnel_code ILIKE $${period?3:2} OR e.first_name ILIKE $${period?3:2} OR e.last_name ILIKE $${period?3:2} OR COALESCE(s.store_name,'') ILIKE $${period?3:2})`:''} ORDER BY e.personnel_code LIMIT 500`, period?[org.id,period,...(search?[like]:[])]:[org.id,...(search?[like]:[])]),
      q(`SELECT s.*,COUNT(e.id)::int employee_count FROM stores s LEFT JOIN employees e ON e.organization_id=s.organization_id AND e.store_code=s.store_code WHERE s.organization_id=$1 GROUP BY s.id ORDER BY s.store_code LIMIT 500`,[org.id]),
      q(`SELECT a.period,a.personnel_code,e.first_name,e.last_name,a.overtime_hours,a.allowed_hours,a.attendance_percent,a.excess_hours FROM attendance_records a LEFT JOIN employees e ON e.organization_id=a.organization_id AND e.personnel_code=a.personnel_code WHERE a.organization_id=$1${periodClause}${searchClause} ORDER BY a.id DESC LIMIT 1000`,params),
      q(`SELECT (SELECT COUNT(*) FROM employees WHERE organization_id=$1)::int employees,(SELECT COUNT(*) FROM stores WHERE organization_id=$1)::int stores,COALESCE((SELECT AVG(attendance_percent) FROM attendance_records WHERE organization_id=$1${period?' AND period=$2':''}),0)::numeric attendance_avg,COALESCE((SELECT SUM(overtime_hours) FROM attendance_records WHERE organization_id=$1${period?' AND period=$2':''}),0)::numeric overtime_total`,period?[org.id,period]:[org.id])
    ]);
    res.json({organization:org,stats:stats.rows[0],employees:employees.rows,stores:stores.rows,attendance:attendance.rows});
  }catch(e){console.error(e);res.status(500).json({error:'خطای دریافت داشبورد منابع انسانی.'})}
});

app.post('/api/hr/import', auth, upload.single('report'), async (req,res)=>{
  try {
    const org=await getHRContext(req,res); if(!org)return;
    if(!req.file)return res.status(400).json({error:'فایل گزارش را انتخاب کنید.'});
    const ext=path.extname(req.file.originalname).toLowerCase(); if(!['.xlsx','.xls','.csv'].includes(ext))return res.status(400).json({error:'فقط فایل Excel یا CSV مجاز است.'});
    const wb=XLSX.read(req.file.buffer,{type:'buffer',cellDates:false}); let rows=[];
    for(const name of wb.SheetNames){const sheet=XLSX.utils.sheet_to_json(wb.Sheets[name],{defval:''}); rows.push(...sheet.map(normalizeUploadRow));}
    const defaultPeriod=digitsFa(req.body.period||''); rows=rows.map(r=>({...r,period:r.period||defaultPeriod}));
    let imported=0,updated=0;
    for(const r of rows){
      if(r.storeCode && r.storeName){const old=await q('SELECT id FROM stores WHERE organization_id=$1 AND store_code=$2',[org.id,r.storeCode]); await q(`INSERT INTO stores(organization_id,store_code,store_name,address,postal_code,supervisor,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(organization_id,store_code) DO UPDATE SET store_name=EXCLUDED.store_name,address=EXCLUDED.address,postal_code=EXCLUDED.postal_code,supervisor=EXCLUDED.supervisor,updated_at=NOW()`,[org.id,r.storeCode,r.storeName,r.storeAddress||null,r.storePostal||null,r.supervisor||null]); old.rowCount?updated++:imported++;}
      if(r.personnelCode){const old=await q('SELECT id FROM employees WHERE organization_id=$1 AND personnel_code=$2',[org.id,r.personnelCode]); await q(`INSERT INTO employees(organization_id,personnel_code,first_name,last_name,store_code,updated_at) VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(organization_id,personnel_code) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,store_code=EXCLUDED.store_code,updated_at=NOW()`,[org.id,r.personnelCode,r.firstName,r.lastName,r.storeCode||null]); old.rowCount?updated++:imported++; if(r.period){const oldA=await q('SELECT id FROM attendance_records WHERE organization_id=$1 AND personnel_code=$2 AND period=$3',[org.id,r.personnelCode,r.period]); await q(`INSERT INTO attendance_records(organization_id,personnel_code,period,overtime_hours,allowed_hours,attendance_percent,excess_hours) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,personnel_code,period) DO UPDATE SET overtime_hours=EXCLUDED.overtime_hours,allowed_hours=EXCLUDED.allowed_hours,attendance_percent=EXCLUDED.attendance_percent,excess_hours=EXCLUDED.excess_hours,imported_at=NOW()`,[org.id,r.personnelCode,r.period,r.overtime,r.allowed,r.attendance,r.excess]); oldA.rowCount?updated++:imported++;}}
    }
    await q('INSERT INTO report_imports(organization_id,user_id,filename,rows_imported) VALUES($1,$2,$3,$4)',[org.id,req.user.id,req.file.originalname,rows.length]);
    res.json({ok:true,imported,updated,rows:rows.length});
  }catch(e){console.error(e);res.status(500).json({error:'پردازش فایل انجام نشد. قالب ستون‌ها را بررسی کنید.'})}
});

async function hrExportData(req){
  const org=await getHRContext(req,{status:()=>{},json:()=>{}}); if(!org)throw new Error('no org');
  const period=digitsFa(req.query.period||''); const search=String(req.query.search||'').trim(); const params=[org.id]; let extra=''; if(period){params.push(period);extra+=' AND a.period=$'+params.length;} if(search){params.push('%'+search+'%');extra+=' AND (e.personnel_code ILIKE $'+params.length+' OR e.first_name ILIKE $'+params.length+' OR e.last_name ILIKE $'+params.length+' OR COALESCE(s.store_name,\'\') ILIKE $'+params.length+')';}
  const employees=(await q(`SELECT e.personnel_code AS "کد پرسنلی",e.first_name AS "نام",e.last_name AS "نام خانوادگی",e.store_code AS "کد فروشگاه",s.store_name AS "نام فروشگاه",a.overtime_hours AS "اضافه کار پرسنل",a.allowed_hours AS "ساعت مجاز پرسنل",a.attendance_percent AS "درصد حضور پرسنل",a.excess_hours AS "مازاد حضور پرسنل",a.period AS "دوره" FROM employees e LEFT JOIN stores s ON s.organization_id=e.organization_id AND s.store_code=e.store_code LEFT JOIN LATERAL (SELECT * FROM attendance_records a0 WHERE a0.organization_id=e.organization_id AND a0.personnel_code=e.personnel_code${period?' AND a0.period=$2':''} ORDER BY a0.id DESC LIMIT 1) a ON true WHERE e.organization_id=$1${search?` AND (e.personnel_code ILIKE $${period?3:2} OR e.first_name ILIKE $${period?3:2} OR e.last_name ILIKE $${period?3:2} OR COALESCE(s.store_name,'') ILIKE $${period?3:2})`:''} ORDER BY e.personnel_code`,period?[org.id,period,...(search?[`%${search}%`]:[])]:[org.id,...(search?[`%${search}%`]:[])] )).rows;
  const stores=(await q(`SELECT store_code AS "کد فروشگاه",store_name AS "نام فروشگاه",address AS "آدرس فروشگاه",postal_code AS "کد پستی فروشگاه",supervisor AS "سوپروایزر فروشگاه" FROM stores WHERE organization_id=$1 ORDER BY store_code`,[org.id])).rows;
  const attendance=(await q(`SELECT a.period AS "دوره",a.personnel_code AS "کد پرسنلی",e.first_name AS "نام",e.last_name AS "نام خانوادگی",a.overtime_hours AS "اضافه کار پرسنل",a.allowed_hours AS "ساعت مجاز پرسنل",a.attendance_percent AS "درصد حضور پرسنل",a.excess_hours AS "مازاد حضور پرسنل" FROM attendance_records a LEFT JOIN employees e ON e.organization_id=a.organization_id AND e.personnel_code=a.personnel_code WHERE a.organization_id=$1${extra} ORDER BY a.id DESC`,params)).rows;
  return {org,employees,stores,attendance};
}
app.get('/api/hr/export.xlsx',auth,async(req,res)=>{try{const d=await hrExportData(req);const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(d.employees),'پرسنل');XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(d.stores),'فروشگاه‌ها');XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(d.attendance),'حضور و غیاب');const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="amnayar-${d.org.code}-hr.xlsx"`);res.send(buf)}catch(e){console.error(e);res.status(500).json({error:'خروجی Excel آماده نشد.'})}});
app.get('/api/hr/export.csv',auth,async(req,res)=>{try{const d=await hrExportData(req);const rows=d.employees.map(x=>({"کد فروشگاه":x['کد فروشگاه'],"نام فروشگاه":x['نام فروشگاه'],"کد پرسنلی":x['کد پرسنلی'],"نام":x['نام'],"نام خانوادگی":x['نام خانوادگی'],"اضافه کار پرسنل":x['اضافه کار پرسنل'],"ساعت مجاز پرسنل":x['ساعت مجاز پرسنل'],"درصد حضور پرسنل":x['درصد حضور پرسنل'],"مازاد حضور پرسنل":x['مازاد حضور پرسنل'],"دوره":x['دوره']}));const csv='\ufeff'+XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(rows));res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="amnayar-${d.org.code}-hr.csv"`);res.send(csv)}catch(e){console.error(e);res.status(500).json({error:'خروجی CSV آماده نشد.'})}});


app.get('/api/owner/organizations',auth,owner,async(req,res)=>{const r=await q(`SELECT o.id,o.name,o.code,COUNT(m.id)::int hr_count FROM organizations o LEFT JOIN organization_members m ON m.organization_id=o.id AND m.member_role='hr' GROUP BY o.id ORDER BY o.id DESC`);res.json({organizations:r.rows})});
app.post('/api/owner/organizations',auth,owner,async(req,res)=>{try{const name=String(req.body.name||'').trim(),code=String(req.body.code||'').trim().toUpperCase(),email=normalizeEmail(req.body.hr_email);if(!name||!/^[A-Z0-9_-]{3,32}$/.test(code)||!email)return res.status(400).json({error:'نام سازمان، کد سازمان و ایمیل مدیر منابع انسانی را کامل وارد کنید.'});const u=await q('SELECT id FROM users WHERE email=$1',[email]);if(!u.rowCount)return res.status(404).json({error:'ابتدا حساب کاربری مدیر منابع انسانی را با این ایمیل بسازید.'});const org=await q('INSERT INTO organizations(name,code,created_by) VALUES($1,$2,$3) RETURNING *',[name,code,req.user.id]);await q("UPDATE users SET role='hr' WHERE id=$1",[u.rows[0].id]);await q("INSERT INTO organization_members(organization_id,user_id,member_role) VALUES($1,$2,'hr') ON CONFLICT DO NOTHING",[org.rows[0].id,u.rows[0].id]);res.json({ok:true,organization:org.rows[0]})}catch(e){console.error(e);res.status(500).json({error:'ساخت سازمان انجام نشد؛ ممکن است کد سازمان تکراری باشد.'})}});
app.get('/api/owner/stats', auth, owner, async (req, res) => {
  const [users, checks] = await Promise.all([
    q("SELECT COUNT(*)::int count FROM users WHERE role='user'"),
    q('SELECT COUNT(*)::int count FROM checks'),
  ]);
  const orgs = await q('SELECT COUNT(*)::int count FROM organizations');
  const hr = await q("SELECT COUNT(*)::int count FROM users WHERE role='hr'");
  res.json({ users: users.rows[0].count, checks: checks.rows[0].count, organizations: orgs.rows[0].count, hr: hr.rows[0].count });
});
app.get('/api/owner/export.xlsx', auth, owner, async (req, res) => {
  const users = (await q('SELECT id,email,username,role,created_at FROM users ORDER BY id DESC')).rows;
  const checks = (await q('SELECT c.id,u.email,u.username,c.kind,c.result,c.created_at FROM checks c JOIN users u ON u.id=c.user_id ORDER BY c.id DESC')).rows;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(users), 'Users');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(checks), 'Checks');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="amnayar-report.xlsx"');
  res.send(buf);
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html')));
app.get('/hr', (req, res) => res.sendFile(path.join(__dirname, '../public/hr.html')));
app.get('/owner', (req, res) => res.sendFile(path.join(__dirname, '../public/owner.html')));
app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

init().then(() => app.listen(PORT, () => console.log(`AmnaYar running on ${PORT}`))).catch(e => { console.error(e); process.exit(1); });
