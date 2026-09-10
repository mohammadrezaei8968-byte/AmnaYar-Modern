import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import pg from 'pg';
import XLSX from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false } });

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

const q = (text, params=[]) => pool.query(text, params);

async function withTransaction(work){
  const client = await pool.connect();
  try{
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  }catch(err){
    try{ await client.query('ROLLBACK'); }catch{}
    throw err;
  }finally{
    client.release();
  }
}

const rateBuckets = new Map();
function rateLimit({windowMs=60_000,max=20}={}){
  return (req,res,next)=>{
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let b = rateBuckets.get(key);
    if(!b || now-b.start >= windowMs) b={start:now,count:0};
    b.count++;
    rateBuckets.set(key,b);
    if(b.count>max) return res.status(429).json({error:'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.'});
    next();
  };
}

async function init(){
  if(!process.env.DATABASE_URL) console.warn('DATABASE_URL is not set. Configure PostgreSQL before production.');
  await q(`CREATE TABLE IF NOT EXISTS users(
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 2 CHECK (credits >= 0),
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','owner')),
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS password_tokens(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
  )`);
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
  if(process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD){
    const existing = await q('SELECT id FROM users WHERE email=$1',[process.env.OWNER_EMAIL.toLowerCase()]);
    if(!existing.rowCount){
      const hash = await bcrypt.hash(process.env.OWNER_PASSWORD, 12);
      await q('INSERT INTO users(email,username,password_hash,credits,role,email_verified) VALUES($1,$2,$3,$4,$5,$6)',[process.env.OWNER_EMAIL.toLowerCase(),'owner',hash,0,'owner',true]);
    }
  }
}

function sign(user){ return jwt.sign({ id:user.id, role:user.role }, JWT_SECRET, { expiresIn:'7d' }); }
function auth(req,res,next){
  try{
    const token=req.cookies.amnayar_session;
    if(!token) return res.status(401).json({error:'ورود لازم است'});
    req.user=jwt.verify(token,JWT_SECRET); next();
  }catch{return res.status(401).json({error:'نشست منقضی شده است'});}
}
function owner(req,res,next){ if(req.user?.role!=='owner') return res.status(403).json({error:'دسترسی مالک لازم است'}); next(); }
function normalizeEmail(email){ return String(email||'').trim().toLowerCase(); }
function safeUsername(u){ return String(u||'').trim().toLowerCase(); }
function randomToken(){ return crypto.randomBytes(32).toString('hex'); }
function hashToken(t){ return crypto.createHash('sha256').update(t).digest('hex'); }
function emailTransport(){
  if(!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:Number(process.env.SMTP_PORT||587)===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
}
async function sendMail(to,subject,html){
  const tx=emailTransport();
  if(!tx){ console.warn('SMTP not configured. Email would be:',to,subject); return; }
  await tx.sendMail({from:process.env.MAIL_FROM,to,subject,html});
}

app.get('/api/health',(req,res)=>res.json({ok:true,service:'amnayar'}));

app.post('/api/auth/register', rateLimit({windowMs:15*60_000,max:10}), async (req,res)=>{
  try{
    const email=normalizeEmail(req.body.email), username=safeUsername(req.body.username), password=String(req.body.password||'');
    if(!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({error:'ایمیل معتبر وارد کنید'});
    if(!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({error:'نام کاربری باید ۳ تا ۲۴ کاراکتر انگلیسی، عدد یا _ باشد'});
    if(password.length<8) return res.status(400).json({error:'رمز عبور حداقل ۸ کاراکتر باشد'});
    const dup=await q('SELECT email,username FROM users WHERE email=$1 OR username=$2',[email,username]);
    if(dup.rowCount) return res.status(409).json({error:'ایمیل یا نام کاربری قبلاً ثبت شده است'});
    const hash=await bcrypt.hash(password,12);
    const r=await q('INSERT INTO users(email,username,password_hash,credits) VALUES($1,$2,$3,2) RETURNING id,email,username,credits,role',[email,username,hash]);
    const user=r.rows[0];
    res.cookie('amnayar_session',sign(user),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:7*86400000});
    await sendMail(email,'حساب امنا یار ساخته شد',`<div dir="rtl"><h2>خوش آمدید</h2><p>حساب شما با موفقیت ساخته شد و <b>۲ اعتبار رایگان</b> دریافت کردید.</p><p>نام کاربری: <b>${username}</b></p></div>`);
    res.json({user});
  }catch(e){ console.error(e); res.status(500).json({error:'خطای سرور'}); }
});

app.post('/api/auth/login', rateLimit({windowMs:15*60_000,max:20}), async (req,res)=>{
  try{
    const identifier=String(req.body.identifier||'').trim().toLowerCase(), password=String(req.body.password||'');
    const r=await q('SELECT * FROM users WHERE email=$1 OR username=$1',[identifier]);
    if(!r.rowCount || !(await bcrypt.compare(password,r.rows[0].password_hash))) return res.status(401).json({error:'نام کاربری/ایمیل یا رمز عبور نادرست است'});
    const u=r.rows[0]; res.cookie('amnayar_session',sign(u),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:7*86400000});
    res.json({user:{id:u.id,email:u.email,username:u.username,credits:u.credits,role:u.role}});
  }catch(e){console.error(e);res.status(500).json({error:'خطای سرور'});}
});
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('amnayar_session');res.json({ok:true});});
app.get('/api/me',auth,async(req,res)=>{const r=await q('SELECT id,email,username,credits,role,created_at FROM users WHERE id=$1',[req.user.id]);res.json({user:r.rows[0]});});

