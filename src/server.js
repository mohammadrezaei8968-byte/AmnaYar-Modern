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

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'amnayar-modern', version: '3.2.0', ai: false, mode: 'free-checks' }));

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

app.get('/api/owner/stats', auth, owner, async (req, res) => {
  const [users, checks] = await Promise.all([
    q("SELECT COUNT(*)::int count FROM users WHERE role='user'"),
    q('SELECT COUNT(*)::int count FROM checks'),
  ]);
  res.json({ users: users.rows[0].count, checks: checks.rows[0].count });
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
app.get('/owner', (req, res) => res.sendFile(path.join(__dirname, '../public/owner.html')));
app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

init().then(() => app.listen(PORT, () => console.log(`AmnaYar running on ${PORT}`))).catch(e => { console.error(e); process.exit(1); });
