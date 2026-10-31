const $=id=>document.getElementById(id);
let parcels=JSON.parse(localStorage.getItem('flrota.parcels')||'[]');
let home=JSON.parse(localStorage.getItem('flrota.home')||'null');
let stream=null, pendingCode='';
function save(){localStorage.setItem('flrota.parcels',JSON.stringify(parcels));render(); if(parcels.length) recalc();}
function render(){
 $('count').textContent=parcels.length;$('pending').textContent=parcels.filter(p=>!p.done).length;$('done').textContent=parcels.filter(p=>p.done).length;
 $('list').innerHTML=parcels.length?parcels.map((p,i)=>`<div class="parcel"><span class="pill">${p.done?'Entregue':'Pendente'}</span><strong>${escapeHtml(p.address)}</strong><small>${escapeHtml(p.code)} · ${p.lat? 'Localizado':'Aguardando localização'}</small><div style="display:flex;gap:7px;margin-top:9px"><button class="secondary" style="padding:7px 10px;font-size:11px" onclick="toggleDone(${i})">${p.done?'Reabrir':'Marcar entregue'}</button><button class="danger" style="padding:7px 10px;font-size:11px" onclick="removeParcel(${i})">Excluir</button></div></div>`).join(''):'<div class="muted">Nenhum pacote cadastrado ainda.</div>';
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
window.toggleDone=i=>{parcels[i].done=!parcels[i].done;save()};
window.removeParcel=i=>{parcels.splice(i,1);save()};
function review(code,address){pendingCode=code;$('reviewCode').value=code;$('reviewAddress').value=address||'';$('reviewDialog').showModal();}
$('cancelReview').onclick=()=>$('reviewDialog').close();
$('confirmReview').onclick=()=>{let code=$('reviewCode').value.trim(),address=$('reviewAddress').value.trim();if(!code||!address){alert('Informe o código e o endereço.');return}if(parcels.some(p=>p.code===code)){alert('Esse código já foi cadastrado.');return}parcels.push({code,address,done:false,created:Date.now()});$('reviewDialog').close();save();};
$('addBtn').onclick=()=>review($('code').value.trim(),$('address').value.trim());
$('manualBtn').onclick=()=>{ $('code').focus();window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'});};
$('clearBtn').onclick=()=>{if(confirm('Apagar todos os pacotes deste aparelho?')){parcels=[];save()}};
$('homeBtn').onclick=()=>{$('homeAddress').value=home?.address||'';$('homeDialog').showModal()};
$('saveHome').onclick=()=>{home={address:$('homeAddress').value.trim(),lat:home?.lat||null,lon:home?.lon||null};localStorage.setItem('flrota.home',JSON.stringify(home));$('homeDialog').close();recalc()};
$('geoBtn').onclick=()=>{if(!navigator.geolocation){alert('Geolocalização não disponível.');return}navigator.geolocation.getCurrentPosition(pos=>{home={address:'Minha localização atual',lat:pos.coords.latitude,lon:pos.coords.longitude};localStorage.setItem('flrota.home',JSON.stringify(home));$('homeDialog').close();recalc()},()=>alert('Não foi possível obter a localização. Verifique a permissão do navegador.'),{enableHighAccuracy:true,timeout:12000})};
async function startCamera(){
 if(!('BarcodeDetector'in window)){alert('Este navegador não oferece leitura nativa de código. Use Digitar pacote nesta versão; vamos integrar leitor compatível na próxima atualização.');return}
 try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});$('video').srcObject=stream;$('cameraWrap').style.display='block';await $('video').play();const detector=new BarcodeDetector({formats:['code_128','ean_13','ean_8','qr_code','itf','upc_a','upc_e']});const scan=async()=>{if(!stream)return;try{const codes=await detector.detect($('video'));if(codes.length){let code=codes[0].rawValue;stopCamera();review(code,'');return}}catch(e){}requestAnimationFrame(scan)};scan()}catch(e){alert('Não foi possível abrir a câmera. Confira a permissão do Chrome.')}
}
function stopCamera(){if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}$('cameraWrap').style.display='none'}
$('scanBtn').onclick=startCamera;$('stopBtn').onclick=stopCamera;
$('ocrBtn').onclick=()=>{$('ocrFile').click()};
$('ocrFile').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;await readLabelOCR(file);e.target.value=''};
async function readLabelOCR(file){
 const status=$('ocrStatus');
 if(!window.Tesseract){alert('O leitor de texto não carregou. Verifique a internet e tente novamente.');return}
 status.textContent='Preparando leitura da etiqueta…';
 try{
  const result=await Tesseract.recognize(file,'por+eng',{logger:m=>{if(m.status==='recognizing text')status.textContent='Lendo etiqueta… '+Math.round((m.progress||0)*100)+'%'}});
  const raw=(result.data.text||'').replace(/\r/g,'');
  const parsed=parseLabelText(raw);
  status.textContent='Leitura concluída. Confira os campos antes de salvar.';
  review(parsed.code||pendingCode,parsed.address||raw.trim());
 }catch(err){console.error(err);status.textContent='Não foi possível ler a imagem.';alert('Não consegui reconhecer o texto. Tente fotografar de frente, com boa luz e a etiqueta inteira visível.')}
}
function parseLabelText(raw){
 const lines=raw.split('\n').map(x=>x.replace(/[|]/g,'I').trim()).filter(Boolean);
 const cepMatch=raw.match(/\b\d{5}[- ]?\d{3}\b/);
 const codeMatches=raw.match(/\b\d{10,16}\b/g)||[];
 const streetLine=lines.find(x=>/\b(rua|r\.?|avenida|av\.?|travessa|estrada|rodovia|alameda|praça|praca)\b/i.test(x));
 const numbered=lines.find(x=>/\b\d{1,5}\b/.test(x)&&x.length>5&&x!==streetLine);
 let address=[streetLine,numbered&&numbered!==streetLine?numbered:null,cepMatch?('CEP '+cepMatch[0]):null].filter(Boolean).join(', ');
 if(!address){const candidates=lines.filter(x=>x.length>8&&!/^(imile|shopee|shein|tiktok|pedido|remetente|destinatario|destinatário|tracking|order)/i.test(x));address=candidates.slice(-5).join(', ')}
 return {code:codeMatches[0]||'',address};
}
async function geocode(address){try{let u='https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q='+encodeURIComponent(address);let r=await fetch(u);let d=await r.json();return d[0]?{lat:+d[0].lat,lon:+d[0].lon}:null}catch(e){return null}}
async function recalc(){
 const pending=parcels.filter(p=>!p.done);if(!pending.length){$('map').textContent='Adicione endereços para montar sua rota.';return}
 $('map').textContent='Localizando endereços e organizando a rota…';
 for(const p of pending){if(!p.lat){let g=await geocode(p.address);if(g){p.lat=g.lat;p.lon=g.lon}}}
 localStorage.setItem('flrota.parcels',JSON.stringify(parcels));
 const located=pending.filter(p=>p.lat&&p.lon);
 if(!located.length){$('map').textContent='Não foi possível localizar os endereços. Confira cidade, rua e CEP.';render();return}
 let start=home?.lat?{lat:home.lat,lon:home.lon}:null;
 if(!start&&home?.address)start=await geocode(home.address);
 if(!start&&navigator.geolocation){start=await new Promise(resolve=>navigator.geolocation.getCurrentPosition(p=>resolve({lat:p.coords.latitude,lon:p.coords.longitude}),()=>resolve(null),{timeout:5000}))}
 if(start){let remaining=[...located],ordered=[],cur=start;while(remaining.length){remaining.sort((a,b)=>dist(cur,a)-dist(cur,b));let next=remaining.shift();ordered.push(next);cur=next}window.flrotaOrder=ordered}
 else window.flrotaOrder=located;
 $('map').innerHTML=`<div style="padding:15px;text-align:left"><b>${located.length} de ${pending.length} endereços localizados</b><p class="muted">Ordem aproximada por proximidade. Para mapa navegável e otimização viária completa, conectaremos um serviço de rotas.</p><ol>${window.flrotaOrder.map(p=>`<li>${escapeHtml(p.address)}</li>`).join('')}</ol></div>`;
 render();
}
function dist(a,b){return Math.hypot((a.lat-b.lat)*Math.cos(a.lat*Math.PI/180),a.lon-b.lon)}
$('routeBtn').onclick=recalc;
$('navBtn').onclick=()=>{let p=(window.flrotaOrder||[]).find(x=>!x.done);if(!p){alert('Nenhum destino localizado pendente.');return}let url=`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.address)}&travelmode=driving`;window.open(url,'_blank')};
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
render();
