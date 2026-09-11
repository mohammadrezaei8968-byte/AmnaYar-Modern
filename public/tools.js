
async function translateText(direction){const input=direction==='fa-en'?$('#faToEnText'):$('#enToFaText');const result=direction==='fa-en'?$('#faToEnResult'):$('#enToFaResult');const status=direction==='fa-en'?$('#faToEnStatus'):$('#enToFaStatus');const text=input.value.trim();if(!text){status.textContent='متن را وارد کنید.';return}if(text.length>5000){status.textContent='حداکثر ۵۰۰۰ نویسه مجاز است.';return}status.textContent='در حال ترجمه...';result.value='';try{const r=await fetch('/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,direction})});let data={};try{data=await r.json()}catch{}if(!r.ok)throw new Error(data.error||'ترجمه انجام نشد.');result.value=data.translatedText||'';status.textContent='ترجمه آماده است.'}catch(e){status.textContent=e.message||'ترجمه انجام نشد؛ دوباره تلاش کنید.'}}
const $=s=>document.querySelector(s); const fa=n=>n.toLocaleString('fa-IR');
async function mergePDFs(){const files=[...$('#mergeFiles').files];if(!files.length)return $('#mergeStatus').textContent='حداقل یک فایل انتخاب کنید.';$('#mergeStatus').textContent='در حال پردازش...';const out=await PDFLib.PDFDocument.create();for(const f of files){const doc=await PDFLib.PDFDocument.load(await f.arrayBuffer());const pages=await out.copyPages(doc,doc.getPageIndices());pages.forEach(p=>out.addPage(p));}download(await out.save(),'amnayar-merged.pdf','application/pdf');$('#mergeStatus').textContent='فایل ادغام شد.'}
function parsePages(s,max){const set=new Set();for(const part of s.split(',').map(x=>x.trim()).filter(Boolean)){if(part.includes('-')){let[a,b]=part.split('-').map(Number);if(!Number.isFinite(a)||!Number.isFinite(b))continue;a=Math.max(1,Math.min(max,a));b=Math.max(1,Math.min(max,b));if(a>b)[a,b]=[b,a];for(let i=a;i<=b;i++)set.add(i-1)}else{let n=Number(part);if(Number.isInteger(n)&&n>=1&&n<=max)set.add(n-1)}}return [...set].sort((a,b)=>a-b)}
async function splitPDF(){const f=$('#splitFile').files[0],spec=$('#splitPages').value.trim(),s=$('#splitStatus');if(!f)return s.textContent='فایل PDF را انتخاب کنید.';if(!spec)return s.textContent='صفحات را وارد کنید.';s.textContent='در حال جدا کردن صفحات...';try{const doc=await PDFLib.PDFDocument.load(await f.arrayBuffer());const groups=spec.split(';').map(x=>x.trim()).filter(Boolean);const outputs=[];for(let g=0;g<groups.length;g++){const idx=parsePages(g,doc.getPageCount());if(!idx.length)continue;const out=await PDFLib.PDFDocument.create();const pages=await out.copyPages(doc,idx);pages.forEach(p=>out.addPage(p));outputs.push({name:`amnayar-pages-${g+1}.pdf`,bytes:await out.save({useObjectStreams:true})})}if(!outputs.length)throw new Error('هیچ صفحه معتبری پیدا نشد.');if(outputs.length===1){download(outputs[0].bytes,outputs[0].name,'application/pdf');s.textContent='فایل PDF جدا شد.'}else{if(!window.JSZip)throw new Error('کتابخانه فشرده‌سازی آماده نیست.');const zip=new JSZip();outputs.forEach(x=>zip.file(x.name,x.bytes));const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});downloadBlob(blob,'amnayar-pdf-parts.zip');s.textContent=`${fa(outputs.length)} فایل PDF ساخته شد و داخل ZIP قرار گرفت.`}}catch(e){console.error(e);s.textContent='جداسازی PDF انجام نشد؛ فایل یا شماره صفحات را بررسی کنید.'}}
function download(bytes,name,type){const blob=new Blob([bytes],{type});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
function j2g(jy,jm,jd){let jy2=jy-979,jm2=jm-1,jd2=jd-1;let j_day=365*jy2+Math.floor(jy2/33)*8+Math.floor((jy2%33+3)/4);for(let i=0;i<jm2;i++)j_day+=i<6?31:30;j_day+=jd2;let g_day=j_day+79;let gy=1600+400*Math.floor(g_day/146097);g_day%=146097;let leap=true;if(g_day>=36525){g_day--;gy+=100*Math.floor(g_day/36524);g_day%=36524;if(g_day>=365)g_day++;else leap=false}gy+=4*Math.floor(g_day/1461);g_day%=1461;if(g_day>=366){leap=false;g_day--;gy+=Math.floor(g_day/365);g_day%=365}let gd=g_day+1,gm=0;const md=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];while(gd>md[gm])gd-=md[gm++];return[gy,gm+1,gd]}
function g2j(gy,gm,gd){const g_d_m=[0,31,59,90,120,151,181,212,243,273,304,334];let gy2=gy-(gm>2?0:1),days=355666+365*gy2+Math.floor(gy2/4)-Math.floor(gy2/100)+Math.floor((gy2+3)/400)+gd+g_d_m[gm-1];let jy=-1595+33*Math.floor(days/12053);days%=12053;jy+=4*Math.floor(days/1461);days%=1461;if(days>365){jy+=Math.floor((days-1)/365);days=(days-1)%365}let jm=days<186?1+Math.floor(days/31):7+Math.floor((days-186)/30);let jd=1+(days<186?days%31:(days-186)%30);return[jy,jm,jd]}
function parts(s){return s.trim().replaceAll('-','/').split('/').map(Number)}function jalaliToGregorianUI(){const p=parts($('#jdate').value);if(p.length!==3)return $('#jgResult').textContent='تاریخ را به شکل 1405/06/20 وارد کنید.';const r=j2g(...p);$('#jgResult').textContent=`میلادی: ${r.join('/')}  (${r.map(fa).join('/')})`}function gregorianToJalaliUI(){const p=parts($('#gdate').value);if(p.length!==3)return $('#gjResult').textContent='تاریخ را به شکل 2026/09/11 وارد کنید.';const r=g2j(...p);$('#gjResult').textContent=`شمسی: ${r.join('/')}  (${r.map(fa).join('/')})`}
function discountCalc(){const p=+$('#price').value,x=+$('#percent').value;$('#discountResult').textContent=`مبلغ تخفیف: ${fa(Math.round(p*x/100))} — مبلغ نهایی: ${fa(Math.round(p*(1-x/100)))}`}function overtimeCalc(){const h=+$('#hourly').value,x=+$('#hours').value;$('#overtimeResult').textContent=`مبلغ اضافه‌کاری: ${fa(Math.round(h*x))}`}
function textStats(){const t=$('#textInput').value;$('#textResult').textContent=`حروف: ${fa(t.replace(/\s/g,'').length)} — کلمات: ${fa(t.trim()?t.trim().split(/\s+/).length:0)} — کاراکتر: ${fa(t.length)}`}function faDigits(){let t=$('#textInput');t.value=t.value.replace(/[0-9]/g,d=>'۰۱۲۳۴۵۶۷۸۹'[d])}function enDigits(){let t=$('#textInput');t.value=t.value.replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d))}function cleanText(){let t=$('#textInput');t.value=t.value.replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim()}
function b64e(){try{$('#encodeResult').textContent=btoa(unescape(encodeURIComponent($('#encodeInput').value)))}catch(e){$('#encodeResult').textContent=e.message}}function b64d(){try{$('#encodeResult').textContent=decodeURIComponent(escape(atob($('#encodeInput').value)))}catch(e){$('#encodeResult').textContent='Base64 نامعتبر است.'}}function urlE(){$('#encodeResult').textContent=encodeURIComponent($('#encodeInput').value)}function jsonFmt(){try{$('#encodeResult').textContent=JSON.stringify(JSON.parse($('#encodeInput').value),null,2)}catch(e){$('#encodeResult').textContent='JSON نامعتبر است.'}}async function sha256(){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode($('#encodeInput').value));$('#encodeResult').textContent=[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function resizeImage(){const f=$('#imgFile').files[0],w=+$('#imgW').value,h=+$('#imgH').value;if(!f||!w||!h)return $('#imgStatus').textContent='فایل و ابعاد را وارد کنید.';const im=new Image();im.onload=()=>{const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(im,0,0,w,h);c.toBlob(b=>download(b,'amnayar-image.png','image/png'),'image/png');URL.revokeObjectURL(im.src);$('#imgStatus').textContent='تصویر آماده شد.'};im.src=URL.createObjectURL(f)}

function fmtBytes(n){if(!Number.isFinite(n))return '';const u=['بایت','کیلوبایت','مگابایت','گیگابایت'];let i=0;let x=n;while(x>=1024&&i<u.length-1){x/=1024;i++;}return `${x.toLocaleString('fa-IR',{maximumFractionDigits:2})} ${u[i]}`}
function savingsText(a,b){if(!a||!b)return '';const pct=(1-b/a)*100;if(pct<=0)return `حجم اولیه: ${fmtBytes(a)} — حجم خروجی: ${fmtBytes(b)} — این فایل از قبل بهینه است.`;return `حجم اولیه: ${fmtBytes(a)} — حجم جدید: ${fmtBytes(b)} — کاهش: ${pct.toLocaleString('fa-IR',{maximumFractionDigits:1})}%`}
function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1500)}
$('#imageQuality')?.addEventListener('input',e=>$('#imageQualityValue').textContent=e.target.value);

