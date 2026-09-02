function slugify(v){return String(v||'').toLowerCase().trim().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,90)}
const titleInput=document.getElementById('titleInput');
const slugInput=document.getElementById('slugInput');
if(titleInput&&slugInput){let touched=Boolean(slugInput.value);slugInput.addEventListener('input',()=>touched=true);titleInput.addEventListener('input',()=>{if(!touched)slugInput.value=slugify(titleInput.value)})}
const editor=document.getElementById('editor');
const contentInput=document.getElementById('contentInput');
if(editor&&contentInput){
  document.querySelectorAll('.toolbar button').forEach(btn=>btn.addEventListener('click',async()=>{
    const cmd=btn.dataset.cmd, value=btn.dataset.value, action=btn.dataset.action;
    editor.focus();
    if(cmd){document.execCommand(cmd,false,value||null);return}
    if(action==='link'){const url=prompt('Enter link URL'); if(url)document.execCommand('createLink',false,url)}
    if(action==='quote')document.execCommand('formatBlock',false,'blockquote');
    if(action==='table')document.execCommand('insertHTML',false,'<table><thead><tr><th>Heading</th><th>Heading</th></tr></thead><tbody><tr><td>Value</td><td>Value</td></tr></tbody></table><p></p>');
    if(action==='youtube'){const url=prompt('YouTube embed URL'); if(url)document.execCommand('insertHTML',false,`<iframe width="560" height="315" src="${url.replace(/"/g,'')}" title="Video" frameborder="0" allowfullscreen></iframe><p></p>`)}
    if(action==='code'){const html=prompt('Edit HTML snippet',editor.innerHTML); if(html!==null)editor.innerHTML=html}
    if(action==='image')document.getElementById('editorImageInput').click();
  }));
  document.getElementById('editorImageInput')?.addEventListener('change',async e=>{
    const file=e.target.files[0]; if(!file)return;
    const fd=new FormData(); fd.append('csrf',document.querySelector('[name=csrf]').value); fd.append('image',file);
    const res=await fetch('/admin/upload',{method:'POST',body:fd});
    const data=await res.json();
    if(data.url){const alt=prompt('Image alt text for SEO','Blog image')||'Blog image';document.execCommand('insertHTML',false,`<img src="${data.url}" alt="${alt}"><p></p>`)}else alert(data.error||'Upload failed');
    e.target.value='';
  });
  document.querySelector('.editor-form')?.addEventListener('submit',()=>{contentInput.value=editor.innerHTML});
}
