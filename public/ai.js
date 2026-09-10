let currentId=null,currentImageData='';
function handleKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage(e)}}
function clearImage(){currentImageData='';const input=$('#imageInput');if(input)input.value='';}
let selectedFiles=[];
const $=s=>document.querySelector(s);
async function api(url,opt={}){const r=await fetch(url,opt);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'خطا');return d}
function renderFilePreview(){
  const box=$('#imagePreview'); if(!box)return;
  if(!selectedFiles.length){box.classList.add('hidden');box.innerHTML='';return;}
  box.classList.remove('hidden');
  box.innerHTML=selectedFiles.map((f,i)=>`<div class="file-chip"><span>📎 ${esc(f.name)}</span><button type="button" onclick="removeSelectedFile(${i})">×</button></div>`).join('');
}
function removeSelectedFile(i){selectedFiles.splice(i,1);renderFilePreview();}
function onFilesSelected(files){selectedFiles=[...files].slice(0,10);renderFilePreview();}
async function boot(){try{const me=await api('/api/me');document.getElementById('usernameBadge').textContent=me.user.username;document.getElementById('usernameBadge').classList.remove('hidden');if(me.user.role==='owner')$('#ownerLink').classList.remove('hidden');await loadConversations();}catch{location.href='/';}}
async function loadConversations(){const d=await api('/api/conversations');$('#conversationList').innerHTML=d.conversations.map(c=>`<button class="conv ${c.id==currentId?'active':''}" onclick="openChat(${c.id})">${esc(c.title)}</button>`).join('');if(!currentId){if(d.conversations[0])await openChat(d.conversations[0].id);else await newChat();}}
async function newChat(){const d=await api('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'گفت‌وگوی جدید'})});currentId=d.conversation.id;$('#messages').innerHTML='';showWelcome();$('#chatTitle').textContent='گفت‌وگوی جدید';await loadConversations();}
function scrollToBottom(behavior='auto'){const box=$('#messages');if(!box)return;requestAnimationFrame(()=>{box.scrollTo({top:box.scrollHeight,behavior});});}
function showWelcome(){const w=document.createElement('div');w.className='welcome';w.innerHTML='<img src="/assets/logo-amnayar.png"><h1>سلام 👋 من امنا یار AI هستم.</h1><p>سؤالتان را بنویسید، ایده بخواهید، متن بدهید یا تصویر ارسال کنید.</p>';$('#messages').appendChild(w);scrollToBottom();}
async function openChat(id){currentId=id;const d=await api('/api/conversations/'+id+'/messages');$('#messages').innerHTML='';for(const m of d.messages)addMessage(m.role,m.content);scrollToBottom();const c=(await api('/api/conversations')).conversations.find(x=>x.id==id);$('#chatTitle').textContent=c?.title||'گفت‌وگو';await loadConversations();}
function addMessage(role,text,attachments=[]){const row=document.createElement('div');row.className='message-row '+(role==='assistant'?'ai':role);let html=`<div class="avatar">${role==='user'?'شما':'AI'}</div><div class="message">${esc(text)}`;for(const a of (attachments||[])){if(a.type==='image'&&a.dataUrl)html+=`<div class="attachment-card"><img class="generated-image" src="${a.dataUrl}" alt="${esc(a.name||'تصویر ساخته‌شده')}"><div class="generated-image-actions"><a href="${a.dataUrl}" download="amnayar-generated.png">ذخیره تصویر</a></div></div>`;else if(a.type==='file'&&a.url)html+=`<div class="file-card"><span>📎</span><div><b>${esc(a.name||'فایل آماده')}</b><a href="${a.url}" download>دریافت فایل</a></div></div>`;}html+='</div>';row.innerHTML=html;$('#messages').appendChild(row);scrollToBottom('auto');}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function useSuggestion(t){$('#messageInput').value=t;$('#messageInput').focus();}
async function fileToDataUrl(file){return await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result||''));r.onerror=reject;r.readAsDataURL(file);});}
let localEngine=null;
let localEnginePromise=null;
const LOCAL_MODEL='onnx-community/Qwen2.5-0.5B-Instruct';
const TRANSFORMERS_CDN='https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm';