app.post('/api/auth/forgot',rateLimit({windowMs:15*60_000,max:8}),async(req,res)=>{
  const email=normalizeEmail(req.body.email);
  const generic='اگر این ایمیل در سامانه ثبت شده باشد، راهنمای بازیابی ارسال خواهد شد.';
  try{
    const r=await q('SELECT id,email,username FROM users WHERE email=$1',[email]);
    if(!r.rowCount) return res.json({message:generic});
    const token=randomToken(); await q('DELETE FROM password_tokens WHERE user_id=$1 OR expires_at<NOW()',[r.rows[0].id]);
    await q('INSERT INTO password_tokens(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL \'30 minutes\')',[r.rows[0].id,hashToken(token)]);
    const url=`${process.env.APP_URL||'http://localhost:10000'}/reset.html?token=${token}`;
    await sendMail(email,'بازیابی حساب امنا یار',`<div dir="rtl"><h2>بازیابی حساب</h2><p>برای تنظیم رمز جدید روی لینک زیر بزنید:</p><p><a href="${url}">${url}</a></p><p>این لینک ۳۰ دقیقه معتبر و یک‌بارمصرف است.</p></div>`);
    res.json({message:generic});
  }catch(e){console.error(e);res.json({message:generic});}
});

app.post('/api/auth/reset',async(req,res)=>{
  try{
    const token=String(req.body.token||''), password=String(req.body.password||'');
    if(password.length<8) return res.status(400).json({error:'رمز عبور حداقل ۸ کاراکتر باشد'});
    const r=await q('SELECT * FROM password_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW()',[hashToken(token)]);
    if(!r.rowCount) return res.status(400).json({error:'لینک بازیابی نامعتبر یا منقضی شده است'});
    const hash=await bcrypt.hash(password,12); await q('UPDATE users SET password_hash=$1 WHERE id=$2',[hash,r.rows[0].user_id]); await q('UPDATE password_tokens SET used_at=NOW() WHERE id=$1',[r.rows[0].id]);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'خطای سرور'});}
});

app.post('/api/auth/recover-username',rateLimit({windowMs:15*60_000,max:8}),async(req,res)=>{
  const email=normalizeEmail(req.body.email); const generic='اگر این ایمیل ثبت شده باشد، نام کاربری برای آن ارسال خواهد شد.';
  try{const r=await q('SELECT username FROM users WHERE email=$1',[email]); if(r.rowCount) await sendMail(email,'نام کاربری امنا یار',`<div dir="rtl"><p>نام کاربری شما:</p><h2>${r.rows[0].username}</h2></div>`); res.json({message:generic});}catch(e){res.json({message:generic});}
});

app.get('/api/dashboard',auth,async(req,res)=>{
  const u=(await q('SELECT id,email,username,credits,role,created_at FROM users WHERE id=$1',[req.user.id])).rows[0];
  const checks=(await q('SELECT id,kind,result,created_at FROM checks WHERE user_id=$1 ORDER BY id DESC LIMIT 10',[req.user.id])).rows;
  const orders=(await q('SELECT id,package_name,credits,amount,status,created_at FROM credit_orders WHERE user_id=$1 ORDER BY id DESC LIMIT 10',[req.user.id])).rows;
  res.json({user:u,checks,orders});
});

