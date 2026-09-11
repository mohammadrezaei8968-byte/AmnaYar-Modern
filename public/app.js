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
  {title:'محاسبه‌گر خودرو', desc:'مقایسه قیمت کارخانه و بازار و سود یا زیان', href:'/tools.html?tool=car', tags:'خودرو ماشین قیمت کارخانه بازار سود زیان'},
  {title:'محاسبه‌گر طلا و سکه', desc:'خرید، فروش، اجرت، مالیات و ارزش سکه', href:'/tools.html?tool=gold', tags:'طلا سکه گرم عیار اجرت مالیات خرید فروش'},
  {title:'محاسبه‌گر ارز', desc:'تبدیل ارز و محاسبه سود یا زیان', href:'/tools.html?tool=currency', tags:'ارز دلار یورو درهم لیر پوند تبدیل سود'},
  {title:'محاسبه‌گر رهن و اجاره', desc:'تبدیل تقریبی رهن و اجاره', href:'/tools.html?tool=rent', tags:'رهن اجاره ملک خانه تبدیل'},
  {title:'فاکتور‌ساز فارسی', desc:'ساخت و دریافت فاکتور PDF رایگان', href:'/tools.html?tool=invoice', tags:'فاکتور صورت حساب pdf فروشنده خریدار'},
  {title:'ادغام و جداسازی PDF', desc:'ترکیب PDF یا جداسازی صفحات', href:'/tools.html?tool=pdf', tags:'pdf پی دی اف ادغام جداسازی'},
  {title:'تبدیل تاریخ', desc:'تبدیل شمسی و میلادی', href:'/tools.html?tool=date', tags:'تاریخ شمسی میلادی تبدیل'},
  {title:'محاسبات روزمره', desc:'درصد، تخفیف، قسط، سود و اضافه‌کاری', href:'/tools.html?tool=calculator', tags:'درصد تخفیف قسط سود اضافه کاری'},
  {title:'ابزار متن', desc:'شمارش، پاکسازی و تبدیل اعداد', href:'/tools.html?tool=text', tags:'متن کلمات اعداد فارسی انگلیسی'},
  {title:'ابزار تصویر', desc:'تغییر اندازه، فشرده‌سازی و تبدیل فرمت', href:'/tools.html?tool=image', tags:'تصویر عکس resize compression'},
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


// صحت‌سنجی سریع صفحه اصلی؛ ورودی‌ها فقط داخل مرورگر بررسی می‌شوند.
const homeBankCodes={
 '010':'بانک مرکزی','011':'بانک صنعت و معدن','012':'بانک ملت','013':'بانک رفاه کارگران','014':'بانک مسکن','015':'بانک سپه','016':'بانک کشاورزی','017':'بانک ملی ایران','018':'بانک تجارت','019':'بانک صادرات ایران','020':'بانک توسعه صادرات','021':'پست بانک ایران','022':'بانک توسعه تعاون','051':'بانک توسعه سرمایه','053':'بانک کارآفرین','054':'بانک پارسیان','055':'بانک اقتصاد نوین','056':'بانک سامان','057':'بانک پاسارگاد','058':'بانک سرمایه','059':'بانک سینا','060':'بانک شهر','061':'بانک دی','062':'بانک آینده','063':'بانک انصار','064':'بانک گردشگری','065':'بانک حکمت ایرانیان','066':'بانک ملل','069':'بانک ایران زمین','070':'بانک رسالت','073':'بانک کوثر','075':'بانک مهر ایران','078':'بانک خاورمیانه','080':'بانک نور','090':'بانک مهر اقتصاد','095':'بانک ایران و ونزوئلا'};