// فشرده‌سازی سمت کاربر: برای تصویر هیچ وابستگی به سرویس Render ندارد.
async function compressImage(){
  const f=$('#compressImageFile').files[0],s=$('#compressImageStatus');
  if(!f)return s.textContent='تصویر را انتخاب کنید.';
  if(f.size>100*1024*1024)return s.textContent='حداکثر حجم تصویر ۱۰۰ مگابایت است.';
  s.textContent='در حال کم‌حجم‌کردن تصویر...';
  try{
    const q=Math.min(0.95,Math.max(0.2,Number($('#imageQuality').value)/100));
    const src=URL.createObjectURL(f),img=new Image();
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=src});
    const maxSide=3000;
    const scale=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.naturalWidth*scale));c.height=Math.max(1,Math.round(img.naturalHeight*scale));
    c.getContext('2d',{alpha:false}).drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(src);
    const blob=await new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('خروجی تصویر ساخته نشد.')),'image/jpeg',q));
    downloadBlob(blob,'amnayar-compressed.jpg');s.textContent=savingsText(f.size,blob.size);
  }catch(e){s.textContent='فشرده‌سازی تصویر انجام نشد؛ فرمت تصویر را بررسی کنید.';}
}

// PDF بدون ارسال فایل به سرور دوباره ذخیره می‌شود و ساختار فایل بهینه می‌شود.
async function compressPDF(){
  const f=$('#compressPdfFile').files[0],s=$('#compressPdfStatus');
  if(!f)return s.textContent='فایل PDF را انتخاب کنید.';
  if(f.size>100*1024*1024)return s.textContent='حداکثر حجم PDF ۱۰۰ مگابایت است.';
  if(!window.pdfjsLib)return s.textContent='کتابخانه PDF هنوز آماده نشده است؛ چند ثانیه بعد دوباره تلاش کنید.';
  s.textContent='در حال فشرده‌سازی PDF در مرورگر...';
  try{
    const level=Number($('#pdfQuality').value||70);
    const pdf=await pdfjsLib.getDocument({data:await f.arrayBuffer()}).promise;
    const out=await PDFLib.PDFDocument.create();
    const scale=level<=40?0.9:level<=60?1.1:level<=75?1.35:1.7;
    const quality=level<=40?0.45:level<=60?0.58:level<=75?0.72:0.86;
    for(let n=1;n<=pdf.numPages;n++){
      const page=await pdf.getPage(n);const vp=page.getViewport({scale});
      const c=document.createElement('canvas');c.width=Math.max(1,Math.round(vp.width));c.height=Math.max(1,Math.round(vp.height));
      const ctx=c.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);
      await page.render({canvasContext:ctx,viewport:vp}).promise;
      const data=await new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('image failed')),'image/jpeg',quality));
      const img=await out.embedJpg(await data.arrayBuffer());const p=out.addPage([vp.width,vp.height]);p.drawImage(img,{x:0,y:0,width:vp.width,height:vp.height});c.width=1;c.height=1;
      s.textContent=`در حال فشرده‌سازی صفحه ${fa(n)} از ${fa(pdf.numPages)}...`;
    }
    const bytes=await out.save({useObjectStreams:true,addDefaultPage:false});const blob=new Blob([bytes],{type:'application/pdf'});downloadBlob(blob,'amnayar-compressed.pdf');s.textContent=savingsText(f.size,blob.size)+` — کیفیت خروجی: ${fa(level)}٪`;
  }catch(e){console.error(e);s.textContent='فشرده‌سازی PDF انجام نشد؛ ممکن است فایل رمزدار، آسیب‌دیده یا بسیار سنگین باشد.';}
}

