const $=s=>document.querySelector(s),modal=$('#modal'),content=$('#modalContent');
function closeModal(){modal.classList.add('hidden')}
function openAuth(type='login'){modal.classList.remove('hidden');content.innerHTML=type==='register'?registerForm():loginForm()}
function loginForm(){return `<h2>ورود به امنا یار</h2><p class="muted">با ایمیل یا نام کاربری وارد شوید.</p><form class="form" onsubmit="login(event)"><input id="identifier" placeholder="ایمیل یا نام کاربری" required><input id="password" type="password" placeholder="رمز عبور" required><button class="btn primary full">ورود</button></form><p><button class="link" onclick="openAuth('register')">ساخت حساب</button></p>`}
function registerForm(){return `<h2>ثبت‌نام رایگان</h2><p class="muted">استعلام‌های سایت برای حساب شما رایگان و نامحدود هستند.</p><form class="form" onsubmit="register(event)"><input id="email" type="email" placeholder="ایمیل" required><input id="username" placeholder="نام کاربری یکتا (انگلیسی)" required><input id="password" type="password" placeholder="رمز عبور حداقل ۸ کاراکتر" required><button class="btn primary full">ثبت‌نام رایگان</button></form><p><button class="link" onclick="openAuth('login')">قبلاً حساب دارم</button></p>`}
async function register(e){e.preventDefault();const r=await api('/api/auth/register','POST',{email:$('#email').value,username:$('#username').value,password:$('#password').value});if(r.error)return alert(r.error);location.href='/dashboard.html'}
async function login(e){e.preventDefault();const r=await api('/api/auth/login','POST',{identifier:$('#identifier').value,password:$('#password').value});if(r.error)return alert(r.error);location.href=r.user.role==='owner'?'/owner.html':'/dashboard.html'}
async function api(url,method='GET',body){const r=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return r.json()}
async function startCheck(kind){const me=await api('/api/me');if(me.error){openAuth('login');return}location.href='/dashboard.html?check='+encodeURIComponent(kind)}

async function loadNavUser(){const box=document.getElementById('navActions');if(!box)return;const me=await api('/api/me');if(me.error)return;box.innerHTML=`<span class="user-chip">${me.user.username}</span><a class="btn soft" href="/dashboard.html">داشبورد</a><button class="btn ghost" onclick="logoutNav()">خروج</button>`}
async function logoutNav(){await api('/api/auth/logout','POST');location.reload()}
loadNavUser();

function showMarket(kind){document.querySelectorAll('.market-widget').forEach(x=>x.classList.add('hidden'));const id={gold:'marketGold',currency:'marketCurrency',crypto:'marketCrypto',global:'marketGlobal'}[kind];document.getElementById(id)?.classList.remove('hidden');document.querySelectorAll('.market-tab').forEach((b,i)=>b.classList.toggle('active',['gold','currency','crypto','global'][i]===kind))}
function calcGold(){const w=+document.getElementById('goldWeight')?.value;const k=+document.getElementById('goldKarat')?.value;if(!w)return document.getElementById('goldResult').textContent='وزن را وارد کنید.';document.getElementById('goldResult').innerHTML=`وزن: <b>${w.toLocaleString('fa-IR')}</b> گرم — عیار: <b>${k}</b><br><span class="muted">برای محاسبه ارزش، قیمت لحظه‌ای طلای ۱۸ را از جدول بالا مبنا قرار دهید؛ قیمت خرید/فروش طلافروش ثابت و یکسان نیست.</span>`}