const homeCardBanks={'603799':'بانک ملی ایران','589210':'بانک سپه','627648':'بانک توسعه صادرات ایران','627961':'بانک صنعت و معدن','603770':'بانک کشاورزی','628023':'بانک مسکن','627760':'پست بانک ایران','502229':'بانک پاسارگاد','639347':'بانک پاسارگاد','627353':'بانک تجارت','585983':'بانک تجارت','603769':'بانک صادرات ایران','610433':'بانک ملت','627412':'بانک اقتصاد نوین','622106':'بانک پارسیان','639194':'بانک پارسیان','621986':'بانک سامان','639346':'بانک سینا','502938':'بانک دی','504172':'بانک رسالت','505416':'بانک گردشگری','505785':'بانک ایران زمین','502908':'بانک توسعه تعاون','639607':'بانک سرمایه','639217':'بانک کشاورزی','589463':'بانک رفاه کارگران','639599':'بانک قوامین','606373':'بانک مهر ایران'};
let homeCheckKind='national';
const homeCheckConfig={national:{label:'کد ملی',placeholder:'مثلاً ۰۴۹۹۳۷۰۸۹۹',mode:'numeric'},card:{label:'شماره کارت بانکی',placeholder:'مثلاً ۶۰۳۷۹۹۱۲۳۴۵۶۷۸۹۰',mode:'numeric'},iban:{label:'شماره شبا',placeholder:'مثلاً IR۶۲۰۱۷۰۰۰۰۰۰۰۰۰۰۰۰۰۰۰۰۰۰۰',mode:'text'}};
function homeNormalize(v){return String(v||'').replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[\s-]/g,'').toUpperCase()}
function homeLuhn(s){let sum=0,alt=false;for(let i=s.length-1;i>=0;i--){let n=Number(s[i]);if(alt){n*=2;if(n>9)n-=9}sum+=n;alt=!alt}return sum%10===0}
function homeNational(s){if(!/^\d{10}$/.test(s)||/^([0-9])\1{9}$/.test(s))return false;let sum=0;for(let i=0;i<9;i++)sum+=Number(s[i])*(10-i);const r=sum%11;const c=Number(s[9]);return r<2?c===r:c===11-r}
function homeIban(s){if(!/^IR\d{24}$/.test(s))return false;const moved=s.slice(4)+'1827'+s.slice(2,4);let rem=0;for(const ch of moved)rem=(rem*10+Number(ch))%97;return rem===1}
function openHomeCheck(kind,btn){homeCheckKind=kind;document.querySelectorAll('.home-check-card').forEach(x=>x.classList.remove('active'));btn.classList.add('active');const c=homeCheckConfig[kind];const label=document.getElementById('homeCheckLabel');const input=document.getElementById('homeCheckInput');label.firstChild.textContent=c.label;input.placeholder=c.placeholder;input.inputMode=c.mode;input.value='';document.getElementById('homeCheckResult').className='result-box hidden';input.focus()}
function homeResult(ok,title,detail=''){const box=document.getElementById('homeCheckResult');box.className='result-box '+(ok?'success':'danger');box.innerHTML=`<div class="result-icon">${ok?'✓':'!'}</div><div><strong>${title}</strong>${detail?`<p>${detail}</p>`:''}</div>`;box.classList.remove('hidden')}
function submitHomeCheck(e){e.preventDefault();const v=homeNormalize(document.getElementById('homeCheckInput').value);if(!v)return homeResult(false,'مقدار را وارد کنید.');let ok=false,detail='';if(homeCheckKind==='national'){ok=homeNational(v)}else if(homeCheckKind==='card'){ok=/^\d{16}$/.test(v)&&homeLuhn(v);if(ok)detail=`بانک: ${homeCardBanks[v.slice(0,6)]||'بانک از روی شماره کارت شناسایی نشد'}`}else{ok=homeIban(v);if(ok){const code=v.slice(4,7);detail=`بانک: ${homeBankCodes[code]||'بانک از روی شماره شبا شناسایی نشد'}`}}homeResult(ok,ok?'صحیح است':'نامعتبر است',detail)}


// مالک سایت می‌تواند محتوای عمومی و ابزارهای فعال را بدون Deploy تغییر دهد.
async function loadPublicConfig(){
  try{
    const r=await fetch('/api/public-config?ts='+Date.now(),{cache:'no-store'}); if(!r.ok)return; const c=await r.json(); const s=c.settings||{};
    if(s.site_title){ document.title=s.site_title; const brand=document.querySelector('footer .brand span'); if(brand){ const small=brand.querySelector('small'); brand.childNodes[0].textContent=s.site_title.split('|')[0].trim()+' '; if(s.footer_text&&small) small.textContent=s.footer_text; } }
    const desc=document.querySelector('meta[name="description"]'); if(desc&&s.site_description)desc.content=s.site_description;
    const badge=document.querySelector('.hero-copy .pill'); if(badge&&s.hero_badge)badge.textContent=s.hero_badge;
    const h=document.querySelector('.hero-copy h1'); if(h&&s.hero_title){const parts=s.hero_title.split('\n');h.innerHTML=parts.map((x,i)=>i===parts.length-1?`<strong>${x}</strong>`:x).join('<br>')}
    const hp=document.querySelector('.hero-copy > p'); if(hp&&s.hero_text)hp.textContent=s.hero_text;
    const mail=document.querySelector('#support a[href^="mailto:"]'); if(mail&&s.support_email){mail.href='mailto:'+s.support_email;mail.textContent=s.support_email}
    const ig=document.querySelector('#support .support-card a[href*="instagram.com"]'); if(ig&&s.instagram){ig.href=s.instagram}
    const footerSmall=document.querySelector('footer .brand small'); if(footerSmall&&s.footer_text)footerSmall.textContent=s.footer_text;
    applyHomeLayout(s);
    const enabled=new Set((c.tools||[]).filter(x=>x.enabled).map(x=>x.slug));
    document.querySelectorAll('.tool-tile[href*="/tools.html?tool="]').forEach(a=>{const slug=((new URL(a.href,location.origin)).searchParams.get('tool')||''||''); if(c.tools?.length)a.style.display=enabled.has(slug)?'':'none';});
    (c.notices||[]).slice(0,1).forEach(n=>{if(!document.getElementById('publicNotice')){const bar=document.createElement('div');bar.id='publicNotice';bar.className='public-notice '+n.type;bar.innerHTML=`<b>${escapeHtml(n.title)}</b><span>${escapeHtml(n.body)}</span>`;document.body.insertBefore(bar,document.body.firstChild)}});
  }catch(e){}
}
function applyHomeLayout(settings){
  const ids=['popular','quick-check','markets','tools','official','why','topics','support'];
  ids.forEach(id=>{const el=document.getElementById(id); if(!el)return; const key='home_show_'+id.replace(/-/g,'_'); el.style.display=(settings[key]===undefined||settings[key]==='true'||settings[key]===true)?'':'none';});
  const order=String(settings.home_section_order||'popular,quick-check,markets,tools,official,why,topics,support').split(',').map(x=>x.trim()).filter(x=>ids.includes(x));
  const main=document.querySelector('main');
  if(main){order.forEach(id=>{const el=document.getElementById(id); if(el)main.appendChild(el);});}
}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[m]))}
loadPublicConfig();
document.addEventListener('click',e=>{const a=e.target.closest('a[href*="/tools.html?tool="]');if(a){const slug=(new URL(a.href,location.origin)).searchParams.get('tool')||'';fetch('/api/analytics/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug})}).catch(()=>{})}});
