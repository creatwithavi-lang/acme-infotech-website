(function () {
  'use strict';

  const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // must match the server limit
  const RESIZE_ABOVE_BYTES = 1024 * 1024;  // only photos bigger than 1MB are resized
  const MAX_IMAGE_SIDE = 1600;

  function slugify(v) {
    return String(v || '').toLowerCase().trim().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
  }

  function escapeAttr(v) {
    return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  // Accepts watch / share / shorts / embed links and returns the embeddable URL.
  function youtubeEmbedUrl(input) {
    const raw = String(input || '').trim();
    const m = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/.exec(raw);
    return m ? 'https://www.youtube.com/embed/' + m[1] : raw;
  }

  // Big phone/camera photos are resized in the browser before upload (the server accepts up to 3MB per image,
  // and hosting platforms limit the total upload size). If anything goes wrong the original file is used.
  async function shrinkImage(file) {
    try {
      if (!file || file.size <= RESIZE_ABOVE_BYTES || file.type === 'image/gif' || !/^image\//.test(file.type)) return file;
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch (e) {
      return file;
    }
  }

  // Auto-fill the URL slug from the title (until the slug is edited by hand).
  const titleInput = document.getElementById('titleInput');
  const slugInput = document.getElementById('slugInput');
  if (titleInput && slugInput) {
    let touched = Boolean(slugInput.value);
    slugInput.addEventListener('input', () => { touched = true; });
    titleInput.addEventListener('input', () => { if (!touched) slugInput.value = slugify(titleInput.value); });
  }

  const editor = document.getElementById('editor');
  const contentInput = document.getElementById('contentInput');
  const form = document.querySelector('.editor-form');
  if (!editor || !contentInput || !form) return;

  // Toolbar
  document.querySelectorAll('.toolbar button').forEach(btn => btn.addEventListener('click', () => {
    const cmd = btn.dataset.cmd;
    const value = btn.dataset.value;
    const action = btn.dataset.action;
    editor.focus();
    if (cmd) { document.execCommand(cmd, false, value || null); return; }
    if (action === 'link') {
      let url = prompt('Enter link URL');
      if (!url) return;
      url = url.trim();
      if (!/^(https?:|mailto:|tel:|\/|#)/i.test(url)) url = 'https://' + url;
      document.execCommand('createLink', false, url);
    }
    if (action === 'quote') document.execCommand('formatBlock', false, 'blockquote');
    if (action === 'table') {
      document.execCommand('insertHTML', false, '<table><thead><tr><th>Heading</th><th>Heading</th></tr></thead><tbody><tr><td>Value</td><td>Value</td></tr></tbody></table><p></p>');
    }
    if (action === 'youtube') {
      const url = prompt('YouTube video link');
      if (url) {
        document.execCommand('insertHTML', false, '<iframe width="560" height="315" src="' + escapeAttr(youtubeEmbedUrl(url)) + '" title="Video" frameborder="0" allowfullscreen></iframe><p></p>');
      }
    }
    if (action === 'code') {
      const html = prompt('Edit HTML snippet', editor.innerHTML);
      if (html !== null) editor.innerHTML = html;
    }
    if (action === 'image') document.getElementById('editorImageInput').click();
  }));

  // Image inside the article body
  const editorImageInput = document.getElementById('editorImageInput');
  if (editorImageInput) {
    editorImageInput.addEventListener('change', async e => {
      const original = e.target.files[0];
      e.target.value = '';
      if (!original) return;
      try {
        const file = await shrinkImage(original);
        if (file.size > MAX_IMAGE_BYTES) { alert('Image must be smaller than 3MB.'); return; }
        const fd = new FormData();
        fd.append('csrf', document.querySelector('[name=csrf]').value);
        fd.append('image', file);
        const res = await fetch('/admin/upload', { method: 'POST', body: fd });
        let data = {};
        try { data = await res.json(); } catch (err) { /* not JSON */ }
        if (data.url) {
          const alt = prompt('Image alt text for SEO', 'Blog image') || 'Blog image';
          editor.focus();
          document.execCommand('insertHTML', false, '<img src="' + escapeAttr(data.url) + '" alt="' + escapeAttr(alt) + '"><p></p>');
        } else {
          alert(data.error || 'Upload failed (status ' + res.status + '). If the image is large, try a smaller one.');
        }
      } catch (err) {
        alert('Upload failed. Please check your internet connection and try again.');
      }
    });
  }

  // Featured / Open Graph image fields: resize big photos, reject files that are still too large.
  let resizing = 0;
  form.querySelectorAll('input[type=file]').forEach(input => input.addEventListener('change', async () => {
    const original = input.files[0];
    if (!original) return;
    resizing += 1;
    try {
      const file = await shrinkImage(original);
      if (file !== original && window.DataTransfer) {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        alert('Image must be smaller than 3MB. Please choose a smaller image.');
        input.value = '';
      }
    } finally {
      resizing -= 1;
    }
  }));

  // Save: copy the editor content into the hidden field, wait for image resizing, block double-clicks.
  const submitBtn = form.querySelector('button[type=submit]');
  const submitLabel = submitBtn ? submitBtn.textContent : '';
  form.addEventListener('submit', e => {
    if (resizing > 0) {
      e.preventDefault();
      const timer = setInterval(() => { if (!resizing) { clearInterval(timer); form.requestSubmit(); } }, 100);
      return;
    }
    contentInput.value = editor.innerHTML;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving...'; }
  });
  window.addEventListener('pageshow', () => {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitLabel; }
  });
})();
