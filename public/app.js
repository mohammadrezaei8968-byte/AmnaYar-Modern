const $=s=>document.querySelector(s),modal=$('#modal'),content=$('#modalContent');
function closeModal(){modal.classList.add('hidden')}
function openAuth(type='login'){modal.classList.remove('hidden');content.innerHTML=type==='register'?registerForm():loginForm()}
function loginForm(){return `<h2>ورود به امنا یار</h2><p class="muted">با ایمیل یا نام کاربری وارد شوید.</p><form class="form" onsubmit="login(event)"><input id="identifier" placeholder="ایمیل یا نام کاربری" required><input id="password" type="password" placeholder="رمز عبور" required><button class="btn primary full">ورود</button></form><p><button class="link" onclick="openAuth('register')">ساخت حساب</button></p>`}
function registerForm(){return `<h2>ثبت‌نام رایگان</h2><p class="muted">استعلام‌های سایت برای حساب شما رایگان و نامحدود هستند.</p><form class="form" onsubmit="register(event)"><input id="email" type="email" placeholder="ایمیل" required><input id="username" placeholder="نام کاربری یکتا (انگلیسی)" required><input id="password" type="password" placeholder="رمز عبور حداقل ۸ کاراکتر" required><button class="btn primary full">ثبت‌نام رایگان</button></form><p><button class="link" onclick="openAuth('login')">قبلاً حساب دارم</button></p>`}
async function register(e){e.preventDefault();const r=await api('/api/auth/register','POST',{email:$('#email').value,username:$('#username').value,password:$('#password').value});if(r.error)return alert(r.error);location.href='/dashboard.html'}
async function login(e){e.preventDefault();const r=await api('/api/auth/login','POST',{identifier:$('#identifier').value,password:$('#password').value});if(r.error)return alert(r.error);location.href=r.user.role==='owner'?'/owner.html':'/dashboard.html'}
async function api(url,method='GET',body){const r=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return r.json()}
async function startCheck(kind){const me=await api('/api/me');if(me.error){openAuth('login');return}location.href='/dashboard.html?check='+encodeURIComponent(kind)}
async function openAI(){const me=await api('/api/me');if(me.error){openAuth('login');return}location.href='/ai.html'}

async function loadNavUser(){const box=document.getElementById('navActions');if(!box)return;const me=await api('/api/me');if(me.error)return;box.innerHTML=`<span class="user-chip">${me.user.username}</span><a class="btn soft" href="/dashboard.html">داشبورد</a><button class="btn ghost" onclick="logoutNav()">خروج</button>`}
async function logoutNav(){await api('/api/auth/logout','POST');location.reload()}
loadNavUser();
