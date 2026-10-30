(() => {
  'use strict';
  const DB_NAME = 'bellomind-local-v1';
  const DB_VERSION = 2;
  const TIMER_KEY = 'bellomind.timer.v1';
  const PREF_KEY = 'bellomind.preferences.v1';
  const $ = (q, root = document) => root.querySelector(q);
  const $$ = (q, root = document) => [...root.querySelectorAll(q)];
  let db;
  const TAB_ID = crypto.randomUUID();
  let timerChannel = null;
  try { if ('BroadcastChannel' in window) timerChannel = new BroadcastChannel('bellomind-local-timer'); } catch {}
  let activeBookId = null;
  let readerLight = false;
  let readerPdfUrl = null;
  let chosenMinutes = 25;
  let ticker;
  let readingTicker;
  let readerTracker = null;
  let timer = loadTimer();

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('This browser does not support local document storage.'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('books')) { const s = d.createObjectStore('books', { keyPath: 'id' }); s.createIndex('addedAt', 'addedAt'); }
        if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('bookmarks')) d.createObjectStore('bookmarks', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('readingSessions')) d.createObjectStore('readingSessions', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open local storage.'));
    });
  }
  function store(name, mode = 'readonly') {
    if (!db) throw new Error('Local storage is not ready.');
    return db.transaction(name, mode).objectStore(name);
  }
  function request(req) { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
  const all = name => request(store(name).getAll());
  const put = (name, value) => request(store(name, 'readwrite').put(value));
  const remove = (name, id) => request(store(name, 'readwrite').delete(id));
  const now = () => Date.now();
  function loadTimer() { try { return JSON.parse(localStorage.getItem(TIMER_KEY)) || freshTimer(); } catch { return freshTimer(); } }
  function freshTimer() { return { id: null, status: 'idle', mode: 'timed', plannedMs: 25 * 60000, startedAt: null, endedAt: null, focusMs: 0, pausedMs: 0, breakMs: 0, focusSegmentAt: null, pauseStartedAt: null, breakSegmentAt: null, breakPausedAt: null, documentId: null, subject: null }; }
  function saveTimer() { try { localStorage.setItem(TIMER_KEY, JSON.stringify(timer));timerChannel?.postMessage({type:'timer-updated',sender:TAB_ID}); } catch { toast('Timer state could not be saved. Check browser storage availability.'); } }
  function getFocusMs(t = timer, at = now()) { return t.focusMs + (t.status === 'focusing' && t.focusSegmentAt ? Math.max(0, at - t.focusSegmentAt) : 0); }
  function getBreakMs(t = timer, at = now()) { return (t.breakCurrentMs || 0) + (t.status === 'break_running' && t.breakSegmentAt ? Math.max(0, at - t.breakSegmentAt) : 0); }
  function getRemaining(t = timer, at = now()) { return Math.max(0, t.plannedMs - getFocusMs(t, at)); }
  function toast(message) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = message; $('#toast-region').append(el); setTimeout(() => el.remove(), 3400); }
  function fmt(ms, seconds = false) { let total = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(total / 3600); total %= 3600; const m = Math.floor(total / 60); const s = total % 60; return h ? `${h}:${String(m).padStart(2, '0')}${seconds ? `:${String(s).padStart(2, '0')}` : ''}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
  function mins(ms) { return Math.floor(Math.max(0, ms) / 60000); }
  function sameDay(a, b) { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); }
  function mondayStart(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }

  function setView(view) {
    const name = ['home', 'library', 'reader', 'focus', 'study', 'progress'].includes(view) ? view : 'home';
    if(name!=='reader')stopReadingTracker();
    $$('.view').forEach(el => el.classList.toggle('active', el.id === `view-${name}`));
    $$('.nav-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === name));
    $('#page-title').textContent = ({ home: 'Overview', library: 'My library', reader: 'Reader', focus: 'Focus mode', study: 'AI study tools', progress: 'Progress' })[name];
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    closeMobileMenu();
    if (name === 'focus') renderTimer();
    if (name === 'library') renderLibrary();
  }
  function route() { setView(location.hash.slice(1) || 'home'); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function prettyDate(ts) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ts)); }

  async function books() { return (await all('books')).sort((a, b) => b.lastOpened - a.lastOpened); }
  async function importFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['pdf', 'txt', 'epub'].includes(ext)) return toast('Choose a PDF, EPUB, or TXT file.');
    if (file.size > 80 * 1024 * 1024) return toast('This file is over the 80 MB local import limit.');
    if (!file.size) return toast('This file is empty. Choose a file with reading content.');
    try {
      const sample = new Uint8Array(await file.slice(0, Math.min(file.size, 8192)).arrayBuffer());
      if (ext === 'pdf' && new TextDecoder().decode(sample.slice(0, 5)) !== '%PDF-') return toast('This file does not have a valid PDF header.');
      if (ext === 'epub' && !(sample[0] === 0x50 && sample[1] === 0x4b)) return toast('This file does not look like an EPUB ZIP archive.');
      if (ext === 'txt' && sample.some((byte, i) => byte === 0 && i < 1024)) return toast('This looks like a binary file, not a plain text document.');
    } catch { return toast('The selected file could not be read. Try choosing it again.'); }
    const id = crypto.randomUUID();
    const entry = { id, title: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, type: ext, size: file.size, blob: file, addedAt: now(), lastOpened: 0, position: 0, notes: [] };
    try { await put('books', entry); toast('Added to your on-device library.'); await refresh(); openBook(id); }
    catch (e) { toast(e.name === 'QuotaExceededError' ? 'Not enough device storage. Free up space and try again.' : `Could not save this file: ${e.message}`); }
  }
  async function openBook(id) {
    await stopReadingTracker();epubUrls.forEach(URL.revokeObjectURL);epubUrls=[];epubBook=null;
    const b = await request(store('books').get(id)); if (!b) return toast('That material is no longer in your library.');
    activeBookId = id; b.lastOpened = now(); await put('books', b); setView('reader');
    $('#reader-empty').classList.add('hidden'); $('#reader-active').classList.remove('hidden'); $('#reader-book-title').textContent = b.title;
    $('#reader-book-meta').textContent = `${b.type.toUpperCase()} · ${formatSize(b.size)} · Stored on this device`;
    const body = $('#reader-body'); body.onscroll=null;if(readerPdfUrl){URL.revokeObjectURL(readerPdfUrl);readerPdfUrl=null;}body.classList.toggle('reading-light', readerLight); body.classList.remove('reader-epub-content');body.replaceChildren();
    $('#reader-chapter-nav').classList.toggle('hidden',b.type!=='epub');$('#pdf-controls').classList.toggle('hidden',b.type!=='pdf');
    try {
      if (b.type === 'txt') {
        const txt = await b.blob.text(); const content = document.createElement('div'); content.textContent = txt; body.append(content);const saved=typeof b.position==='object'?b.position.scrollTop:b.position;body.scrollTop=saved||0;
        body.onscroll = debounce(async () => {const ratio=body.scrollTop/Math.max(1,body.scrollHeight-body.clientHeight);b.position={kind:'txt',scrollTop:body.scrollTop,ratio}; await put('books', b);$('#reader-progress-label').textContent=`${Math.round(ratio*100)}% through · Saved on this device`; }, 400);
        const ratio=typeof b.position==='object'?b.position.ratio:0;$('#reader-progress-label').textContent=`${Math.round((ratio||0)*100)}% through · Saved on this device`;
        await applyHighlights();
      }
      else if (b.type === 'pdf') {
        const frame = document.createElement('iframe'); frame.title = `PDF reader: ${b.title}`;frame.setAttribute('loading','lazy');body.append(frame);let page=typeof b.position==='object'?b.position.page:1,total=typeof b.position==='object'?b.position.total:null;
        let openLink=$('#pdf-open-tab');if(!openLink){openLink=document.createElement('a');openLink.id='pdf-open-tab';openLink.className='button secondary';openLink.target='_blank';openLink.rel='noopener';openLink.textContent='Open PDF in new tab';$('#pdf-controls').append(openLink);}
        $('#pdf-page').value=page||1;$('#pdf-page-count').value=total||'';const updatePdf=async value=>{const selected=Math.max(1,Math.floor(Number(value)||1));$('#pdf-page').value=selected;if(readerPdfUrl)URL.revokeObjectURL(readerPdfUrl);readerPdfUrl=URL.createObjectURL(b.blob);frame.src=`${readerPdfUrl}#page=${selected}&toolbar=1&navpanes=0`;openLink.href=`${readerPdfUrl}#page=${selected}`;b.position={kind:'pdf',page:selected,total:Number($('#pdf-page-count').value)||null};await put('books',b);$('#reader-progress-label').textContent=`Page ${selected}${$('#pdf-page-count').value?` of ${$('#pdf-page-count').value}`:''} · Saved on this device`;};
        readerPdfUrl=URL.createObjectURL(b.blob);frame.src=`${readerPdfUrl}#page=${page||1}&toolbar=1&navpanes=0`;openLink.href=`${readerPdfUrl}#page=${page||1}`;$('#reader-progress-label').textContent=`Page ${page||1}${total?` of ${total}`:''} · Enter the current viewer page to save progress`;
        $('#pdf-page').onchange=()=>updatePdf($('#pdf-page').value);$('#pdf-page-count').onchange=async()=>{b.position={kind:'pdf',page:Number($('#pdf-page').value)||1,total:Number($('#pdf-page-count').value)||null};await put('books',b);};
        $('#pdf-prev').onclick=()=>updatePdf(Math.max(1,(Number($('#pdf-page').value)||1)-1));$('#pdf-next').onclick=()=>updatePdf(Math.min(Number($('#pdf-page-count').value)||100000,(Number($('#pdf-page').value)||1)+1));
      }
      else if(b.type==='epub') {
        epubBook=await loadEpub(b.blob);$('#reader-book-title').textContent=epubBook.title||b.title;const saved=typeof b.position==='object'&&b.position.kind==='epub'?b.position.chapter:0;await renderEpubChapter(saved);
      }
      await renderNotes(); startReadingTracker(b.id);await updateStats();
    } catch(error) { body.textContent=`This file could not be opened. ${error.message}`;toast(error.message); }
  }
  function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
  function formatSize(n) { return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`; }
  function startReadingTracker(bookId){readerTracker={id:crypto.randomUUID(),bookId,startedAt:now(),lastTick:now(),lastActivityAt:now(),activeMs:0};}
  function readingActivity(){if(readerTracker)readerTracker.lastActivityAt=now();}
  async function saveReadingTracker(ended=false){if(!readerTracker||!db)return;try{await put('readingSessions',{id:readerTracker.id,bookId:readerTracker.bookId,startedAt:readerTracker.startedAt,endedAt:ended?now():null,estimatedActiveMs:readerTracker.activeMs,method:'visible-reader-with-recent-activity'});}catch{toast('Reading time could not be saved. Check browser storage.');}}
  async function stopReadingTracker(){if(!readerTracker)return;await saveReadingTracker(true);readerTracker=null;}
  async function tickReadingTracker(){if(!readerTracker)return;const n=now(),delta=Math.max(0,Math.min(10000,n-readerTracker.lastTick));const eligible=!document.hidden&&$('#view-reader').classList.contains('active')&&n-readerTracker.lastActivityAt<5*60*1000;if(eligible)readerTracker.activeMs+=delta;readerTracker.lastTick=n;await saveReadingTracker();}
  let epubBook = null;
  let epubUrls = [];
  function findZipEnd(bytes) {
    const v=new DataView(bytes), min=Math.max(0,bytes.byteLength-65557);
    for(let i=bytes.byteLength-22;i>=min;i--) if(v.getUint32(i,true)===0x06054b50) return i;
    throw new Error('This EPUB is not a readable ZIP archive.');
  }
  function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
  async function readZip(blob) {
    if(blob.size>80*1024*1024)throw new Error('This EPUB exceeds the 80 MB import limit.');
    const bytes=await blob.arrayBuffer(), view=new DataView(bytes), end=findZipEnd(bytes);
    const disk=view.getUint16(end+4,true), cdDisk=view.getUint16(end+6,true), diskCount=view.getUint16(end+8,true), count=view.getUint16(end+10,true), cdSize=view.getUint32(end+12,true), cdOffset=view.getUint32(end+16,true);
    if(disk||cdDisk||diskCount!==count||count===0xffff||cdOffset===0xffffffff||cdSize===0xffffffff)throw new Error('Multi-disk and ZIP64 EPUB archives are not supported.');
    if(count>10000||cdOffset+cdSize>end)throw new Error('The EPUB archive directory is invalid or too large.');
    const entries=new Map(), decoder=new TextDecoder('utf-8',{fatal:false}); let at=cdOffset, expanded=0;
    for(let i=0;i<count;i++){
      if(view.getUint32(at,true)!==0x02014b50)throw new Error('The EPUB archive directory is corrupt.');
      const flags=view.getUint16(at+8,true),method=view.getUint16(at+10,true),crc=view.getUint32(at+16,true),compressed=view.getUint32(at+20,true),size=view.getUint32(at+24,true),nameLen=view.getUint16(at+28,true),extraLen=view.getUint16(at+30,true),commentLen=view.getUint16(at+32,true),localOffset=view.getUint32(at+42,true);
      const name=decoder.decode(new Uint8Array(bytes,at+46,nameLen)).replace(/\\/g,'/');
      if(flags&1)throw new Error('Encrypted EPUB files are not supported.');
      if([compressed,size,localOffset].includes(0xffffffff))throw new Error('ZIP64 EPUB entries are not supported.');
      expanded+=size;if(size>30*1024*1024||expanded>100*1024*1024)throw new Error('This EPUB expands beyond the safe reading limit.');
      if(name.startsWith('/')||name.split('/').includes('..'))throw new Error('The EPUB contains an unsafe file path.');
      if(!name.endsWith('/'))entries.set(name,{name,method,crc,compressed,size,localOffset});
      at+=46+nameLen+extraLen+commentLen;
    }
    const extract=async name=>{
      const entry=entries.get(name);if(!entry)throw new Error(`The EPUB is missing ${name}.`);
      const p=entry.localOffset;if(view.getUint32(p,true)!==0x04034b50)throw new Error('An EPUB file entry is corrupt.');
      const dataAt=p+30+view.getUint16(p+26,true)+view.getUint16(p+28,true);if(dataAt+entry.compressed>bytes.byteLength)throw new Error('An EPUB file entry is truncated.');const compressedBytes=bytes.slice(dataAt,dataAt+entry.compressed);let output;
      if(entry.method===0)output=compressedBytes;
      else if(entry.method===8){if(typeof DecompressionStream==='undefined')throw new Error('This browser cannot unpack EPUB files. Use a current version of Chrome, Edge, or Safari.');try{output=await new Response(new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();}catch{throw new Error('This EPUB uses compression that this browser cannot read.');}}
      else throw new Error(`EPUB compression method ${entry.method} is not supported.`);
      if(output.byteLength!==entry.size||crc32(new Uint8Array(output))!==entry.crc)throw new Error('An EPUB file entry failed its integrity check.');
      return output;
    };
    return {entries,extract};
  }
  function zipPath(baseFile, href) {
    const u=new URL(href,`https://epub.invalid/${baseFile}`);
    if(u.origin!=='https://epub.invalid')throw new Error('The EPUB links to an external file.');
    let path=decodeURIComponent(u.pathname).replace(/^\//,'');
    if(path.split('/').includes('..'))throw new Error('The EPUB contains an unsafe resource path.');
    return path;
  }
  function parseXml(text,label){const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw new Error(`The EPUB ${label} file is invalid XML.`);return doc;}
  async function loadEpub(blob){
    const zip=await readZip(blob), decoder=new TextDecoder('utf-8');
    const container=parseXml(decoder.decode(await zip.extract('META-INF/container.xml')),'container');
    const rootfile=container.getElementsByTagName('rootfile')[0]?.getAttribute('full-path');if(!rootfile)throw new Error('The EPUB has no package document.');
    const opfPath=zipPath('',rootfile), opf=parseXml(decoder.decode(await zip.extract(opfPath)),'package');
    const manifest=new Map();for(const item of [...opf.getElementsByTagName('item')]){const id=item.getAttribute('id'),href=item.getAttribute('href');if(id&&href)manifest.set(id,{...Object.fromEntries([...item.attributes].map(a=>[a.name,a.value])),path:zipPath(opfPath,href)});}
    const spine=[...opf.getElementsByTagName('itemref')].map(item=>manifest.get(item.getAttribute('idref'))).filter(Boolean).filter(item=>/xhtml|html/i.test(item['media-type']||'application/xhtml+xml'));
    if(!spine.length)throw new Error('The EPUB has no readable chapters.');
    const title=opf.getElementsByTagName('dc:title')[0]?.textContent?.trim();
    return {zip,spine,title:title||null,index:0};
  }
  function appendSafeEpubNode(target,source,basePath){
    if(source.nodeType===Node.TEXT_NODE){target.append(document.createTextNode(source.nodeValue||''));return;}
    if(source.nodeType!==Node.ELEMENT_NODE)return;
    const tag=source.localName.toLowerCase();
    if(['script','style','iframe','object','embed','form','input','button','svg','math','video','audio','canvas'].includes(tag))return;
    if(tag==='img'){
      const alt=source.getAttribute('alt')||'';const ref=source.getAttribute('src');
      if(ref&&epubBook){try{const owner=epubBook,chapter=epubBook.index,path=zipPath(basePath,ref),entry=epubBook.zip.entries.get(path);if(entry&&entry.size<=10*1024*1024){epubBook.zip.extract(path).then(data=>{if(epubBook!==owner||epubBook.index!==chapter||!document.body.contains(target))return;const type=entry.name.match(/\.png$/i)?'image/png':entry.name.match(/\.jpe?g$/i)?'image/jpeg':entry.name.match(/\.gif$/i)?'image/gif':entry.name.match(/\.webp$/i)?'image/webp':'';if(!type)return;const img=document.createElement('img');img.src=URL.createObjectURL(new Blob([data],{type}));img.alt=alt;img.loading='lazy';img.className='epub-image';epubUrls.push(img.src);target.append(img);}).catch(()=>{});}}catch{}return;
    }
    }
    const allowed=new Set(['p','div','section','article','header','footer','h1','h2','h3','h4','h5','h6','blockquote','ol','ul','li','em','i','strong','b','sub','sup','br','hr','pre','code','table','thead','tbody','tr','td','th','caption','dl','dt','dd','span','a']);
    const output=allowed.has(tag)?document.createElement(tag==='section'||tag==='article'||tag==='header'||tag==='footer'?'div':tag):document.createDocumentFragment();
    if(tag==='a'){const href=source.getAttribute('href')||'';if(!href.startsWith('#')){const span=document.createElement('span');for(const child of [...source.childNodes])appendSafeEpubNode(span,child,basePath);output.append(span);target.append(output);return;}}
    if(output instanceof HTMLElement&&tag==='a'){output.href='#';output.removeAttribute('href');}
    for(const child of [...source.childNodes])appendSafeEpubNode(output,child,basePath);
    target.append(output);
  }
  async function renderEpubChapter(index){
    if(!epubBook)return;epubBook.index=Math.max(0,Math.min(index,epubBook.spine.length-1));epubUrls.forEach(URL.revokeObjectURL);epubUrls=[];
    const item=epubBook.spine[epubBook.index],xml=parseXml(new TextDecoder('utf-8').decode(await epubBook.zip.extract(item.path)),'chapter'),root=xml.getElementsByTagName('body')[0]||xml.documentElement;
    const body=$('#reader-body');body.replaceChildren();body.classList.add('reader-epub-content');const title=root.querySelector('h1,h2,h3')?.textContent?.trim()||item.id||`Chapter ${epubBook.index+1}`;
    for(const node of [...root.childNodes])appendSafeEpubNode(body,node,item.path);await applyHighlights(epubBook.index);
    $('#chapter-label').textContent=`${epubBook.index+1} of ${epubBook.spine.length} · ${title}`;$('#chapter-prev').disabled=epubBook.index===0;$('#chapter-next').disabled=epubBook.index===epubBook.spine.length-1;
    const b=await request(store('books').get(activeBookId));if(b){b.position={kind:'epub',chapter:epubBook.index};await put('books',b);}
    body.scrollTop=0;$('#reader-progress-label').textContent=`Chapter ${epubBook.index+1} of ${epubBook.spine.length} · Saved on this device`;
  }
  async function deleteBook(id) { const b = await request(store('books').get(id)); if (!b || !confirm(`Remove “${b.title}” from this device?`)) return; await remove('books', id); if (activeBookId === id) { activeBookId = null; if(readerPdfUrl)URL.revokeObjectURL(readerPdfUrl);readerPdfUrl=null;epubUrls.forEach(URL.revokeObjectURL);epubUrls=[];epubBook=null;$('#reader-active').classList.add('hidden'); $('#reader-empty').classList.remove('hidden'); } await refresh(); toast('Removed from this device.'); }
  async function renderLibrary() {
    const list = await books(), q = $('#library-search').value.trim().toLowerCase(), sort = $('#library-sort').value;
    const filtered = list.filter(b => b.title.toLowerCase().includes(q) || b.fileName.toLowerCase().includes(q));
    if (sort === 'title') filtered.sort((a,b) => a.title.localeCompare(b.title)); else if (sort === 'added') filtered.sort((a,b) => b.addedAt-a.addedAt);
    const host = $('#library-list'); host.replaceChildren();
    if (!filtered.length) { host.innerHTML = `<div class="empty-card"><div class="empty-icon">▤</div><div><b>${q ? 'No matching materials' : 'Your library is waiting for a first read'}</b><p>${q ? 'Try another title or search term.' : 'Add PDFs, EPUBs, or text files. They stay stored on this device.'}</p></div>${q ? '' : '<button class="button secondary" data-action="import">Add material</button>'}</div>`; return; }
    for (const b of filtered) { const card = document.createElement('article'); card.className = 'book-card'; card.tabIndex = 0; card.setAttribute('role','button'); card.setAttribute('aria-label',`Open ${b.title}`); card.innerHTML = `<div class="book-card-top"><div class="file-cover ${b.type}">${b.type === 'pdf' ? '▧' : b.type === 'txt' ? '≡' : '▤'}</div><div><h3>${escapeHtml(b.title)}</h3><div class="file-meta">${b.type.toUpperCase()} · ${formatSize(b.size)}</div></div></div><div class="book-progress"><span>${b.lastOpened ? `Last opened ${prettyDate(b.lastOpened)}` : 'Not opened yet'}</span><button type="button" aria-label="Remove ${escapeHtml(b.title)}">•••</button></div>`; card.addEventListener('click', e => { if (e.target.closest('button')) return deleteBook(b.id); openBook(b.id); }); card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBook(b.id); } }); host.append(card); }
  }
  async function renderRecent() {
    const items = (await books()).slice(0, 3), host = $('#recent-list'); host.replaceChildren();
    if (!items.length) { host.innerHTML = `<div class="empty-card"><div class="empty-icon">▤</div><div><b>Your library is ready when you are</b><p>Add a PDF or text file to start building your reading space.</p></div><button class="button secondary" data-action="import">Add your first book</button></div>`; return; }
    for (const b of items) { const row = document.createElement('div'); row.className = 'empty-card'; row.innerHTML = `<div class="empty-icon">${b.type === 'pdf' ? '▧' : '▤'}</div><div><b>${escapeHtml(b.title)}</b><p>${b.lastOpened ? `Opened ${prettyDate(b.lastOpened)}` : 'Ready to read'} · ${b.type.toUpperCase()}</p></div><button class="button secondary">Open</button>`; row.querySelector('button').onclick = () => openBook(b.id); host.append(row); }
  }
  async function renderNotes() {
    const host = $('#reader-notes'); host.replaceChildren(); if (!activeBookId) return;
    const [notes,bookmarks]=await Promise.all([all('notes'),all('bookmarks')]);const mine=notes.filter(n=>n.bookId===activeBookId).sort((a,b)=>b.createdAt-a.createdAt),marks=bookmarks.filter(b=>b.bookId===activeBookId).sort((a,b)=>b.createdAt-a.createdAt);
    if(marks.length){const h=document.createElement('p');h.className='eyebrow';h.textContent='BOOKMARKS';host.append(h);marks.forEach(mark=>{const row=document.createElement('div');row.className='annotation-item';const txt=document.createElement('span');txt.textContent=mark.label||locationLabel(mark.location);const meta=document.createElement('small');meta.textContent=new Date(mark.createdAt).toLocaleString();const go=document.createElement('button');go.textContent='Go to';go.onclick=()=>jumpToLocation(mark.location);row.append(txt,meta,go);host.append(row);});}
    if(mine.length){const h=document.createElement('p');h.className='eyebrow';h.textContent='NOTES & HIGHLIGHTS';host.append(h);mine.forEach(n=>{const row=document.createElement('div');row.className='annotation-item';const txt=document.createElement('span');txt.textContent=n.type==='highlight'?`“${n.text}”`:n.text;const meta=document.createElement('small');meta.textContent=`${n.type==='highlight'?'Highlight':'Note'} · ${locationLabel(n.location)} · ${new Date(n.createdAt).toLocaleDateString()}`;const del=document.createElement('button');del.textContent='Remove';del.setAttribute('aria-label',`Remove ${n.type||'note'}`);del.onclick=async()=>{await remove('notes',n.id);await renderNotes();await applyHighlights(epubBook?.index);};row.append(txt,meta,del);host.append(row);});}
  }
  function locationLabel(location){if(!location)return 'Reading position';if(location.kind==='pdf')return `Page ${location.page}`;if(location.kind==='epub')return `Chapter ${location.chapter+1}`;if(location.kind==='txt')return `Text position ${Math.round((location.ratio||0)*100)}%`;return 'Reading position';}
  async function currentLocation(){const b=await request(store('books').get(activeBookId));return b?.position&&typeof b.position==='object'?{...b.position}:{kind:b?.type==='pdf'?'pdf':'txt',page:1,scrollTop:0};}
  async function addBookmark(){if(!activeBookId)return;try{const location=await currentLocation();await put('bookmarks',{id:crypto.randomUUID(),bookId:activeBookId,location,label:locationLabel(location),createdAt:now()});await renderNotes();toast('Bookmark saved on this device.');}catch{toast('Could not save this bookmark. Check browser storage.');}}
  async function addNote(){if(!activeBookId)return;const text=prompt('Write a note for this material:');if(!text||!text.trim())return;try{await put('notes',{id:crypto.randomUUID(),bookId:activeBookId,text:text.trim(),location:await currentLocation(),type:'note',createdAt:now()});await renderNotes();toast('Note saved on this device.');}catch{toast('Could not save the note. Check browser storage.');}}
  async function addHighlight(){if(!activeBookId)return;const b=await request(store('books').get(activeBookId));if(b?.type==='pdf')return toast('Text selection is not available in the browser PDF viewer. You can bookmark a page or add a note instead.');const selection=window.getSelection(),text=selection?.toString().trim();if(!text)return toast('Select some text in the reader first.');if(text.length>4000)return toast('Select a shorter passage (up to 4,000 characters).');try{const selected=selection.getRangeAt(0),before=document.createRange();before.selectNodeContents($('#reader-body'));before.setEnd(selected.startContainer,selected.startOffset);const location=await currentLocation();location.textOffset=before.toString().length;await put('notes',{id:crypto.randomUUID(),bookId:activeBookId,text,location,type:'highlight',createdAt:now()});await applyHighlights(epubBook?.index);await renderNotes();toast('Highlight saved on this device.');}catch{toast('Could not save the highlight. Check browser storage.');}}
  async function applyHighlights(chapter){if(!activeBookId)return;const root=$('#reader-body');root.querySelectorAll('mark.saved-highlight').forEach(mark=>{const parent=mark.parentNode;while(mark.firstChild)parent.insertBefore(mark.firstChild,mark);mark.remove();});root.normalize();const items=(await all('notes')).filter(n=>n.bookId===activeBookId&&n.type==='highlight'&&(chapter===undefined||n.location?.kind!=='epub'||n.location?.chapter===chapter)).sort((a,b)=>(b.location?.textOffset||0)-(a.location?.textOffset||0));for(const item of items){const quote=item.text;if(!quote)continue;const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];let allText='',node;while((node=walker.nextNode())){nodes.push({node,start:allText.length});allText+=node.nodeValue;}let start=Number(item.location?.textOffset);if(!Number.isFinite(start)||allText.slice(start,start+quote.length)!==quote)start=allText.indexOf(quote);if(start<0)continue;const finish=start+quote.length,point=(offset,isEnd)=>{for(const part of nodes){const end=part.start+part.node.nodeValue.length;if(offset<=end&&(offset>part.start||(!isEnd&&offset===part.start)))return [part.node,Math.max(0,offset-part.start)];}const last=nodes.at(-1);return last?[last.node,last.node.nodeValue.length]:null;};const a=point(start,false),z=point(finish,true);if(!a||!z)continue;try{const range=document.createRange();range.setStart(a[0],a[1]);range.setEnd(z[0],z[1]);const mark=document.createElement('mark');mark.className='saved-highlight';mark.append(range.extractContents());range.insertNode(mark);}catch{}}
  }
  async function jumpToLocation(location){if(!location)return;if(location.kind==='epub'&&epubBook)await renderEpubChapter(location.chapter||0);else if(location.kind==='pdf'){$('#pdf-page').value=location.page||1;$('#pdf-page').dispatchEvent(new Event('change'));}else if(location.kind==='txt'){const body=$('#reader-body');body.scrollTop=location.scrollTop||0;}}

  async function getSessions() { return (await all('sessions')).sort((a,b) => b.startedAt-a.startedAt); }
  async function persistSession(status = timer.status) {
    if (!timer.id) return;
    const record = { id: timer.id, documentId: timer.documentId, subject: timer.subject, startedAt: timer.startedAt, endedAt: timer.endedAt, plannedMs: timer.plannedMs, actualFocusMs: timer.focusMs, pausedMs: timer.pausedMs, breakMs: timer.breakMs, status };
    try { await put('sessions', record); } catch { toast('Session history could not be saved. Check browser storage.'); }
  }
  async function startFocus(mode = 'timed', duration = chosenMinutes) {
    const create=async()=>{
    timer=loadTimer();
    if (['focusing','focus_paused','break_running','break_paused'].includes(timer.status)) { toast('A focus session is already active in this browser profile. Finish it before starting another.');renderTimer();return; }
    timer = freshTimer(); timer.id = crypto.randomUUID(); timer.status = 'focusing'; timer.mode = mode; timer.plannedMs = mode === 'open' ? null : Math.max(1, duration) * 60000; timer.startedAt = now(); timer.focusSegmentAt = timer.startedAt; timer.documentId = activeBookId; timer.subject = activeBookId ? (await request(store('books').get(activeBookId)))?.title || null : null;
    saveTimer(); await persistSession(); renderTimer();
    };
    if(navigator.locks?.request){try{return await navigator.locks.request('bellomind-focus-local-profile',{ifAvailable:true},lock=>lock?create():(toast('Another BelloMind tab is starting a focus session. Try again in a moment.'),undefined));}catch{}}
    const lockKey='bellomind.focus.lock',token=TAB_ID+':'+now();
    try{const previous=JSON.parse(localStorage.getItem(lockKey)||'null');if(previous&&now()-previous.at<10000){toast('Another BelloMind tab is starting a focus session. Try again in a moment.');return;}localStorage.setItem(lockKey,JSON.stringify({token,at:now()}));if(JSON.parse(localStorage.getItem(lockKey)||'{}').token!==token){toast('Another BelloMind tab is starting a focus session. Try again in a moment.');return;}await create();}catch{toast('Could not coordinate a focus session between tabs.');}finally{try{if(JSON.parse(localStorage.getItem(lockKey)||'{}').token===token)localStorage.removeItem(lockKey);}catch{}}
  }
  async function pauseFocus() { if (timer.status !== 'focusing') return; const n=now(); timer.focusMs += Math.max(0,n-timer.focusSegmentAt); timer.focusSegmentAt=null; timer.pauseStartedAt=n; timer.status='focus_paused'; saveTimer(); await persistSession(); renderTimer(); }
  async function resumeFocus() { if (timer.status !== 'focus_paused') return; const n=now(); timer.pausedMs += Math.max(0,n-timer.pauseStartedAt); timer.pauseStartedAt=null; timer.focusSegmentAt=n; timer.status='focusing'; saveTimer(); await persistSession(); renderTimer(); }
  async function startBreak(duration) { if (!['completed','focusing','focus_paused'].includes(timer.status)) return;const prior=timer.status;if (prior === 'focusing') { timer.focusMs += Math.max(0,now()-timer.focusSegmentAt); timer.focusSegmentAt=null; } if (prior === 'focus_paused' && timer.pauseStartedAt) { timer.pausedMs += Math.max(0,now()-timer.pauseStartedAt); timer.pauseStartedAt=null; } timer.breakReturnStatus=prior==='completed'?'completed':'focus_paused';timer.status='break_running'; timer.breakPlannedMs=duration*60000; timer.breakCurrentMs=0; timer.breakSegmentAt=now(); timer.breakMs=timer.breakMs||0; saveTimer(); await persistSession(); $('#break-dialog').close(); renderTimer(); }
  async function pauseBreak() { if (timer.status !== 'break_running') return; const n=now(), elapsed=Math.max(0,n-timer.breakSegmentAt); timer.breakCurrentMs=(timer.breakCurrentMs||0)+elapsed;timer.breakMs+=elapsed; timer.breakSegmentAt=null; timer.breakPausedAt=n; timer.status='break_paused'; saveTimer(); await persistSession(); showBreakRunning(); renderTimer(); }
  async function resumeBreak() { if (timer.status !== 'break_paused') return; const n=now(); if(timer.breakExpired){timer.breakExpired=false;timer.breakPausedAt=null;timer.status=timer.breakReturnStatus||'focus_paused';timer.pauseStartedAt=timer.status==='focus_paused'?n:null;}else{timer.pausedMs+=Math.max(0,n-(timer.breakPausedAt||n));timer.breakPausedAt=null;timer.breakSegmentAt=n;timer.status='break_running';} saveTimer();await persistSession(); $('#break-dialog').close(); renderTimer(); }
  async function endBreak() { if (timer.status==='break_running') {const e=Math.max(0,now()-timer.breakSegmentAt);timer.breakCurrentMs=(timer.breakCurrentMs||0)+e;timer.breakMs+=e;} if (timer.status==='break_paused'&&!timer.breakExpired) timer.pausedMs+=Math.max(0,now()-(timer.breakPausedAt||now())); timer.breakSegmentAt=null;timer.breakPausedAt=null;timer.breakExpired=false;timer.status=timer.breakReturnStatus||'focus_paused';timer.pauseStartedAt=timer.status==='focus_paused'?now():null;saveTimer();await persistSession();$('#break-dialog').close();renderTimer(); }
  async function extendBreak() { if (timer.status==='break_running') { const e=Math.max(0,now()-timer.breakSegmentAt);timer.breakCurrentMs=(timer.breakCurrentMs||0)+e;timer.breakMs+=e;timer.breakSegmentAt=now(); } timer.breakPlannedMs=(timer.breakPlannedMs||0)+5*60000; if(timer.status==='break_paused'){if(timer.breakExpired){timer.breakExpired=false;timer.breakCurrentMs=0;}timer.status='break_running';timer.breakSegmentAt=now();timer.breakPausedAt=null;} saveTimer();await persistSession();showBreakRunning();renderTimer(); }
  async function finishSession(status='ended_early') {
    if (!timer.id) return;
    const n=now(); if(timer.status==='focusing') timer.focusMs += Math.max(0,n-timer.focusSegmentAt); if(timer.status==='focus_paused'&&timer.pauseStartedAt) timer.pausedMs+=Math.max(0,n-timer.pauseStartedAt); if(timer.status==='break_running') {const e=Math.max(0,n-timer.breakSegmentAt);timer.breakCurrentMs=(timer.breakCurrentMs||0)+e;timer.breakMs+=e;} if(timer.status==='break_paused'&&timer.breakPausedAt&&!timer.breakExpired)timer.pausedMs+=Math.max(0,n-timer.breakPausedAt);
    timer.status=status;timer.endedAt=n;timer.focusSegmentAt=null;timer.pauseStartedAt=null;timer.breakSegmentAt=null;timer.breakPausedAt=null;saveTimer();await persistSession(status);$('#break-dialog').close();renderTimer();updateStats();
  }
  async function completeFocus() { if (timer.status!=='focusing') return; timer.focusMs += Math.max(0,now()-timer.focusSegmentAt);timer.focusSegmentAt=null;timer.status='completed';timer.endedAt=now();saveTimer();await persistSession('completed');renderTimer();showBreakPrompt(); }
  function showBreakPrompt() { $('#break-title').textContent='You made space to focus.';$('#break-copy').textContent='A break is here if you’d like one. You’re always free to keep reading.';$('#break-options').classList.remove('hidden');$('#break-running-options').classList.add('hidden');if(!$('#break-dialog').open)$('#break-dialog').showModal(); }
  function showBreakRunning() { $('#break-title').textContent='Take the time you need.';$('#break-copy').textContent=timer.breakExpired?'Your break has ended. Resume reading whenever you’re ready, extend it, or finish for now.':`Break in progress · ${fmt(Math.max(0,(timer.breakPlannedMs||0)-getBreakMs()))} remaining` ;$('#break-resume').textContent=timer.breakExpired?(timer.breakReturnStatus==='completed'?'Resume reading':'Resume focus'):'Resume break';$('#break-options').classList.add('hidden');$('#break-running-options').classList.remove('hidden');if(!$('#break-dialog').open)$('#break-dialog').showModal(); }
  function resetTimer() { timer=freshTimer();saveTimer();renderTimer(); }
  function renderTimer() {
    if(!$('#timer-display'))return;
    const status=timer.status, display=$('#timer-display'), progress=$('#timer-progress');
    if(status==='focusing') { const left=timer.mode==='open'?getFocusMs():getRemaining();display.textContent=fmt(left,true);$('#timer-context').textContent=timer.mode==='open'?'OPEN FOCUS SESSION':'FOCUS SESSION';$('#timer-state').textContent=timer.mode==='open'?'Your focus time is adding up.':'You’re doing just fine. Keep going at your pace.';progress.style.width=timer.mode==='open'?'0%':`${Math.min(100,getFocusMs()/timer.plannedMs*100)}%`; }
    else if(status==='focus_paused') { display.textContent=timer.mode==='open'?fmt(timer.focusMs,true):fmt(Math.max(0,timer.plannedMs-timer.focusMs),true);$('#timer-context').textContent='SESSION PAUSED';$('#timer-state').textContent='Your focus is paused. Take your time.';progress.style.width=timer.mode==='open'?'0%':`${Math.min(100,timer.focusMs/timer.plannedMs*100)}%`; }
    else if(status==='break_running'||status==='break_paused') { display.textContent=fmt(Math.max(0,(timer.breakPlannedMs||0)-getBreakMs()),true);$('#timer-context').textContent=status==='break_running'?'BREAK TIME':'BREAK PAUSED';$('#timer-state').textContent=status==='break_running'?'Rest is part of the rhythm.':'Break paused. Resume when you’re ready.';progress.style.width=`${Math.min(100,getBreakMs()/(timer.breakPlannedMs||1)*100)}%`; }
    else if(status==='completed') {display.textContent=fmt(timer.focusMs,true);$('#timer-context').textContent='SESSION COMPLETE';$('#timer-state').textContent='You made good space to focus. Take a breath.';progress.style.width='100%';}
    else if(status==='ended_early') {display.textContent=fmt(timer.focusMs,true);$('#timer-context').textContent='SESSION ENDED';$('#timer-state').textContent='Your session is saved. Every bit of focus counts.';progress.style.width=timer.plannedMs?`${Math.min(100,timer.focusMs/timer.plannedMs*100)}%`:'0%';}
    else {display.textContent=`${String(chosenMinutes).padStart(2,'0')}:00`;$('#timer-context').textContent='READY WHEN YOU ARE';$('#timer-state').textContent='A small, focused start is enough.';progress.style.width='0%';}
    const controls=$('#timer-controls'), picker=$('#duration-picker');picker.classList.toggle('hidden',['focusing','focus_paused','break_running','break_paused'].includes(status));
    controls.replaceChildren();
    if(status==='idle'||status==='completed'||status==='ended_early') { const b=document.createElement('button');b.className='button primary timer-start';b.textContent=status==='idle'?'Start focus':'Start another session';b.onclick=()=>startFocus('timed',chosenMinutes);controls.append(b); const open=document.createElement('button');open.className='button secondary';open.textContent='Start without a timer';open.onclick=()=>startFocus('open');controls.append(open); }
    else if(status==='focusing') { controls.append(button('Pause','secondary',pauseFocus));controls.append(button('End session','secondary',()=>finishSession('ended_early')));if(timer.mode==='timed')controls.append(button('Restart','secondary',()=>{if(confirm('Restart this focus session? Current focus time will be saved as an ended session.'))finishSession('ended_early').then(()=>startFocus('timed',chosenMinutes));})); }
    else if(status==='focus_paused') {controls.append(button('Resume focus','primary',resumeFocus));controls.append(button('Take a break','secondary',()=>showBreakPrompt()));controls.append(button('End session','secondary',()=>finishSession('ended_early')));}
    else if(status==='break_running') {controls.append(button('Pause break','secondary',pauseBreak));controls.append(button('End break','secondary',endBreak));controls.append(button('Finish session','secondary',()=>finishSession('ended_early')));}
    else if(status==='break_paused') {controls.append(button('Resume break','primary',resumeBreak));controls.append(button('Extend 5 min','secondary',extendBreak));controls.append(button('End break','secondary',endBreak));}
    $('#focus-session-label').textContent=['focusing','focus_paused','break_running','break_paused'].includes(status)?({focusing:'In progress',focus_paused:'Paused',break_running:'On a break',break_paused:'Break paused'})[status]:'Not started';
  }
  function button(text,cls,fn){const b=document.createElement('button');b.className=`button ${cls}`;b.textContent=text;b.onclick=fn;return b;}
  async function tick() {
    const n=now();
    if(timer.status==='focusing'&&timer.mode==='timed'&&getRemaining(timer,n)<=0) await completeFocus();
    if(timer.status==='break_running'&&getBreakMs(timer,n)>=(timer.breakPlannedMs||0)){const active=Math.max(0,n-timer.breakSegmentAt);timer.breakCurrentMs=(timer.breakCurrentMs||0)+active;timer.breakMs+=active;timer.breakSegmentAt=null;timer.status='break_paused';timer.breakPausedAt=n;timer.breakExpired=true;saveTimer();await persistSession();renderTimer();showBreakRunning();$('#break-copy').textContent='Your break has ended. Resume whenever you’re ready, extend it, or finish for now.';}
    renderTimer();
  }
  async function refresh() { await Promise.all([renderRecent(),renderLibrary(),updateStats()]); }
  async function updateStats() {
    const [sessions,booksList,readingSessions]=await Promise.all([getSessions(),books(),all('readingSessions')]), today=new Date(), week=mondayStart(today);
    const todayMs=sessions.filter(s=>sameDay(s.startedAt,today)).reduce((x,s)=>x+s.actualFocusMs,0),weekMs=sessions.filter(s=>s.startedAt>=week).reduce((x,s)=>x+s.actualFocusMs,0),completed=sessions.filter(s=>s.status==='completed');
    const readingToday=readingSessions.filter(s=>sameDay(s.startedAt,today)).reduce((sum,s)=>sum+s.estimatedActiveMs,0),t=mins(todayMs),w=mins(weekMs),count=completed.length,avg=count?mins(completed.reduce((x,s)=>x+s.actualFocusMs,0)/count):0;
    $('#stat-today').innerHTML=`${t} <small>min</small>`;$('#stat-reading').innerHTML=`${mins(readingToday)} <small>min</small>`;$('#stat-week').innerHTML=`${w} <small>min</small>`;$('#stat-sessions').textContent=count;$('#stat-library').textContent=booksList.length;$('#library-count').textContent=booksList.length;
    $('#focus-today-aside').textContent=`${t} min`;$('#focus-sessions-aside').textContent=count;$('#progress-today').innerHTML=`${t} <small>min</small>`;$('#progress-week').innerHTML=`${w} <small>min</small>`;$('#progress-count').textContent=count;$('#progress-average').innerHTML=`${avg} <small>min</small>`;
    const hist=$('#focus-history');hist.replaceChildren();sessions.slice(0,3).forEach(s=>{const e=document.createElement('div');e.className='history-mini';e.innerHTML=`<span>${escapeHtml(s.subject||'Focus session')}</span><small>${mins(s.actualFocusMs)} min</small>`;hist.append(e);});if(!sessions.length)hist.innerHTML='<div class="history-mini"><span>No sessions yet</span><small>Start when ready</small></div>';
    const ph=$('#progress-history');ph.replaceChildren();if(!sessions.length)ph.innerHTML='<div class="history-empty">Your focus sessions will appear here once you start.</div>';else{const head=document.createElement('div');head.className='history-row history-head';head.innerHTML='<span>Session</span><span>Date</span><span>Focus time</span><span>Status</span>';ph.append(head);sessions.forEach(s=>{const row=document.createElement('div');row.className='history-row';row.innerHTML=`<span>${escapeHtml(s.subject||'Focus session')}</span><span class="muted">${new Date(s.startedAt).toLocaleDateString()}</span><span>${mins(s.actualFocusMs)} min</span><span class="muted">${s.status==='completed'?'Completed':s.status==='ended_early'?'Ended early':s.status.replace('_',' ')}</span>`;ph.append(row);});}
  }
  function applyTheme(name){document.body.classList.toggle('light',name==='light');try{localStorage.setItem(PREF_KEY,JSON.stringify({theme:name}));}catch{}}
  function closeMobileMenu(){const wasOpen=document.body.classList.contains('mobile-menu-open');document.body.classList.remove('mobile-menu-open');const toggle=$('#mobile-menu-toggle');toggle?.setAttribute('aria-expanded','false');toggle?.setAttribute('aria-label','Open navigation');if(wasOpen&&window.matchMedia('(max-width: 780px)').matches)toggle?.focus();}
  function toggleMobileMenu(force){const open=force??!document.body.classList.contains('mobile-menu-open');document.body.classList.toggle('mobile-menu-open',open);const toggle=$('#mobile-menu-toggle');toggle?.setAttribute('aria-expanded',String(open));toggle?.setAttribute('aria-label',open?'Close navigation':'Open navigation');if(open)$('#mobile-menu-close')?.focus();else toggle?.focus();}
  async function exportData(){const [bs,ss,ns,marks,reads]=await Promise.all([all('books'),all('sessions'),all('notes'),all('bookmarks'),all('readingSessions')]);const data={exportedAt:new Date().toISOString(),books:bs.map(({blob,...b})=>({...b,fileData:'Document binary files are not included. Export originals separately.'})),sessions:ss,readingSessions:reads,bookmarks:marks,notes:ns,timer};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='bellomind-local-data.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast('Local records exported. Document files are not included.');}

  document.addEventListener('click',e=>{
    if(e.target.closest('#mobile-menu-toggle')){toggleMobileMenu();return;}
    if(e.target.closest('#mobile-menu-close')){toggleMobileMenu(false);return;}
    if(e.target.closest('#mobile-nav-scrim')){toggleMobileMenu(false);return;}
    const nav=e.target.closest('[data-view]');if(nav){e.preventDefault();setView(nav.dataset.view);}
    const jump=e.target.closest('[data-view-link]');if(jump){setView(jump.dataset.viewLink);}
    if(e.target.closest('[data-action="import"]'))$('#file-input').click();
    if(e.target.closest('[data-action="browse"]'))setView('library');
    if(e.target.closest('#settings-button'))$('#settings-dialog').showModal();
    if(e.target.closest('[data-close-dialog]'))e.target.closest('dialog').close();
    const d=e.target.closest('[data-minutes]');if(d){chosenMinutes=Number(d.dataset.minutes);$$('.duration-option').forEach(x=>x.classList.toggle('active',x===d));renderTimer();}
    const br=e.target.closest('[data-break]');if(br)startBreak(Number(br.dataset.break));
    const tc=e.target.closest('[data-theme-choice]');if(tc)applyTheme(tc.dataset.themeChoice);
  });
  document.addEventListener('keydown',e=>{if(!document.body.classList.contains('mobile-menu-open'))return;if(e.key==='Escape'){toggleMobileMenu(false);return;}if(e.key==='Tab'){const items=$$('#mobile-menu-close, #main-navigation a, #settings-button').filter(el=>el.offsetParent!==null);const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}});
  $('#file-input').addEventListener('change',e=>{const f=e.target.files?.[0];if(f)importFile(f);e.target.value='';});
  $('#library-search').addEventListener('input',renderLibrary);$('#library-sort').addEventListener('change',renderLibrary);
  $('#timer-start').addEventListener('click',()=>startFocus('timed',chosenMinutes));$('#open-ended').addEventListener('click',()=>startFocus('open'));
  $('#custom-minutes').addEventListener('change',e=>{const v=Number(e.target.value);if(v>=1&&v<=600){chosenMinutes=v;$$('.duration-option').forEach(x=>x.classList.remove('active'));renderTimer();}else if(e.target.value)toast('Choose a duration between 1 and 600 minutes.');});
  $('#break-custom-button').addEventListener('click',()=>$('#break-custom-row').classList.toggle('hidden'));
  $('#break-custom').addEventListener('change',e=>{const v=Number(e.target.value);if(v>=1&&v<=120)startBreak(v);else toast('Choose a break between 1 and 120 minutes.');});
  $('#continue-reading').addEventListener('click',()=>{$('#break-dialog').close();if(timer.status==='completed')resetTimer();if(activeBookId)setView('reader');});
  $('#finish-session').addEventListener('click',()=>finishSession('completed'));
  $('#break-resume').addEventListener('click',()=>{if(timer.status==='break_paused')resumeBreak();else endBreak();});
  $('#break-extend').addEventListener('click',extendBreak);$('#break-end').addEventListener('click',endBreak);
  $('#reader-focus').addEventListener('click',()=>setView('focus'));$('#reader-theme').addEventListener('click',()=>{readerLight=!readerLight;$('#reader-body').classList.toggle('reading-light',readerLight);});$('#reader-note').addEventListener('click',addNote);$('#reader-bookmark').addEventListener('click',addBookmark);$('#reader-highlight').addEventListener('click',addHighlight);$('#chapter-prev').addEventListener('click',()=>renderEpubChapter(epubBook.index-1));$('#chapter-next').addEventListener('click',()=>renderEpubChapter(epubBook.index+1));$('#export-data').addEventListener('click',exportData);
  window.addEventListener('hashchange',route);window.addEventListener('focus',tick);document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick();});
  ['pointerdown','wheel','keydown','touchstart'].forEach(type=>document.addEventListener(type,readingActivity,{passive:true}));
  window.addEventListener('pagehide',()=>{stopReadingTracker();});
  window.addEventListener('storage',e=>{if(e.key===TIMER_KEY){timer=loadTimer();renderTimer();updateStats();}});
  timerChannel?.addEventListener('message',e=>{if(e.data?.type==='timer-updated'&&e.data.sender!==TAB_ID){timer=loadTimer();renderTimer();updateStats();}});
  window.addEventListener('online',()=>$('#connection-label').textContent='Online · local workspace');window.addEventListener('offline',()=>$('#connection-label').textContent="You're offline ready");
  async function init(){
    $('#today-label').textContent=new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric'}).format(new Date());
    try{db=await openDb();}catch(e){toast(e.message);}
    try{const p=JSON.parse(localStorage.getItem(PREF_KEY)||'{}');if(p.theme)applyTheme(p.theme);}catch{}
    route();renderTimer();if(db){await refresh();if(timer.status==='focusing'&&timer.mode==='timed'&&getRemaining()<=0)await completeFocus();if(timer.status==='break_running'&&getBreakMs()>=(timer.breakPlannedMs||0))await tick();}
    if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('/sw.js').catch(()=>{});
    ticker=setInterval(tick,500);readingTicker=setInterval(tickReadingTracker,10000);
  }
  init();
})();