// جستجوی داخلی سایت — بدون ارسال متن جستجو به سرور
const siteSearchItems = [
  {title:'صحت‌سنجی کد ملی', desc:'بررسی رایگان کد ملی', href:'/dashboard.html?check=national', tags:'کد ملی صحت سنجی اعتبارسنجی'},
  {title:'صحت‌سنجی کارت بانکی', desc:'بررسی کارت و شناسایی بانک', href:'/dashboard.html?check=card', tags:'کارت بانکی شماره کارت بانک'},
  {title:'صحت‌سنجی شماره شبا', desc:'بررسی شبا و شناسایی بانک', href:'/dashboard.html?check=iban', tags:'شبا شماره شبا بانک'},
  {title:'استعلام بیمه خودرو', desc:'ورود به سامانه رسمی بیمه مرکزی', href:'#popular', tags:'بیمه خودرو بیمه نامه'},
  {title:'استعلام چک صیادی', desc:'سامانه رسمی بانک مرکزی', href:'#popular', tags:'چک صیادی بانک مرکزی'},
  {title:'رهگیری مرسوله پستی', desc:'پیگیری بسته در سامانه پست', href:'#popular', tags:'پست مرسوله رهگیری کد رهگیری'},
  {title:'پنجره ملی خدمات دولت', desc:'دسترسی به خدمات دولت هوشمند', href:'#popular', tags:'دولت خدمات دولتی'},
  {title:'بازار آنلاین', desc:'قیمت طلا، سکه، ارز و رمزارز', href:'#markets', tags:'بازار قیمت آنلاین طلا سکه دلار یورو ارز رمزارز'},
  {title:'قیمت طلای ۱۸ عیار', desc:'نمایش قیمت بازار و محاسبه طلا', href:'#markets', tags:'طلا ۱۸ عیار قیمت گرم'},
  {title:'قیمت دلار', desc:'نمایش نرخ بازار ارز', href:'#markets', tags:'دلار ارز قیمت'},
  {title:'قیمت یورو', desc:'نمایش نرخ بازار ارز', href:'#markets', tags:'یورو ارز قیمت'},
  {title:'محاسبه‌گر طلا', desc:'محاسبه ارزش تقریبی طلا', href:'#markets', tags:'محاسبه طلا گرم عیار خرید فروش'},
  {title:'ابزارهای رایگان', desc:'مجموعه ابزارهای کاربردی', href:'#tools', tags:'ابزار رایگان'},
  {title:'ادغام و جداسازی PDF', desc:'ترکیب PDF یا جداسازی صفحات', href:'/tools.html#pdf', tags:'pdf پی دی اف ادغام جداسازی'},
  {title:'تبدیل تاریخ', desc:'تبدیل شمسی و میلادی', href:'/tools.html#date', tags:'تاریخ شمسی میلادی تبدیل'},
  {title:'محاسبات روزمره', desc:'درصد، تخفیف، قسط، سود و اضافه‌کاری', href:'/tools.html#calculator', tags:'درصد تخفیف قسط سود اضافه کاری'},
  {title:'ابزار متن', desc:'شمارش، پاکسازی و تبدیل اعداد', href:'/tools.html#text', tags:'متن کلمات اعداد فارسی انگلیسی'},
  {title:'ابزار تصویر', desc:'تغییر اندازه، فشرده‌سازی و تبدیل فرمت', href:'/tools.html#image', tags:'تصویر عکس resize compression'},
  {title:'ابزارهای فنی', desc:'Base64، URL، JSON و SHA-256', href:'/tools.html#encode', tags:'base64 url json sha256'},
  {title:'سامانه‌های رسمی', desc:'دسترسی مستقیم به مراجع رسمی', href:'#official', tags:'سامانه رسمی استعلام'},
  {title:'چرا امنا یار؟', desc:'ویژگی‌ها و رویکرد سایت', href:'#why', tags:'امنا یار رایگان امنیت'}
];
function normalizeSearch(v){return String(v||'').toLowerCase().replace(/[يى]/g,'ی').replace(/[ك]/g,'ک').replace(/[ۀة]/g,'ه').replace(/[‌\s\-_/]+/g,'').trim()}
function setupSiteSearch(){
  const input=document.getElementById('siteSearch'), box=document.getElementById('searchResults');
  if(!input||!box)return;
  const close=()=>box.classList.add('hidden');
  function render(){
    const raw=input.value.trim(), q=normalizeSearch(raw);
    if(!q){box.innerHTML='';close();return;}
    const words=raw.toLowerCase().split(/\s+/).filter(Boolean).map(normalizeSearch);
    const matches=siteSearchItems.map((x,i)=>({x,i,hay:normalizeSearch(x.title+' '+x.desc+' '+x.tags)}))
      .filter(o=>words.every(w=>o.hay.includes(w))).slice(0,7);
    if(!matches.length){box.innerHTML='<div class="search-empty">نتیجه‌ای پیدا نشد. عبارت دیگری را امتحان کنید.</div>';box.classList.remove('hidden');return;}
    box.innerHTML=matches.map(o=>`<a class="search-result" href="${o.x.href}" role="option"><span class="search-result-icon">⌕</span><span><b>${o.x.title}</b><small>${o.x.desc}</small></span><i>↗</i></a>`).join('');
    box.classList.remove('hidden');
  }
  input.addEventListener('input',render);
  input.addEventListener('focus',()=>{if(input.value.trim())render()});
  document.addEventListener('click',e=>{if(!e.target.closest('.site-search'))close()});
  input.addEventListener('keydown',e=>{if(e.key==='Escape'){input.value='';close();input.blur()} if(e.key==='Enter'){const first=box.querySelector('a');if(first){e.preventDefault();location.href=first.href}}});
}
setupSiteSearch();