async function loadLocalEngine(){
  if(localEngine)return localEngine;
  if(localEnginePromise)return localEnginePromise;
  localEnginePromise=(async()=>{
    const hasWebGPU=!!navigator.gpu;
    $('#status').textContent=hasWebGPU
      ? 'در حال آماده‌سازی هوش مصنوعی رایگان…'
      : 'GPU پیدا نشد؛ نسخه CPU رایگان در حال آماده‌سازی است…';
    const transformers=await import(TRANSFORMERS_CDN);
    const device=hasWebGPU?'webgpu':'wasm';
    localEngine=await transformers.pipeline('text-generation',LOCAL_MODEL,{
      device,
      dtype:'q4',
      progress_callback:(p)=>{
        const loaded=Number(p?.loaded||0),total=Number(p?.total||0);
        const pct=total>0?Math.max(0,Math.min(100,Math.round(loaded/total*100))):null;
        if(pct!==null) $('#status').textContent=`در حال آماده‌سازی هوش مصنوعی ${device==='wasm'?'روی CPU':'روی GPU'}… ${pct}%`;
        else if(p?.status==='progress'&&typeof p.progress==='number') $('#status').textContent=`در حال آماده‌سازی هوش مصنوعی… ${Math.round(p.progress)}%`;
      }
    });
    $('#status').textContent=device==='wasm'?'آماده • رایگان • اجرای CPU روی دستگاه شما':'آماده • رایگان • اجرای GPU روی دستگاه شما';
    return localEngine;
  })().catch(e=>{localEnginePromise=null;throw e;});
  return localEnginePromise;
}

async function extractClientText(files){
  const chunks=[];
  for(const f of files){
    if(/\.(txt|md|json|csv|xml|js|ts|py|html|css|sql|java|cpp|c|cs|go|rs|rb|php)$/i.test(f.name)){
      try{const text=await f.text();chunks.push(`\n\n--- ${f.name} ---\n${text.slice(0,30000)}`);}catch{}
    }
  }
  return chunks.join('');
}

async function saveLocalChat(userMessage,answer){
  try{await api('/api/local-chat/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversationId:currentId,userMessage,answer})});}catch(e){console.warn('local chat save failed',e);}
}

async function sendMessage(e){
  e.preventDefault();
  const input=$('#messageInput'),text=input.value.trim();
  if(!text&&!currentImageData&&!selectedFiles.length)return;
  if(!currentId)await newChat();
  const filesForSend=[...selectedFiles];
  const clientText=await extractClientText(filesForSend);
  const prompt=(text||'فایل‌های پیوست را بررسی کن.')+(clientText?`\n\nمحتوای فایل‌های متنی پیوست‌شده:${clientText}`:'');
  addMessage('user',text||`پیوست ${filesForSend.length} فایل`);
  input.value='';$('#status').textContent='در حال آماده‌سازی…';
  const typing=document.createElement('div');typing.className='message-row ai';typing.id='typing';typing.innerHTML='<div class="avatar">AI</div><div class="message">در حال آماده‌سازی هوش مصنوعی روی دستگاه شما…</div>';
  $('#messages').appendChild(typing);scrollToBottom('auto');
  try{
    if(currentImageData || filesForSend.some(f=>f.type.startsWith('image/'))){
      throw new Error('نسخه رایگان روی دستگاه فعلاً تحلیل تصویر را انجام نمی‌دهد. برای متن، کد و فایل‌های متنی می‌توانید از آن استفاده کنید.');
    }
    const engine=await loadLocalEngine();
    $('#typing .message').textContent='در حال فکر کردن…';
    const history=[...$('#messages').querySelectorAll('.message-row')].slice(-12).map(row=>{
      const role=row.classList.contains('user')?'user':'assistant';
      const body=row.querySelector('.message')?.innerText||'';
      return {role,content:body};
    }).filter(x=>x.content);
    const messages=[
      {role:'system',content:'تو «امنا یار AI» هستی. دستیار فارسی، دقیق، صادق و کاربردی باش. اگر چیزی را نمی‌دانی حدس نزن. پاسخ‌ها را روشن و ساختاریافته بده. کاربر را از اینکه مدل روی دستگاه خودش اجرا می‌شود مطلع نکن مگر اینکه درباره زیرساخت بپرسد.'},
      ...history.filter(x=>x.role!=='assistant' || x.content!=='در حال آماده‌سازی هوش مصنوعی روی دستگاه شما…').slice(-10),
      {role:'user',content:prompt}
    ];
    const output=await engine(messages,{max_new_tokens:420,temperature:0.7,do_sample:true});
    const generated=output?.[0]?.generated_text;
    const answer=(Array.isArray(generated)?generated.at(-1)?.content:generated)?.trim()||'پاسخی تولید نشد.';
    $('#typing')?.remove();
    addMessage('assistant',answer);
    await saveLocalChat(text||`پیوست ${filesForSend.length} فایل`,answer);
    await loadConversations();
  }catch(err){
    $('#typing')?.remove();
    console.error(err);
    addMessage('assistant','⚠️ '+(err?.message||'اجرای هوش مصنوعی انجام نشد.'));
  }finally{
    $('#status').textContent=localEngine?'آماده • رایگان • روی دستگاه شما':'آماده';
    clearImage();selectedFiles=[];renderFilePreview();
  }
}
$('#imageInput')?.addEventListener('change',e=>onFilesSelected(e.target.files));
async function logout(){await fetch('/api/auth/logout',{method:'POST'});location.href='/';}
boot();
