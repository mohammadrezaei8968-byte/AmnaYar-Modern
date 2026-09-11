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
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
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

// File-processing middleware must be initialized before any route that uses it.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const execFileAsync = promisify(execFile);

function contentDisposition(filename) {
  const safe = String(filename || 'amnayar-file').replace(/[\\"\r\n]/g, '_');
  return `attachment; filename="${safe}"`;
}

app.post('/api/compress/image', mediaUpload.single('file'), async (req, res) => {
  let dir = '';
  try {
    if (!req.file) return res.status(400).json({ error: 'تصویر را انتخاب کنید.' });
    if (!String(req.file.mimetype || '').startsWith('image/')) return res.status(400).json({ error: 'فقط فایل تصویری مجاز است.' });
    const quality = Math.min(90, Math.max(20, Number(req.body.quality || 70)));
    dir = await fs.mkdtemp('/tmp/amnayar-image-');
    const inputPath = path.join(dir, 'input');
    const outputPath = path.join(dir, 'output.jpg');
    await fs.writeFile(inputPath, req.file.buffer);
    // Sharp is bundled with the app, so image compression does not depend on ffmpeg.
    const sharp = (await import('sharp')).default;
    await sharp(inputPath).rotate().jpeg({ quality, mozjpeg: true }).toFile(outputPath);
    const out = await fs.readFile(outputPath);
    if (!out.length) return res.status(500).json({ error: 'خروجی تصویر ساخته نشد.' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', contentDisposition('amnayar-compressed.jpg'));
    res.setHeader('X-Original-Bytes', String(req.file.buffer.length));
    res.setHeader('X-Output-Bytes', String(out.length));
    res.send(out);
  } catch (e) {
    console.error('image compression:', e);
    res.status(400).json({ error: 'فشرده‌سازی تصویر انجام نشد. فرمت تصویر را بررسی کنید.' });
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.post('/api/compress/pdf', mediaUpload.single('file'), async (req, res) => {
  let inputPath = '', outputPath = '';
  try {
    if (!req.file) return res.status(400).json({ error: 'فایل PDF را انتخاب کنید.' });
    if (req.file.mimetype !== 'application/pdf' && !String(req.file.originalname).toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'فقط فایل PDF مجاز است.' });
    }
    const dir = await fs.mkdtemp('/tmp/amnayar-pdf-');
    inputPath = path.join(dir, 'input.pdf');
    outputPath = path.join(dir, 'output.pdf');
    await fs.writeFile(inputPath, req.file.buffer);
    const level = String(req.body.level || 'ebook');
    const settings = ['screen', 'ebook', 'printer'].includes(level) ? level : 'ebook';
    await execFileAsync('gs', ['-sDEVICE=pdfwrite','-dCompatibilityLevel=1.4','-dNOPAUSE','-dQUIET','-dBATCH',`-dPDFSETTINGS=/${settings}`,'-sOutputFile=' + outputPath,inputPath], { timeout: 120000 });
    const out = await fs.readFile(outputPath);
    if (out.length >= req.file.buffer.length) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDisposition('amnayar-compressed.pdf'));
      res.setHeader('X-Original-Bytes', String(req.file.buffer.length));
      res.setHeader('X-Output-Bytes', String(out.length));
      return res.send(out);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition('amnayar-compressed.pdf'));
    res.setHeader('X-Original-Bytes', String(req.file.buffer.length));
    res.setHeader('X-Output-Bytes', String(out.length));
    res.send(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشرده‌سازی PDF انجام نشد. ممکن است فایل رمزدار یا آسیب‌دیده باشد.' });
  } finally {
    if (inputPath) await fs.rm(path.dirname(inputPath), { recursive: true, force: true }).catch(() => {});
  }
});

app.post('/api/compress/video', mediaUpload.single('file'), async (req, res) => {
  let inputPath = '', outputPath = '';
  try {
    if (!req.file) return res.status(400).json({ error: 'ویدئو را انتخاب کنید.' });
    const dir = await fs.mkdtemp('/tmp/amnayar-video-');
    inputPath = path.join(dir, 'input');
    outputPath = path.join(dir, 'output.mp4');
    await fs.writeFile(inputPath, req.file.buffer);
    const quality = String(req.body.quality || 'balanced');
    const crf = quality === 'small' ? '31' : quality === 'high' ? '25' : '28';
    await execFileAsync('ffmpeg', ['-y','-i',inputPath,'-vf','scale=min(1280\,iw):-2:force_original_aspect_ratio=decrease','-c:v','libx264','-preset','veryfast','-crf',crf,'-c:a','aac','-b:a','128k','-movflags','+faststart',outputPath], { timeout: 300000 });
    const out = await fs.readFile(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', contentDisposition('amnayar-compressed.mp4'));
    res.setHeader('X-Original-Bytes', String(req.file.buffer.length));
    res.setHeader('X-Output-Bytes', String(out.length));
    res.send(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشرده‌سازی ویدئو انجام نشد. فرمت یا حجم فایل را بررسی کنید.' });
  } finally {
    if (inputPath) await fs.rm(path.dirname(inputPath), { recursive: true, force: true }).catch(() => {});
  }
});


// ترجمه رایگان فارسی ↔ انگلیسی؛ متن فقط برای همان درخواست به سرویس ترجمه ارسال می‌شود.
const translateLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
function decodeBasicHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
app.post('/api/translate', translateLimiter, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    const direction = req.body?.direction === 'en-fa' ? 'en|fa' : 'fa|en';
    if (!text) return res.status(400).json({ error: 'متن را وارد کنید.' });
    if (text.length > 5000) return res.status(400).json({ error: 'حداکثر ۵۰۰۰ نویسه مجاز است.' });
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${direction}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
      if (!r.ok) throw new Error(`translation upstream ${r.status}`);
      const data = await r.json();
      const translated = decodeBasicHtml(data?.responseData?.translatedText || '');
      if (!translated) throw new Error('empty translation');
      res.json({ translatedText: translated, direction: req.body?.direction === 'en-fa' ? 'en-fa' : 'fa-en' });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error('translation:', e);
    res.status(502).json({ error: 'ترجمه در حال حاضر در دسترس نیست؛ دوباره تلاش کنید.' });
  }
});

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
async function owner(req, res, next) {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'برای ادامه وارد حساب شوید.' });
    const r = await q('SELECT role,is_active FROM users WHERE id=$1', [req.user.id]);
    if (!r.rowCount || r.rows[0].is_active === false) return res.status(403).json({ error: 'دسترسی مالک لازم است.' });
    if (r.rows[0].role !== 'owner') return res.status(403).json({ error: 'دسترسی مالک لازم است.' });
    req.user.role = 'owner';
    next();
  } catch (e) {
    console.error('owner auth:', e);
    res.status(500).json({ error: 'بررسی دسترسی مالک انجام نشد.' });
  }
}
function safeUser(u) {
  return { id: u.id, email: u.email, username: u.username, role: u.role, is_active: u.is_active !== false, email_verified: !!u.email_verified, created_at: u.created_at };
}

app.get('/owner', auth, owner, (req, res) => res.sendFile(path.join(__dirname, '../public/owner.html')));
app.use(express.static(path.join(__dirname, '../public'), { extensions: ['html'] }));
async function ownerAudit(req, action, targetType='', targetId='', details={}) {
  try { await q('INSERT INTO owner_audit_logs(owner_user_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)', [req.user.id, action, targetType || null, targetId ? String(targetId) : null, JSON.stringify(details)]); } catch (e) { console.error('owner audit:', e); }
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
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
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



  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`);

  await q(`CREATE TABLE IF NOT EXISTS owner_audit_logs(
    id BIGSERIAL PRIMARY KEY,
    owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
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


  // v3.4 canonical HR fields based on the organization's real Excel report structure.
  const alterStatements = [
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS address TEXT`,
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS postal_code TEXT`,
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS store_supervisor TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS hire_date TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS job_title TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS system_job_title TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS unit_name TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS department_code TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS status TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS province TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS region TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS supervisor_unit TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS supervisor TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS cooperation_type TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS gender TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS system_name TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_type TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS status TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS province TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS city TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS urban_area TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS city_code TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS opening_date TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS manager TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS manager_code TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS chief TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS workshop_code TEXT`,
    `ALTER TABLE stores ADD COLUMN IF NOT EXISTS phone TEXT`,
    `ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS standard_hours NUMERIC(10,2)`,
    `ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS presence_hours NUMERIC(10,2)`,
    `ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS leave_used_percent NUMERIC(6,2)`,
    `ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS leave_balance NUMERIC(10,2)`,
    `ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS health_card_status TEXT`,
    `ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS medical_docs_pending NUMERIC(10,2)`,
    `ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS insurance_status TEXT`,
    `ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS no_shift_staff NUMERIC(10,2)`,
    `ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS source_sheet TEXT`
  ];
  for (const statement of alterStatements) await q(statement);
  await q(`CREATE TABLE IF NOT EXISTS store_metrics(
    id BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_code TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT '',
    recommended_headcount NUMERIC(10,2),
    actual_headcount NUMERIC(10,2),
    staffing_gap NUMERIC(10,2),
    presence_hours NUMERIC(10,2),
    attendance_percent NUMERIC(6,2),
    overtime_hours NUMERIC(10,2),
    excess_presence_hours NUMERIC(10,2),
    standard_hours NUMERIC(10,2),
    standard_presence_hours NUMERIC(10,2),
    standard_to_date_percent NUMERIC(6,2),
    leave_used_percent NUMERIC(6,2),
    leave_balance NUMERIC(10,2),
    no_shift_staff NUMERIC(10,2),
    health_card_issues NUMERIC(10,2),
    medical_docs_pending NUMERIC(10,2),
    source_sheet TEXT,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id,store_code,period)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS supervisor_summaries(
    id BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    supervisor TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT '',
    total_stores NUMERIC(10,2),
    franchise_stores NUMERIC(10,2),
    leased_stores NUMERIC(10,2),
    employee_count NUMERIC(10,2),
    recommended_headcount NUMERIC(10,2),
    staffing_gap NUMERIC(10,2),
    standard_hours NUMERIC(10,2),
    standard_presence_hours NUMERIC(10,2),
    standard_to_date_percent NUMERIC(6,2),
    presence_hours NUMERIC(10,2),
    attendance_percent NUMERIC(6,2),
    excess_presence_hours NUMERIC(10,2),
    overtime_hours NUMERIC(10,2),
    leave_balance NUMERIC(10,2),
    leave_used_percent NUMERIC(6,2),
    health_card_issues NUMERIC(10,2),
    medical_docs_pending NUMERIC(10,2),
    no_shift_staff NUMERIC(10,2),
    source_sheet TEXT,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id,supervisor,period)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS import_batches(
    id BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    detected_sheets JSONB NOT NULL DEFAULT '[]'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    stats JSONB NOT NULL DEFAULT '{}'::jsonb,
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
    const password = String(process.env.OWNER_PASSWORD);
    const existing = await q('SELECT id,username FROM users WHERE email=$1', [email]);
    const hash = await bcrypt.hash(password, 12);
    if (!existing.rowCount) {
      let username = 'owner';
      const taken = await q('SELECT 1 FROM users WHERE username=$1', [username]);
      if (taken.rowCount) username = 'site_owner';
      await q('INSERT INTO users(email,username,password_hash,credits,role,email_verified,is_active) VALUES($1,$2,$3,0,\'owner\',true,true)', [email, username, hash]);
    } else {
      await q('UPDATE users SET password_hash=$1, role=\'owner\', email_verified=true, is_active=true WHERE email=$2', [hash, email]);
    }
    console.log(`Owner account synchronized for ${email}`);
  }
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'amnayar-modern', version: '3.9.1', ai: false, mode: 'free-checks' }));

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
    if (r.rows[0].is_active === false) return res.status(403).json({ error: 'این حساب غیرفعال شده است. با مالک سامانه تماس بگیرید.' });
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
    res.json({ valid, result, details });
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
function textValue(v) { return String(v ?? '').trim(); }
function numValue(v) {
  const s = digitsFa(v).replace(/,/g, '.').replace(/٪/g, '').trim();
  if (!s || s === '#N/A' || s === '#VALUE!' || s === '#REF!' || s === '#DIV/0!') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function headerKey(v) {
  return String(v ?? '').replace(/[\u200c\u200f\u200e]/g,'').replace(/[\s_\-]+/g,'').replace(/[():：؟?]/g,'').trim().toLowerCase();
}
function pick(row, aliases) {
  const wanted = aliases.map(headerKey);
  for (const [k,v] of Object.entries(row)) if (wanted.includes(headerKey(k))) return v;
  return '';
}
function firstNonEmpty(...vals) { for (const v of vals) if (v !== undefined && v !== null && String(v).trim() !== '') return v; return ''; }
function normalizePeriod(v, fallback='') { return digitsFa(firstNonEmpty(v, fallback)); }
function cleanRow(row) { const out={}; for(const [k,v] of Object.entries(row)) out[String(k).trim()]=v; return out; }

function parseBasicEmployee(row) {
  const r=cleanRow(row);
  return {
    personnelCode:digitsFa(pick(r,['کد پرسنلي اصلی','کد پرسنلی','کد پرسنلي','کد پرسنل'])),
    firstName:textValue(pick(r,['نام'])), lastName:textValue(pick(r,['نام خانوادگي','نام خانوادگی'])),
    hireDate:textValue(pick(r,['تاريخ استخدام','تاریخ استخدام'])),
    jobTitle:textValue(pick(r,['سمت'])), systemJobTitle:textValue(pick(r,['سمت سیستمی'])),
    unitName:textValue(pick(r,['واحد','واحد سرپرست'])), departmentCode:digitsFa(pick(r,['کد دپارتمان'])),
    status:textValue(pick(r,['آخرين وضعيت (فعال / غيرفعال)','آخرین وضعیت','وضعيت','وضعیت'])),
    province:textValue(pick(r,['سریال استان مستقل','استان'])), region:textValue(pick(r,['سریال گروه منطقه','منطقه'])),
    supervisorUnit:textValue(pick(r,['واحد سرپرست'])), storeCode:digitsFa(pick(r,['کد فروشگاه'])),
    storeName:textValue(pick(r,['نام فروشگاه'])), supervisor:textValue(pick(r,['سوپروایزر'])),
    cooperationType:textValue(pick(r,['آخرين نوع همکاري','آخرین نوع همکاری','نوع همکاری'])), gender:textValue(pick(r,['جنسيت','جنسیت']))
  };
}
function parseStore(row) {
  const r=cleanRow(row);
  return {
    storeCode:digitsFa(pick(r,['کد فروشگاه','کد فروشگاه سیستم منابع انسانی'])),
    storeName:textValue(firstNonEmpty(pick(r,['نام فروشگاه']),pick(r,['نام فروشگاه سیستم منابع انسانی']))),
    systemName:textValue(pick(r,['نام فروشگاه سیستم منابع انسانی'])), address:textValue(firstNonEmpty(pick(r,['آدرس']),pick(r,['آدرس سیستمی']),pick(r,['آدرس2']))),
    postalCode:digitsFa(firstNonEmpty(pick(r,['کدپستی اصلی']),pick(r,['کد پستی']))), supervisor:textValue(firstNonEmpty(pick(r,['سوپروایزر']),pick(r,['سوپروایزر/معین فروش']))),
    supervisorCode:digitsFa(pick(r,['کد سوپروایزر'])), storeType:textValue(pick(r,['نوع فروشگاه','نوع'])), status:textValue(pick(r,['وضعیت','فعال؟'])),
    province:textValue(pick(r,['استان'])), city:textValue(pick(r,['شهر'])), urbanArea:textValue(pick(r,['منطقه شهری'])), cityCode:digitsFa(pick(r,['کد شهر'])),
    openingDate:textValue(firstNonEmpty(pick(r,['تاریخ افتتاحیه']),pick(r,['تاریخ افتتاحیه2']))), manager:textValue(pick(r,['مدیر','نام و نام خانوادگی عامل'])),
    managerCode:digitsFa(pick(r,['کد رئیس'])), chief:textValue(pick(r,['رئیس'])), workshopCode:digitsFa(pick(r,['کد کارگاهی'])), phone:textValue(firstNonEmpty(pick(r,['تلفن']),pick(r,['شماره تماس عامل'])))
  };
}
function parseStoreMetrics(row, period, sheet) {
  const r=cleanRow(row);
  return {
    storeCode:digitsFa(pick(r,['کد فروشگاه'])), period:normalizePeriod(pick(r,['دوره','ماه']),period),
    recommendedHeadcount:numValue(pick(r,['تعداد نفر پیشنهادی','پرسنل مجاز','تعداد مجاز'])), actualHeadcount:numValue(pick(r,['تعداد پرسنل'])), staffingGap:numValue(pick(r,['مغایرت نیرو'])),
    presenceHours:numValue(pick(r,['ساعت حضور تا دیروز'])), attendancePercent:numValue(pick(r,['درصد حضور'])), overtimeHours:numValue(pick(r,['اضافه کار تا دیروز'])), excessPresenceHours:numValue(pick(r,['ساعت مازاد حضور'])),
    standardHours:numValue(pick(r,['ساعت استاندارد'])), standardPresenceHours:numValue(pick(r,['ساعت حضور استاندارد تا دیروز'])), standardToDatePercent:numValue(pick(r,['درصد استاندارد تا دیروز'])),
    leaveUsedPercent:numValue(pick(r,['درصد مرخصی استفاده شده'])), leaveBalance:numValue(firstNonEmpty(pick(r,['مانده مرخصی']),pick(r,['مانده مرخصی ماه گذشته']))),
    noShiftStaff:numValue(pick(r,['پرسنل بدون شیفت'])), healthCardIssues:numValue(pick(r,['فاقد/منقضی/کمتر از 15 روز - کارت بهداشت'])), medicalDocsPending:numValue(pick(r,['تعداد مدارک درمانی تحویل نشده'])), sourceSheet:sheet
  };
}
function parseAttendance(row, period, sheet) {
  const r=cleanRow(row);
  const personnelCode=digitsFa(pick(r,['کد پرسنلي اصلی','کد پرسنلی','کد پرسنلي','کد پرسنل','کد پرسنلی اصلی']));
  if(!personnelCode) return null;
  return { personnelCode, period:normalizePeriod(pick(r,['دوره','ماه']),period), storeCode:digitsFa(pick(r,['کد فروشگاه'])), firstName:textValue(pick(r,['نام'])), lastName:textValue(pick(r,['نام خانوادگي','نام خانوادگی'])),
    standardHours:numValue(pick(r,['ساعت استاندارد'])), allowedHours:numValue(pick(r,['ساعت مجاز','ساعت مجاز پرسنل'])), presenceHours:numValue(pick(r,['ساعت حضور','ساعت حضور تا دیروز'])),
    attendancePercent:numValue(pick(r,['درصد حضور'])), overtimeHours:numValue(pick(r,['اضافه کار پرسنل','اضافه کار تا دیروز'])), excessHours:numValue(pick(r,['ساعت مازاد حضور','مازاد حضور پرسنل'])),
    leaveUsedPercent:numValue(pick(r,['درصد مرخصی استفاده شده'])), leaveBalance:numValue(pick(r,['مانده مرخصی'])), noShiftStaff:numValue(pick(r,['پرسنل بدون شیفت'])),
    healthCardStatus:textValue(pick(r,['کارت بهداشت','فاقد/منقضی/کمتر از 15 روز - کارت بهداشت'])), medicalDocsPending:numValue(pick(r,['تعداد مدارک درمانی تحویل نشده'])), insuranceStatus:textValue(pick(r,['وضعیت بیمه'])), sourceSheet:sheet };
}
function parseSupervisor(row, period, sheet) {
  const r=cleanRow(row); const supervisor=textValue(pick(r,['سوپروایزر'])); if(!supervisor) return null;
  return { supervisor, period:normalizePeriod(pick(r,['دوره','ماه']),period), totalStores:numValue(pick(r,['تعداد کل فروشگاه زیرمجموعه'])), franchiseStores:numValue(pick(r,['تعداد فروشگاه فرانچایز'])), leasedStores:numValue(pick(r,['تعداد فروشگاه اجاره ای'])),
    employeeCount:numValue(pick(r,['تعداد پرسنل'])), recommendedHeadcount:numValue(pick(r,['تعداد نفر پیشنهادی'])), staffingGap:numValue(pick(r,['مغایرت نیرو'])), standardHours:numValue(pick(r,['ساعت استاندارد'])), standardPresenceHours:numValue(pick(r,['ساعت حضور استاندارد تا دیروز'])), standardToDatePercent:numValue(pick(r,['درصد استاندارد تا دیروز'])), presenceHours:numValue(pick(r,['ساعت حضور تا دیروز'])), attendancePercent:numValue(pick(r,['درصد حضور'])), excessPresenceHours:numValue(pick(r,['ساعت مازاد حضور'])), overtimeHours:numValue(pick(r,['اضافه کار تا دیروز'])), leaveBalance:numValue(pick(r,['مانده مرخصی'])), leaveUsedPercent:numValue(pick(r,['درصد استفاده شده از مرخصی زیرمجموعه'])), healthCardIssues:numValue(pick(r,['فاقد/منقضی/کمتر از 15 روز - کارت بهداشت'])), medicalDocsPending:numValue(pick(r,['تعداد مدارک درمانی تحویل نشده'])), noShiftStaff:numValue(pick(r,['پرسنل بدون شیفت'])), sourceSheet:sheet };
}
function workbookPreview(wb, defaultPeriod='') {
  const sheetStats=[]; const warnings=[]; let employeeRows=0,storeRows=0,attendanceRows=0,storeMetricRows=0,supervisorRows=0;
  for(const name of wb.SheetNames){ const rows=XLSX.utils.sheet_to_json(wb.Sheets[name],{defval:'',raw:false}); const headers=rows[0]?Object.keys(rows[0]):[]; const nk=headerKey(name); let kind='نادیده';
    if(nk.includes('basicreport')) {kind='پرسنل'; employeeRows+=rows.length;} else if(nk==='store' || nk.includes('فروشگاهها')) {kind='فروشگاه'; storeRows+=rows.length;} else if(nk.includes('رندشده')) {kind='حضور/شاخص'; attendanceRows+=rows.length;storeMetricRows+=rows.length;} else if(nk.includes('سوپروایزر')) {kind='خلاصه سوپروایزر';supervisorRows+=rows.length;} else if(nk.includes('pivot')) kind='گزارش تجمیعی مرجع';
    const errors=rows.reduce((n,r)=>n+Object.values(r).filter(v=>String(v).startsWith('#')).length,0); if(errors) warnings.push(`${name}: ${errors} سلول خطادار مثل #N/A یا #VALUE!`);
    sheetStats.push({name,kind,rows:rows.length,columns:headers.length,headers:headers.slice(0,12)});
  }
  if(!wb.SheetNames.some(n=>headerKey(n).includes('basicreport'))) warnings.push('برگه Basic report پیدا نشد؛ اطلاعات پرسنل ممکن است ناقص باشد.');
  return {sheetStats,warnings,counts:{employeeRows,storeRows,attendanceRows,storeMetricRows,supervisorRows}};
}
async function getHRContext(req, res) {
  if (req.user.role === 'owner') { const orgId=Number(req.query.org_id||req.body?.org_id||0); const r=orgId?await q('SELECT * FROM organizations WHERE id=$1',[orgId]):await q('SELECT * FROM organizations ORDER BY id LIMIT 1'); if(!r.rowCount){res.status(404).json({error:'هنوز سازمانی ساخته نشده است.'});return null;} return r.rows[0]; }
  if(req.user.role!=='hr'){res.status(403).json({error:'دسترسی مدیر منابع انسانی لازم است.'});return null;}
  const r=await q(`SELECT o.* FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=$1 AND m.member_role='hr' ORDER BY o.id LIMIT 1`,[req.user.id]); if(!r.rowCount){res.status(404).json({error:'سازمانی برای این حساب منابع انسانی تعریف نشده است.'});return null;} return r.rows[0];
}

app.post('/api/hr/preview', auth, upload.single('report'), async(req,res)=>{ try{const org=await getHRContext(req,res);if(!org)return;if(!req.file)return res.status(400).json({error:'فایل گزارش را انتخاب کنید.'});const ext=path.extname(req.file.originalname).toLowerCase();if(!['.xlsx','.xls','.csv'].includes(ext))return res.status(400).json({error:'فقط فایل Excel یا CSV مجاز است.'});const wb=XLSX.read(req.file.buffer,{type:'buffer',cellDates:false});const preview=workbookPreview(wb,digitsFa(req.body.period||''));res.json({ok:true,filename:req.file.originalname,organization:{id:org.id,name:org.name,code:org.code},...preview});}catch(e){console.error(e);res.status(500).json({error:'پیش‌نمایش فایل انجام نشد.'})} });

app.get('/api/hr/dashboard', auth, async(req,res)=>{try{const org=await getHRContext(req,res);if(!org)return;const period=digitsFa(req.query.period||'');const search=String(req.query.search||'').trim();const like=`%${search}%`;const p1=[org.id];if(period)p1.push(period);if(search)p1.push(like);const periodSql=period?' AND a.period=$2':'';const searchSql=search?` AND (e.personnel_code ILIKE $${period?3:2} OR e.first_name ILIKE $${period?3:2} OR e.last_name ILIKE $${period?3:2} OR COALESCE(s.store_name,'') ILIKE $${period?3:2})`:'';
 const [employees,stores,attendance,storeMetrics,supervisors,stats,imports]=await Promise.all([
 q(`SELECT e.personnel_code,e.first_name,e.last_name,e.store_code,s.store_name,e.hire_date,e.job_title,e.unit_name,e.status,e.supervisor,e.cooperation_type,a.period,a.overtime_hours,a.allowed_hours,a.attendance_percent,a.excess_hours,a.presence_hours,a.health_card_status FROM employees e LEFT JOIN stores s ON s.organization_id=e.organization_id AND s.store_code=e.store_code LEFT JOIN LATERAL(SELECT * FROM attendance_records a0 WHERE a0.organization_id=e.organization_id AND a0.personnel_code=e.personnel_code${period?' AND a0.period=$2':''} ORDER BY a0.id DESC LIMIT 1)a ON true WHERE e.organization_id=$1${searchSql} ORDER BY e.personnel_code LIMIT 1000`,p1),
 q(`SELECT s.*,COUNT(e.id)::int employee_count FROM stores s LEFT JOIN employees e ON e.organization_id=s.organization_id AND e.store_code=s.store_code WHERE s.organization_id=$1 GROUP BY s.id ORDER BY s.store_code LIMIT 1000`,[org.id]),
 q(`SELECT a.period,a.personnel_code,e.first_name,e.last_name,e.store_code,s.store_name,a.standard_hours,a.allowed_hours,a.presence_hours,a.overtime_hours,a.attendance_percent,a.excess_hours,a.leave_used_percent,a.leave_balance,a.health_card_status,a.medical_docs_pending,a.insurance_status,a.no_shift_staff FROM attendance_records a LEFT JOIN employees e ON e.organization_id=a.organization_id AND e.personnel_code=a.personnel_code LEFT JOIN stores s ON s.organization_id=e.organization_id AND s.store_code=e.store_code WHERE a.organization_id=$1${period?' AND a.period=$2':''}${search?` AND (a.personnel_code ILIKE $${period?3:2} OR e.first_name ILIKE $${period?3:2} OR e.last_name ILIKE $${period?3:2} OR COALESCE(s.store_name,'') ILIKE $${period?3:2})`:''} ORDER BY a.id DESC LIMIT 1500`,p1),
 q(`SELECT * FROM store_metrics WHERE organization_id=$1${period?' AND period=$2':''} ORDER BY store_code LIMIT 1000`,period?[org.id,period]:[org.id]),
 q(`SELECT * FROM supervisor_summaries WHERE organization_id=$1${period?' AND period=$2':''} ORDER BY supervisor LIMIT 500`,period?[org.id,period]:[org.id]),
 q(`SELECT (SELECT COUNT(*) FROM employees WHERE organization_id=$1)::int employees,(SELECT COUNT(*) FROM stores WHERE organization_id=$1)::int stores,COALESCE((SELECT AVG(attendance_percent) FROM attendance_records WHERE organization_id=$1${period?' AND period=$2':''}),0)::numeric attendance_avg,COALESCE((SELECT SUM(overtime_hours) FROM attendance_records WHERE organization_id=$1${period?' AND period=$2':''}),0)::numeric overtime_total,COALESCE((SELECT SUM(excess_presence_hours) FROM store_metrics WHERE organization_id=$1${period?' AND period=$2':''}),0)::numeric excess_total`,period?[org.id,period]:[org.id]),
 q(`SELECT id,filename,rows_imported,created_at FROM report_imports WHERE organization_id=$1 ORDER BY id DESC LIMIT 20`,[org.id])
 ]);res.json({organization:org,stats:stats.rows[0],employees:employees.rows,stores:stores.rows,attendance:attendance.rows,storeMetrics:storeMetrics.rows,supervisors:supervisors.rows,imports:imports.rows});}catch(e){console.error(e);res.status(500).json({error:'خطای دریافت داشبورد منابع انسانی.'})}});

app.post('/api/hr/import', auth, upload.single('report'), async(req,res)=>{try{const org=await getHRContext(req,res);if(!org)return;if(!req.file)return res.status(400).json({error:'فایل گزارش را انتخاب کنید.'});const ext=path.extname(req.file.originalname).toLowerCase();if(!['.xlsx','.xls','.csv'].includes(ext))return res.status(400).json({error:'فقط فایل Excel یا CSV مجاز است.'});const period=digitsFa(req.body.period||'');const wb=XLSX.read(req.file.buffer,{type:'buffer',cellDates:false});const preview=workbookPreview(wb,period);const employees=new Map(),stores=new Map(),attendance=new Map(),storeMetrics=new Map(),supervisors=new Map();
 for(const name of wb.SheetNames){const rows=XLSX.utils.sheet_to_json(wb.Sheets[name],{defval:'',raw:false});const nk=headerKey(name);if(nk.includes('basicreport')){for(const row of rows){const x=parseBasicEmployee(row);if(x.personnelCode)employees.set(x.personnelCode,x);if(x.storeCode&&x.storeName&&!stores.has(x.storeCode))stores.set(x.storeCode,parseStore(row));}}
 else if(nk==='store'){for(const row of rows){const x=parseStore(row);if(x.storeCode)stores.set(x.storeCode,x);}}
 else if(nk.includes('فروشگاهها')){for(const row of rows){const st=parseStore(row);if(st.storeCode)stores.set(st.storeCode,{...(stores.get(st.storeCode)||{}),...st});const m=parseStoreMetrics(row,period,name);if(m.storeCode)storeMetrics.set(`${m.storeCode}|${m.period}`,m);}}
 else if(nk.includes('رندشده')){for(const row of rows){const a=parseAttendance(row,period,name);if(a)attendance.set(`${a.personnelCode}|${a.period}`,a);const m=parseStoreMetrics(row,period,name);if(m.storeCode)storeMetrics.set(`${m.storeCode}|${m.period}`,m);}}
 else if(nk.includes('سوپروایزر')){for(const row of rows){const s=parseSupervisor(row,period,name);if(s)supervisors.set(`${s.supervisor}|${s.period}`,s);}}
 }
 const client=await pool.connect();try{await client.query('BEGIN');
 for(const x of stores.values()) await client.query(`INSERT INTO stores(organization_id,store_code,store_name,system_name,address,postal_code,supervisor,store_type,status,province,city,urban_area,city_code,opening_date,manager,manager_code,chief,workshop_code,phone,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW()) ON CONFLICT(organization_id,store_code) DO UPDATE SET store_name=COALESCE(NULLIF(EXCLUDED.store_name,''),stores.store_name),system_name=COALESCE(NULLIF(EXCLUDED.system_name,''),stores.system_name),address=COALESCE(NULLIF(EXCLUDED.address,''),stores.address),postal_code=COALESCE(NULLIF(EXCLUDED.postal_code,''),stores.postal_code),supervisor=COALESCE(NULLIF(EXCLUDED.supervisor,''),stores.supervisor),store_type=COALESCE(NULLIF(EXCLUDED.store_type,''),stores.store_type),status=COALESCE(NULLIF(EXCLUDED.status,''),stores.status),province=COALESCE(NULLIF(EXCLUDED.province,''),stores.province),city=COALESCE(NULLIF(EXCLUDED.city,''),stores.city),urban_area=COALESCE(NULLIF(EXCLUDED.urban_area,''),stores.urban_area),city_code=COALESCE(NULLIF(EXCLUDED.city_code,''),stores.city_code),opening_date=COALESCE(NULLIF(EXCLUDED.opening_date,''),stores.opening_date),manager=COALESCE(NULLIF(EXCLUDED.manager,''),stores.manager),manager_code=COALESCE(NULLIF(EXCLUDED.manager_code,''),stores.manager_code),chief=COALESCE(NULLIF(EXCLUDED.chief,''),stores.chief),workshop_code=COALESCE(NULLIF(EXCLUDED.workshop_code,''),stores.workshop_code),phone=COALESCE(NULLIF(EXCLUDED.phone,''),stores.phone),updated_at=NOW()`,[org.id,x.storeCode,x.storeName,x.systemName,x.address,x.postalCode,x.supervisor,x.storeType,x.status,x.province,x.city,x.urbanArea,x.cityCode,x.openingDate,x.manager,x.managerCode,x.chief,x.workshopCode,x.phone]);
 for(const x of employees.values()) await client.query(`INSERT INTO employees(organization_id,personnel_code,first_name,last_name,store_code,hire_date,job_title,system_job_title,unit_name,department_code,status,province,region,supervisor_unit,supervisor,cooperation_type,gender,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW()) ON CONFLICT(organization_id,personnel_code) DO UPDATE SET first_name=COALESCE(NULLIF(EXCLUDED.first_name,''),employees.first_name),last_name=COALESCE(NULLIF(EXCLUDED.last_name,''),employees.last_name),store_code=COALESCE(NULLIF(EXCLUDED.store_code,''),employees.store_code),hire_date=COALESCE(NULLIF(EXCLUDED.hire_date,''),employees.hire_date),job_title=COALESCE(NULLIF(EXCLUDED.job_title,''),employees.job_title),system_job_title=COALESCE(NULLIF(EXCLUDED.system_job_title,''),employees.system_job_title),unit_name=COALESCE(NULLIF(EXCLUDED.unit_name,''),employees.unit_name),department_code=COALESCE(NULLIF(EXCLUDED.department_code,''),employees.department_code),status=COALESCE(NULLIF(EXCLUDED.status,''),employees.status),province=COALESCE(NULLIF(EXCLUDED.province,''),employees.province),region=COALESCE(NULLIF(EXCLUDED.region,''),employees.region),supervisor_unit=COALESCE(NULLIF(EXCLUDED.supervisor_unit,''),employees.supervisor_unit),supervisor=COALESCE(NULLIF(EXCLUDED.supervisor,''),employees.supervisor),cooperation_type=COALESCE(NULLIF(EXCLUDED.cooperation_type,''),employees.cooperation_type),gender=COALESCE(NULLIF(EXCLUDED.gender,''),employees.gender),updated_at=NOW()`,[org.id,x.personnelCode,x.firstName,x.lastName,x.storeCode||null,x.hireDate,x.jobTitle,x.systemJobTitle,x.unitName,x.departmentCode,x.status,x.province,x.region,x.supervisorUnit,x.supervisor,x.cooperationType,x.gender]);
 for(const x of attendance.values()) await client.query(`INSERT INTO attendance_records(organization_id,personnel_code,period,standard_hours,overtime_hours,allowed_hours,presence_hours,attendance_percent,excess_hours,leave_used_percent,leave_balance,health_card_status,medical_docs_pending,insurance_status,no_shift_staff,source_sheet) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(organization_id,personnel_code,period) DO UPDATE SET standard_hours=EXCLUDED.standard_hours,overtime_hours=EXCLUDED.overtime_hours,allowed_hours=EXCLUDED.allowed_hours,presence_hours=EXCLUDED.presence_hours,attendance_percent=EXCLUDED.attendance_percent,excess_hours=EXCLUDED.excess_hours,leave_used_percent=EXCLUDED.leave_used_percent,leave_balance=EXCLUDED.leave_balance,health_card_status=EXCLUDED.health_card_status,medical_docs_pending=EXCLUDED.medical_docs_pending,insurance_status=EXCLUDED.insurance_status,no_shift_staff=EXCLUDED.no_shift_staff,source_sheet=EXCLUDED.source_sheet,imported_at=NOW()`,[org.id,x.personnelCode,x.period,x.standardHours,x.overtimeHours,x.allowedHours,x.presenceHours,x.attendancePercent,x.excessHours,x.leaveUsedPercent,x.leaveBalance,x.healthCardStatus,x.medicalDocsPending,x.insuranceStatus,x.noShiftStaff,x.sourceSheet]);
 for(const x of storeMetrics.values()) await client.query(`INSERT INTO store_metrics(organization_id,store_code,period,recommended_headcount,actual_headcount,staffing_gap,presence_hours,attendance_percent,overtime_hours,excess_presence_hours,standard_hours,standard_presence_hours,standard_to_date_percent,leave_used_percent,leave_balance,no_shift_staff,health_card_issues,medical_docs_pending,source_sheet) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT(organization_id,store_code,period) DO UPDATE SET recommended_headcount=EXCLUDED.recommended_headcount,actual_headcount=EXCLUDED.actual_headcount,staffing_gap=EXCLUDED.staffing_gap,presence_hours=EXCLUDED.presence_hours,attendance_percent=EXCLUDED.attendance_percent,overtime_hours=EXCLUDED.overtime_hours,excess_presence_hours=EXCLUDED.excess_presence_hours,standard_hours=EXCLUDED.standard_hours,standard_presence_hours=EXCLUDED.standard_presence_hours,standard_to_date_percent=EXCLUDED.standard_to_date_percent,leave_used_percent=EXCLUDED.leave_used_percent,leave_balance=EXCLUDED.leave_balance,no_shift_staff=EXCLUDED.no_shift_staff,health_card_issues=EXCLUDED.health_card_issues,medical_docs_pending=EXCLUDED.medical_docs_pending,source_sheet=EXCLUDED.source_sheet,imported_at=NOW()`,[org.id,x.storeCode,x.period,x.recommendedHeadcount,x.actualHeadcount,x.staffingGap,x.presenceHours,x.attendancePercent,x.overtimeHours,x.excessPresenceHours,x.standardHours,x.standardPresenceHours,x.standardToDatePercent,x.leaveUsedPercent,x.leaveBalance,x.noShiftStaff,x.healthCardIssues,x.medicalDocsPending,x.sourceSheet]);
 for(const x of supervisors.values()) await client.query(`INSERT INTO supervisor_summaries(organization_id,supervisor,period,total_stores,franchise_stores,leased_stores,employee_count,recommended_headcount,staffing_gap,standard_hours,standard_presence_hours,standard_to_date_percent,presence_hours,attendance_percent,excess_presence_hours,overtime_hours,leave_balance,leave_used_percent,health_card_issues,medical_docs_pending,no_shift_staff,source_sheet) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT(organization_id,supervisor,period) DO UPDATE SET total_stores=EXCLUDED.total_stores,franchise_stores=EXCLUDED.franchise_stores,leased_stores=EXCLUDED.leased_stores,employee_count=EXCLUDED.employee_count,recommended_headcount=EXCLUDED.recommended_headcount,staffing_gap=EXCLUDED.staffing_gap,standard_hours=EXCLUDED.standard_hours,standard_presence_hours=EXCLUDED.standard_presence_hours,standard_to_date_percent=EXCLUDED.standard_to_date_percent,presence_hours=EXCLUDED.presence_hours,attendance_percent=EXCLUDED.attendance_percent,excess_presence_hours=EXCLUDED.excess_presence_hours,overtime_hours=EXCLUDED.overtime_hours,leave_balance=EXCLUDED.leave_balance,leave_used_percent=EXCLUDED.leave_used_percent,health_card_issues=EXCLUDED.health_card_issues,medical_docs_pending=EXCLUDED.medical_docs_pending,no_shift_staff=EXCLUDED.no_shift_staff,source_sheet=EXCLUDED.source_sheet,imported_at=NOW()`,[org.id,x.supervisor,x.period,x.totalStores,x.franchiseStores,x.leasedStores,x.employeeCount,x.recommendedHeadcount,x.staffingGap,x.standardHours,x.standardPresenceHours,x.standardToDatePercent,x.presenceHours,x.attendancePercent,x.excessPresenceHours,x.overtimeHours,x.leaveBalance,x.leaveUsedPercent,x.healthCardIssues,x.medicalDocsPending,x.noShiftStaff,x.sourceSheet]);
 const stats={employees:employees.size,stores:stores.size,attendance:attendance.size,storeMetrics:storeMetrics.size,supervisors:supervisors.size};await client.query('INSERT INTO report_imports(organization_id,user_id,filename,rows_imported) VALUES($1,$2,$3,$4)',[org.id,req.user.id,req.file.originalname,employees.size+stores.size+attendance.size]);await client.query('INSERT INTO import_batches(organization_id,user_id,filename,detected_sheets,warnings,stats) VALUES($1,$2,$3,$4,$5,$6)',[org.id,req.user.id,req.file.originalname,JSON.stringify(preview.sheetStats),JSON.stringify(preview.warnings),JSON.stringify(stats)]);await client.query('COMMIT');res.json({ok:true,version:'3.4.0',stats,warnings:preview.warnings,sheets:preview.sheetStats});}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}}
 catch(e){console.error(e);res.status(500).json({error:'پردازش فایل انجام نشد. قالب گزارش را بررسی کنید.'})}});

async function hrExportData(req){const org=await getHRContext(req,{status:()=>{},json:()=>{}});if(!org)throw new Error('no org');const period=digitsFa(req.query.period||'');const params=period?[org.id,period]:[org.id];const employees=(await q(`SELECT e.personnel_code AS "کد پرسنلی",e.first_name AS "نام",e.last_name AS "نام خانوادگی",e.hire_date AS "تاریخ استخدام",e.job_title AS "سمت",e.system_job_title AS "سمت سیستمی",e.unit_name AS "واحد",e.department_code AS "کد دپارتمان",e.status AS "وضعیت پرسنل",e.province AS "استان",e.region AS "منطقه",e.store_code AS "کد فروشگاه",s.store_name AS "نام فروشگاه",e.supervisor AS "سوپروایزر",e.cooperation_type AS "نوع همکاری",e.gender AS "جنسیت" FROM employees e LEFT JOIN stores s ON s.organization_id=e.organization_id AND s.store_code=e.store_code WHERE e.organization_id=$1 ORDER BY e.personnel_code`,[org.id])).rows;const stores=(await q(`SELECT store_code AS "کد فروشگاه",store_name AS "نام فروشگاه",system_name AS "نام فروشگاه سیستمی",address AS "آدرس فروشگاه",postal_code AS "کد پستی فروشگاه",supervisor AS "سوپروایزر",store_type AS "نوع فروشگاه",status AS "وضعیت فروشگاه",province AS "استان",city AS "شهر",urban_area AS "منطقه شهری",opening_date AS "تاریخ افتتاحیه",manager AS "مدیر فروشگاه",manager_code AS "کد مدیر",chief AS "رئیس",workshop_code AS "کد کارگاهی",phone AS "شماره تماس" FROM stores WHERE organization_id=$1 ORDER BY store_code`,[org.id])).rows;const attendance=(await q(`SELECT a.period AS "دوره",a.personnel_code AS "کد پرسنلی",e.first_name AS "نام",e.last_name AS "نام خانوادگی",e.store_code AS "کد فروشگاه",s.store_name AS "نام فروشگاه",a.standard_hours AS "ساعت استاندارد",a.allowed_hours AS "ساعت مجاز",a.presence_hours AS "ساعت حضور",a.attendance_percent AS "درصد حضور",a.overtime_hours AS "اضافه کار",a.excess_hours AS "ساعت مازاد حضور",a.leave_used_percent AS "درصد مرخصی استفاده شده",a.leave_balance AS "مانده مرخصی",a.health_card_status AS "کارت بهداشت",a.medical_docs_pending AS "مدارک درمانی تحویل نشده",a.insurance_status AS "وضعیت بیمه",a.no_shift_staff AS "پرسنل بدون شیفت" FROM attendance_records a LEFT JOIN employees e ON e.organization_id=a.organization_id AND e.personnel_code=a.personnel_code LEFT JOIN stores s ON s.organization_id=e.organization_id AND s.store_code=e.store_code WHERE a.organization_id=$1${period?' AND a.period=$2':''} ORDER BY a.id DESC`,params)).rows;const metrics=(await q(`SELECT * FROM store_metrics WHERE organization_id=$1${period?' AND period=$2':''} ORDER BY store_code`,params)).rows;const supervisors=(await q(`SELECT * FROM supervisor_summaries WHERE organization_id=$1${period?' AND period=$2':''} ORDER BY supervisor`,params)).rows;return {org,employees,stores,attendance,metrics,supervisors};}
app.get('/api/hr/export.xlsx',auth,async(req,res)=>{try{const d=await hrExportData(req);const wb=XLSX.utils.book_new();for(const [rows,name] of [[d.employees,'پرسنل'],[d.stores,'فروشگاه‌ها'],[d.attendance,'حضور و غیاب'],[d.metrics,'شاخص فروشگاه'],[d.supervisors,'شاخص سوپروایزر']])XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),name);const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="amnayar-${d.org.code}-hr-v3.4.xlsx"`);res.send(buf)}catch(e){console.error(e);res.status(500).json({error:'خروجی Excel آماده نشد.'})}});
app.get('/api/hr/export.csv',auth,async(req,res)=>{try{const d=await hrExportData(req);const rows=d.attendance;const csv='\ufeff'+XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(rows));res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="amnayar-${d.org.code}-attendance-v3.4.csv"`);res.send(csv)}catch(e){console.error(e);res.status(500).json({error:'خروجی CSV آماده نشد.'})}});