const PACKAGES=[{name:'شروع',credits:10,amount:100000},{name:'استاندارد',credits:30,amount:250000},{name:'حرفه‌ای',credits:70,amount:500000},{name:'سازمانی',credits:150,amount:950000}];
app.get('/api/packages',(req,res)=>res.json({packages:PACKAGES,cardMasked:(process.env.PAYMENT_CARD||'').replace(/\d(?=\d{4})/g,'*')}));
app.post('/api/orders',auth,async(req,res)=>{const p=PACKAGES.find(x=>x.name===req.body.package);if(!p)return res.status(400).json({error:'بسته نامعتبر'});const r=await q('INSERT INTO credit_orders(user_id,package_name,credits,amount) VALUES($1,$2,$3,$4) RETURNING *',[req.user.id,p.name,p.credits,p.amount]);res.json({order:r.rows[0],paymentCard:process.env.PAYMENT_CARD||''});});
app.post('/api/orders/:id/approve',auth,owner,async(req,res)=>{
  try{
    await withTransaction(async(client)=>{
      const c=await client.query('SELECT * FROM credit_orders WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!c.rowCount){ const e=new Error('NOT_FOUND'); e.code='NOT_FOUND'; throw e; }
      if(c.rows[0].status!=='pending'){ const e=new Error('ALREADY'); e.code='ALREADY'; throw e; }
      await client.query("UPDATE credit_orders SET status='approved',approved_at=NOW() WHERE id=$1",[req.params.id]);
      await client.query('UPDATE users SET credits=credits+$1 WHERE id=$2',[c.rows[0].credits,c.rows[0].user_id]);
    });
    res.json({ok:true});
  }catch(e){
    if(e.code==='NOT_FOUND') return res.status(404).json({error:'سفارش پیدا نشد'});
    if(e.code==='ALREADY') return res.status(400).json({error:'سفارش قبلاً بررسی شده'});
    console.error(e); res.status(500).json({error:'خطای سرور'});
  }
});
app.post('/api/orders/:id/reject',auth,owner,async(req,res)=>{await q('UPDATE credit_orders SET status=\'rejected\' WHERE id=$1 AND status=\'pending\'',[req.params.id]);res.json({ok:true});});

function luhn(s){let sum=0,alt=false;for(let i=s.length-1;i>=0;i--){let n=Number(s[i]);if(alt){n*=2;if(n>9)n-=9;}sum+=n;alt=!alt;}return sum%10===0;}
function iranNational(s){if(!/^\d{10}$/.test(s)||/^([0-9])\1{9}$/.test(s))return false;let sum=0;for(let i=0;i<9;i++)sum+=Number(s[i])*(10-i);let r=sum%11;let c=Number(s[9]);return r<2?c===r:c===11-r;}
function iban(s){s=s.replace(/\s/g,'').toUpperCase();if(!/^IR\d{24}$/.test(s))return false;const moved=s.slice(4)+'1827'+s.slice(2,4);let rem=0;for(const ch of moved){rem=(rem*10+Number(ch))%97;}return rem===1;}
app.post('/api/check',auth,rateLimit({windowMs:60_000,max:30}),async(req,res)=>{
  try{
    const kind=String(req.body.kind), input=String(req.body.input||'').replace(/\s/g,'');
    const rules={card:()=>/^\d{16}$/.test(input)&&luhn(input),national:()=>iranNational(input),iban:()=>iban(input)};
    if(!rules[kind])return res.status(400).json({error:'نوع استعلام نامعتبر'});
    const ok=rules[kind](), result=ok?'معتبر':'نامعتبر';
    const inputHash=crypto.createHash('sha256').update(input).digest('hex');
    let newCredits;
    await withTransaction(async(client)=>{
      const u=await client.query('SELECT credits FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
      if(!u.rowCount){ const e=new Error('USER_NOT_FOUND'); e.code='USER_NOT_FOUND'; throw e; }
      if(u.rows[0].credits<1){ const e=new Error('NO_CREDIT'); e.code='NO_CREDIT'; throw e; }
      const updated=await client.query('UPDATE users SET credits=credits-1 WHERE id=$1 RETURNING credits',[req.user.id]);
      newCredits=updated.rows[0].credits;
      await client.query('INSERT INTO checks(user_id,kind,input_hash,result) VALUES($1,$2,$3,$4)',[req.user.id,kind,inputHash,result]);
    });
    res.json({result,valid:ok,credits:newCredits});
  }catch(e){
    if(e.code==='NO_CREDIT') return res.status(402).json({error:'اعتبار کافی نیست'});
    if(e.code==='USER_NOT_FOUND') return res.status(401).json({error:'حساب کاربری پیدا نشد'});
    console.error(e);res.status(500).json({error:'خطای سرور'});
  }
});
app.get('/api/owner/stats',auth,owner,async(req,res)=>{
  const [users,orders,checks]=await Promise.all([q('SELECT COUNT(*)::int count FROM users WHERE role=\'user\''),q('SELECT COUNT(*)::int count FROM credit_orders'),q('SELECT COUNT(*)::int count FROM checks')]);
  res.json({users:users.rows[0].count,orders:orders.rows[0].count,checks:checks.rows[0].count});
});
app.get('/api/owner/orders',auth,owner,async(req,res)=>{const r=await q(`SELECT o.id,u.email,u.username,o.package_name,o.credits,o.amount,o.status,o.created_at,o.approved_at FROM credit_orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 200`);res.json({orders:r.rows});});
app.get('/api/owner/export.xlsx',auth,owner,async(req,res)=>{const users=(await q('SELECT id,email,username,credits,role,created_at FROM users ORDER BY id DESC')).rows;const orders=(await q('SELECT o.id,u.email,u.username,o.package_name,o.credits,o.amount,o.status,o.created_at,o.approved_at FROM credit_orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC')).rows;const checks=(await q('SELECT c.id,u.email,u.username,c.kind,c.result,c.created_at FROM checks c JOIN users u ON u.id=c.user_id ORDER BY c.id DESC')).rows;const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(users),'Users');XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(orders),'Orders');XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(checks),'Checks');const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="amnayar-report.xlsx"');res.send(buf);});

app.get(/^(?!\/api\/).*/, (req,res)=>{
  res.sendFile(path.join(__dirname,'../public/index.html'));
});

init().then(()=>app.listen(PORT,()=>console.log(`AmnaYar running on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