// ویدئو در خود مرورگر با MediaRecorder به WebM فشرده می‌شود؛ فایل به سرور ارسال نمی‌شود.
async function compressVideo(){
  const f=$('#compressVideoFile').files[0],s=$('#compressVideoStatus');
  if(!f)return s.textContent='ویدئو را انتخاب کنید.';
  if(f.size>100*1024*1024)return s.textContent='حداکثر حجم ویدئو ۱۰۰ مگابایت است.';
  if(!window.MediaRecorder)return s.textContent='مرورگر شما فشرده‌سازی ویدئو را پشتیبانی نمی‌کند؛ لطفاً Chrome یا Edge را امتحان کنید.';
  s.textContent='در حال کم‌حجم‌کردن ویدئو در مرورگر...';
  const url=URL.createObjectURL(f),video=document.createElement('video');video.src=url;video.muted=false;video.volume=0;video.playsInline=true;video.preload='metadata';
  try{
    await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=reject});
    const q=$('#videoQuality').value;const maxW=q==='small'?960:1280;const scale=Math.min(1,maxW/video.videoWidth);const w=Math.max(2,Math.round(video.videoWidth*scale/2)*2),h=Math.max(2,Math.round(video.videoHeight*scale/2)*2);
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');
    const stream=canvas.captureStream(24);const sourceStream=video.captureStream?.();if(sourceStream){sourceStream.getAudioTracks().forEach(t=>stream.addTrack(t));}const mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':MediaRecorder.isTypeSupported('video/webm;codecs=vp8')?'video/webm;codecs=vp8':'video/webm';
    const bitrate=q==='small'?700000:q==='high'?1800000:1200000;const rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:bitrate});const chunks=[];rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    const done=new Promise((resolve,reject)=>{rec.onstop=()=>resolve();rec.onerror=e=>reject(e.error||e)});let raf=0;
    const draw=()=>{if(video.ended||video.paused)return;ctx.drawImage(video,0,0,w,h);raf=requestAnimationFrame(draw)};
    rec.start(250);await video.play();draw();await new Promise(resolve=>video.onended=resolve);cancelAnimationFrame(raf);rec.stop();await done;stream.getTracks().forEach(t=>t.stop());sourceStream?.getTracks().forEach(t=>t.stop());
    const blob=new Blob(chunks,{type:'video/webm'});downloadBlob(blob,'amnayar-compressed.webm');s.textContent=savingsText(f.size,blob.size)+' — خروجی WebM است.';
  }catch(e){s.textContent='فشرده‌سازی ویدئو انجام نشد؛ Chrome یا Edge را امتحان کنید.';}
  finally{URL.revokeObjectURL(url);}
}