app.get('/api/owner/organizations',auth,owner,async(req,res)=>{const r=await q(`SELECT o.id,o.name,o.code,COUNT(m.id)::int hr_count FROM organizations o LEFT JOIN organization_members m ON m.organization_id=o.id AND m.member_role='hr' GROUP BY o.id ORDER BY o.id DESC`);res.json({organizations:r.rows})});
app.post('/api/owner/organizations',auth,owner,async(req,res)=>{try{const name=String(req.body.name||'').trim(),code=String(req.body.code||'').trim().toUpperCase(),email=normalizeEmail(req.body.hr_email);if(!name||!/^[A-Z0-9_-]{3,32}$/.test(code)||!email)return res.status(400).json({error:'نام سازمان، کد سازمان و ایمیل مدیر منابع انسانی را کامل وارد کنید.'});const u=await q('SELECT id FROM users WHERE email=$1',[email]);if(!u.rowCount)return res.status(404).json({error:'ابتدا حساب کاربری مدیر منابع انسانی را با این ایمیل بسازید.'});const org=await q('INSERT INTO organizations(name,code,created_by) VALUES($1,$2,$3) RETURNING *',[name,code,req.user.id]);await q("UPDATE users SET role='hr' WHERE id=$1",[u.rows[0].id]);await q("INSERT INTO organization_members(organization_id,user_id,member_role) VALUES($1,$2,'hr') ON CONFLICT DO NOTHING",[org.rows[0].id,u.rows[0].id]);res.json({ok:true,organization:org.rows[0]})}catch(e){console.error(e);res.status(500).json({error:'ساخت سازمان انجام نشد؛ ممکن است کد سازمان تکراری باشد.'})}});
app.get('/api/owner/stats', auth, owner, async (req, res) => {
  const [users, checks, conversations, messages, active] = await Promise.all([
    q("SELECT COUNT(*)::int count FROM users WHERE role='user'"),
    q('SELECT COUNT(*)::int count FROM checks'),
    q('SELECT COUNT(*)::int count FROM conversations'),
    q('SELECT COUNT(*)::int count FROM messages'),
    q('SELECT COUNT(*)::int count FROM users WHERE is_active=true'),
  ]);
  const orgs = await q('SELECT COUNT(*)::int count FROM organizations');
  const hr = await q("SELECT COUNT(*)::int count FROM users WHERE role='hr'");
  res.json({ users: users.rows[0].count, checks: checks.rows[0].count, organizations: orgs.rows[0].count, hr: hr.rows[0].count, conversations: conversations.rows[0].count, messages: messages.rows[0].count, activeUsers: active.rows[0].count });
});
app.get('/api/owner/users', auth, owner, async (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const role = String(req.query.role || '').trim();
  const params=[]; const where=[];
  if(search){ params.push(`%${search}%`); where.push(`(LOWER(email) LIKE $${params.length} OR LOWER(username) LIKE $${params.length})`); }
  if(['user','hr','owner'].includes(role)){ params.push(role); where.push(`role=$${params.length}`); }
  const r=await q(`SELECT id,email,username,role,is_active,email_verified,created_at FROM users ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY id DESC LIMIT 200`,params);
  res.json({users:r.rows});
});
app.patch('/api/owner/users/:id', auth, owner, async (req, res) => {
  const id=Number(req.params.id);
  if(!Number.isInteger(id) || id<1) return res.status(400).json({error:'شناسه کاربر نامعتبر است.'});
  const current=await q('SELECT id,email,username,role,is_active,email_verified FROM users WHERE id=$1',[id]);
  if(!current.rowCount) return res.status(404).json({error:'کاربر پیدا نشد.'});
  const target=current.rows[0];
  if(target.id===req.user.id && (req.body.role && req.body.role!=='owner' || req.body.is_active===false)) return res.status(400).json({error:'نمی‌توانید دسترسی مالک حساب فعلی خودتان را حذف کنید.'});
  const updates=[]; const params=[];
  if(['user','hr','owner'].includes(req.body.role) && req.body.role!==target.role){params.push(req.body.role);updates.push(`role=$${params.length}`);}
  if(typeof req.body.is_active==='boolean' && req.body.is_active!==target.is_active){params.push(req.body.is_active);updates.push(`is_active=$${params.length}`);}
  if(typeof req.body.email_verified==='boolean' && req.body.email_verified!==target.email_verified){params.push(req.body.email_verified);updates.push(`email_verified=$${params.length}`);}
  if(!updates.length) return res.json({ok:true,user:target});
  params.push(id);
  const r=await q(`UPDATE users SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING id,email,username,role,is_active,email_verified,created_at`,params);
  await ownerAudit(req,'update_user','user',id,{before:target,after:r.rows[0]});
  res.json({ok:true,user:r.rows[0]});
});
app.get('/api/owner/checks', auth, owner, async (req,res)=>{
  const r=await q(`SELECT c.id,u.email,u.username,c.kind,c.result,c.created_at FROM checks c JOIN users u ON u.id=c.user_id ORDER BY c.id DESC LIMIT 200`);
  res.json({checks:r.rows});
});
app.get('/api/owner/audit', auth, owner, async (req,res)=>{
  const r=await q(`SELECT a.id,a.action,a.target_type,a.target_id,a.details,a.created_at,u.username AS owner_username FROM owner_audit_logs a LEFT JOIN users u ON u.id=a.owner_user_id ORDER BY a.id DESC LIMIT 100`);
  res.json({logs:r.rows});
});
app.get('/api/owner/system', auth, owner, async (req,res)=>{
  const started=Date.now();
  const db=await q('SELECT NOW() AS now');
  res.json({ok:true,version:'3.9.0',node:process.version,uptime:Math.round(process.uptime()),db:true,dbLatencyMs:Date.now()-started,serverTime:db.rows[0].now});
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
app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

init().then(() => app.listen(PORT, () => console.log(`AmnaYar running on ${PORT}`))).catch(e => { console.error(e); process.exit(1); });
