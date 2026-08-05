/* ── NAV SCROLL ── */
let bannerVisible = true;
window.addEventListener('scroll',()=>{
  const navTop = bannerVisible ? 42 : 0;
  document.getElementById('nav').classList.toggle('solid', window.scrollY > 40);
});

/* ── HAMBURGER ── */
function toggleMob(){
  document.getElementById('mobNav').classList.toggle('open');
}

/* ── PRODUCT FILTER ── */
function filterProd(cat,btn){
  document.querySelectorAll('.prod-tab').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  document.querySelectorAll('.prod-card').forEach(c=>{
    c.style.display=(cat==='all'||c.dataset.cat===cat)?'flex':'none';
  });
}

/* ── WHATSAPP FORM SEND ── */
function sendViaWhatsApp(){
  const n=document.getElementById('fn').value.trim();
  const p=document.getElementById('fp').value.trim();
  if(!n||!p){alert('Please enter your name and phone number.');return;}
  const service=document.getElementById('fs').value||'General Enquiry';
  const budget=document.getElementById('fb').value||'Not specified';
  const location=document.getElementById('fl').value||'Surat';
  const msg=document.getElementById('fm').value||'';
  const wa_msg=`Hi Acme Infotech,\n\n*Name:* ${n}\n*Phone:* ${p}\n*Enquiry For:* ${service}\n*Location:* ${location}\n*Budget:* ${budget}\n*Message:* ${msg||'Please contact me for a quote.'}\n\nSent from acmeinfotechsecuritysystem.com`;
  const encoded=encodeURIComponent(wa_msg);
  window.open(`https://wa.me/918401726096?text=${encoded}`,'_blank');
  document.getElementById('formMsg').style.display='block';
  document.getElementById('formMsg').textContent='✅ Opening WhatsApp with your enquiry details...';
}

/* ── REGULAR FORM SUBMIT (sends a real email via FormSubmit, no backend needed) ── */
function submitForm(){
  const n=document.getElementById('fn').value.trim();
  const p=document.getElementById('fp').value.trim();
  if(!n||!p){alert('Please enter your name and phone number.');return;}
  const e=document.getElementById('fe').value.trim();
  const service=document.getElementById('fs').value||'General Enquiry';
  const budget=document.getElementById('fb').value||'Not specified';
  const location=document.getElementById('fl').value||'Not specified';
  const message=document.getElementById('fm').value||'';
  const msgBox=document.getElementById('formMsg');
  const btn=document.querySelector('.btn-email-send');
  const originalBtnText=btn.textContent;
  btn.textContent='Sending…';
  btn.disabled=true;

  fetch('https://formsubmit.co/ajax/info@acmeinfotechsecuritysystem.com',{
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify({
      Name:n, Phone:p, Email:e||'Not provided',
      'Enquiry For':service, 'Approx Budget':budget, 'Location in Surat':location,
      Message:message||'No message provided',
      _subject:`New Website Enquiry from ${n} (${p})`
    })
  }).then(res=>{
    if(!res.ok) throw new Error('Form service error');
    return res.json();
  }).then(()=>{
    msgBox.style.display='block';
    msgBox.textContent='✅ Enquiry received! We\'ll call you back within 2 hours.';
    ['fn','fp','fe','fm'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('fs').value='';
    document.getElementById('fb').value='';
  }).catch(()=>{
    // If the email service is unreachable, fall back to WhatsApp so the lead is never lost
    msgBox.style.display='block';
    msgBox.textContent='⚠️ Website form is temporarily unavailable — opening WhatsApp instead so we don\'t miss your enquiry.';
    sendViaWhatsApp();
  }).finally(()=>{
    btn.textContent=originalBtnText;
    btn.disabled=false;
  });
}

/* ── WA POPUP WIDGET ── */
let waOpen=false;
setTimeout(()=>{
  if(!waOpen){openWaPopup();}
},6000);

function toggleWaPopup(e){
  e.preventDefault();
  waOpen?closeWaPopup():openWaPopup();
}
function openWaPopup(){
  waOpen=true;
  document.getElementById('waPopup').classList.add('open');
  document.getElementById('waBadge').style.display='none';
}
function closeWaPopup(){
  waOpen=false;
  document.getElementById('waPopup').classList.remove('open');
}
function waQuick(msg){
  const encoded=encodeURIComponent('Hi Acme Infotech,\n\n'+msg+'\n\nPlease send me details and pricing.');
  window.open('https://wa.me/918401726096?text='+encoded,'_blank');
}
function waSendCustom(){
  const inp=document.getElementById('waInp');
  const msg=inp.value.trim();
  if(!msg)return;
  const encoded=encodeURIComponent('Hi Acme Infotech,\n\n'+msg);
  window.open('https://wa.me/918401726096?text='+encoded,'_blank');
  inp.value='';
}
function waKeyPress(e){if(e.key==='Enter')waSendCustom()}

/* ── LIVE SHOP STATUS (Mon–Sat 9AM–8PM IST, driven by real clock, not hardcoded) ── */
function updateShopStatus(){
  const el=document.getElementById('shopStatus');
  if(!el)return;
  const istNow=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}));
  const day=istNow.getDay(); // 0=Sun
  const hour=istNow.getHours();
  const isOpen = day!==0 && hour>=9 && hour<20;
  el.textContent = isOpen ? 'Open Now — Call Us' : 'Closed — Message on WhatsApp';
  el.style.color = isOpen ? '#4ade80' : 'var(--red)';
}
updateShopStatus();
setInterval(updateShopStatus, 60000);

/* ── ARTICLE OPEN (scrolls to and expands the matching accordion) ── */
function openArticle(id){
  const el=document.getElementById('article-'+id);
  if(!el)return;
  el.open=true;
  el.scrollIntoView({behavior:'smooth',block:'center'});
}

/* ── SCROLL REVEAL ── */
const ro=new IntersectionObserver(entries=>{
  entries.forEach(e=>{if(e.isIntersecting)e.target.classList.add('vis')});
},{threshold:0.06});
document.querySelectorAll('.reveal').forEach(el=>ro.observe(el));

/* ── RATING BARS ANIMATE ON SCROLL ── */
const barObs=new IntersectionObserver(entries=>{
  entries.forEach(e=>{
    if(e.isIntersecting){
      document.querySelectorAll('.rb-fill').forEach(bar=>{
        bar.style.width=bar.style.width;
      });
    }
  });
},{threshold:0.2});
const ratingSection=document.querySelector('.review-score-hero');
if(ratingSection)barObs.observe(ratingSection);

/* ── ACTIVE NAV ── */
window.addEventListener('scroll',()=>{
  let cur='';
  document.querySelectorAll('section[id]').forEach(s=>{
    if(window.scrollY>=s.offsetTop-120) cur=s.id;
  });
  document.querySelectorAll('.nav-links a').forEach(a=>{
    const isActive=a.getAttribute('href')==='#'+cur;
    a.style.color=isActive?'#f4f5f0':'';
  });
});