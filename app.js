// Lector en voz alta: convierte PDF / EPUB / TXT en audio usando la voz del navegador.
(() => {
  'use strict';

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  const $ = (id) => document.getElementById(id);
  const synth = window.speechSynthesis;

  const els = {
    dropzone: $('dropzone'), dropText: $('dropText'), fileInput: $('fileInput'),
    player: $('player'), reader: $('reader'), bookTitle: $('bookTitle'),
    sectionSelect: $('sectionSelect'), voiceSelect: $('voiceSelect'),
    playBtn: $('playBtn'), stopBtn: $('stopBtn'), prevBtn: $('prevBtn'), nextBtn: $('nextBtn'),
    progress: $('progress'), progressText: $('progressText'),
    rate: $('rate'), rateVal: $('rateVal'), pitch: $('pitch'), pitchVal: $('pitchVal'),
  };

  // Estado
  let sections = [];      // [{ title, chunks: [string] }]
  let offsets = [];       // índice global del primer fragmento de cada sección
  let total = 0;
  let pos = { s: 0, c: 0 };
  let playing = false;
  let token = 0;          // invalida eventos de locuciones canceladas
  let storageKey = null;
  let voices = [];

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
  };

  if (!synth) {
    els.dropText.innerHTML = 'Tu navegador no soporta síntesis de voz. Prueba con Chrome, Edge o Safari.';
    return;
  }

  // ---------- Texto → fragmentos ----------

  const MAX_CHUNK = 220; // Chrome corta locuciones largas; fragmentos cortos son más fiables

  function clean(text) {
    return text
      .replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, '$1$2') // une palabras cortadas con guion al final de línea
      .replace(/\s+/g, ' ')
      .trim();
  }

  function splitLong(sentence) {
    if (sentence.length <= MAX_CHUNK) return [sentence];
    const out = [];
    let rest = sentence;
    while (rest.length > MAX_CHUNK) {
      let cut = -1;
      for (const sep of [';', ':', ',', ' ']) {
        cut = rest.lastIndexOf(sep, MAX_CHUNK);
        if (cut > MAX_CHUNK * 0.4) break;
      }
      if (cut <= 0) cut = MAX_CHUNK;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  function toChunks(text) {
    const t = clean(text);
    if (!t) return [];
    const sentences = t.match(/[^.!?…]+(?:[.!?…]+["'»”’)\]]*|$)\s*/g) || [t];
    return sentences.map((s) => s.trim()).filter(Boolean).flatMap(splitLong);
  }

  // ---------- Lectores de formatos ----------

  async function readPdf(file) {
    if (!window.pdfjsLib) throw new Error('No se pudo cargar el lector de PDF (¿sin conexión?).');
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const out = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      setStatus(`Leyendo página ${p} de ${pdf.numPages}…`);
      const content = await (await pdf.getPage(p)).getTextContent();
      const text = content.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('');
      out.push({ title: `Página ${p}`, text });
    }
    return out;
  }

  async function readEpub(file) {
    if (!window.JSZip) throw new Error('No se pudo cargar el lector de EPUB (¿sin conexión?).');
    const zip = await JSZip.loadAsync(file);
    const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
    const readFile = async (path) => {
      const f = zip.file(path) || zip.file(decodeURIComponent(path));
      return f ? f.async('string') : null;
    };

    const container = xml(await readFile('META-INF/container.xml'));
    const opfPath = container.querySelector('rootfile').getAttribute('full-path');
    const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const opf = xml(await readFile(opfPath));

    const manifest = {};
    opf.querySelectorAll('manifest > item').forEach((it) => {
      manifest[it.getAttribute('id')] = it.getAttribute('href');
    });
    const spine = [...opf.querySelectorAll('spine > itemref')].map((r) => r.getAttribute('idref'));

    const out = [];
    for (let i = 0; i < spine.length; i++) {
      const href = manifest[spine[i]];
      if (!href) continue;
      setStatus(`Leyendo capítulo ${i + 1} de ${spine.length}…`);
      const html = await readFile(resolvePath(baseDir, href.split('#')[0]));
      if (!html) continue;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const body = doc.body;
      if (!body) continue;
      body.querySelectorAll('script, style').forEach((n) => n.remove());

      const blocks = [...body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li')]
        .filter((n) => !n.querySelector('p,li'));
      const text = blocks.length
        ? blocks.map((n) => endSentence(n.textContent)).join('\n')
        : body.textContent;

      const heading = body.querySelector('h1,h2,h3');
      const title = (heading && clean(heading.textContent).slice(0, 60)) || `Capítulo ${out.length + 1}`;
      out.push({ title, text });
    }
    return out;
  }

  // Los títulos y párrafos sin punto final se leerían pegados a la frase siguiente
  function endSentence(text) {
    const t = text.trim();
    return !t || /[.!?…:;"'»”’)\]]$/.test(t) ? t : `${t}.`;
  }

  function resolvePath(base, rel) {
    const parts = (base + rel).split('/');
    const stack = [];
    for (const p of parts) {
      if (p === '..') stack.pop();
      else if (p !== '.' && p !== '') stack.push(p);
    }
    return stack.join('/');
  }

  async function readTxt(file) {
    const text = await file.text();
    const paragraphs = text.split(/\n\s*\n/);
    const out = [];
    let buf = '';
    for (const p of paragraphs) {
      buf += p + '\n\n';
      if (buf.length > 6000) {
        out.push({ title: `Parte ${out.length + 1}`, text: buf });
        buf = '';
      }
    }
    if (buf.trim()) out.push({ title: `Parte ${out.length + 1}`, text: buf });
    return out;
  }

  // ---------- Carga del libro ----------

  function setStatus(msg) { els.dropText.textContent = msg; }

  async function loadFile(file) {
    stop();
    const name = file.name.toLowerCase();
    try {
      setStatus(`Abriendo «${file.name}»…`);
      let raw;
      if (name.endsWith('.pdf')) raw = await readPdf(file);
      else if (name.endsWith('.epub')) raw = await readEpub(file);
      else if (name.endsWith('.txt')) raw = await readTxt(file);
      else throw new Error('Formato no soportado. Usa PDF, EPUB o TXT.');

      sections = raw.map((r) => ({ title: r.title, chunks: toChunks(r.text) }))
        .filter((s) => s.chunks.length);

      if (!sections.length) {
        throw new Error('No se encontró texto. Si el PDF es escaneado (imágenes), necesita OCR primero.');
      }

      offsets = [];
      total = 0;
      for (const s of sections) { offsets.push(total); total += s.chunks.length; }

      storageKey = `lector:${file.name}:${file.size}`;
      const saved = store.get(storageKey);
      pos = saved && sections[saved.s] && saved.c < sections[saved.s].chunks.length ? saved : { s: 0, c: 0 };

      els.bookTitle.textContent = file.name;
      els.sectionSelect.innerHTML = sections
        .map((s, i) => `<option value="${i}">${escapeHtml(s.title)}</option>`).join('');
      els.progress.max = Math.max(total - 1, 0);

      els.player.classList.remove('hidden');
      els.reader.classList.remove('hidden');
      renderSection();
      updateProgress();
      setStatus(`«${file.name}» cargado. Toca para abrir otro libro.`);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`);
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Vista de lectura ----------

  let renderedSection = -1;

  function renderSection() {
    const sec = sections[pos.s];
    els.reader.innerHTML = `<h2>${escapeHtml(sec.title)}</h2>` +
      sec.chunks.map((c, i) => `<span class="chunk" data-i="${i}">${escapeHtml(c)}</span> `).join('');
    els.sectionSelect.value = String(pos.s);
    renderedSection = pos.s;
  }

  function highlight(scroll) {
    if (renderedSection !== pos.s) renderSection();
    els.reader.querySelectorAll('.chunk.current').forEach((n) => n.classList.remove('current'));
    const el = els.reader.querySelector(`.chunk[data-i="${pos.c}"]`);
    if (el) {
      el.classList.add('current');
      if (scroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function updateProgress() {
    const g = offsets[pos.s] + pos.c;
    els.progress.value = g;
    els.progressText.textContent = total ? `${Math.round((g / Math.max(total - 1, 1)) * 100)} %` : '0 %';
    if (storageKey) store.set(storageKey, pos);
  }

  function setGlobal(g) {
    g = Math.max(0, Math.min(total - 1, g));
    let s = offsets.length - 1;
    while (s > 0 && offsets[s] > g) s--;
    pos = { s, c: g - offsets[s] };
  }

  // ---------- Voz ----------

  function loadVoices() {
    voices = synth.getVoices();
    if (!voices.length) return;
    const saved = store.get('lector:voice');
    const sorted = [...voices].sort((a, b) => {
      const ae = a.lang.toLowerCase().startsWith('es') ? 0 : 1;
      const be = b.lang.toLowerCase().startsWith('es') ? 0 : 1;
      return ae - be || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
    });
    els.voiceSelect.innerHTML = sorted
      .map((v) => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)} (${v.lang})</option>`).join('');
    if (saved && voices.some((v) => v.name === saved)) els.voiceSelect.value = saved;
  }

  function currentVoice() {
    return voices.find((v) => v.name === els.voiceSelect.value) || null;
  }

  function speakCurrent() {
    const myToken = ++token;
    const text = sections[pos.s].chunks[pos.c];
    const u = new SpeechSynthesisUtterance(text);
    const voice = currentVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'es-ES'; }
    u.rate = parseFloat(els.rate.value);
    u.pitch = parseFloat(els.pitch.value);
    u.onend = () => {
      if (myToken !== token || !playing) return;
      advance(1) ? speakCurrent() : finish();
    };
    u.onerror = (e) => {
      if (myToken !== token || e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('Error de voz:', e.error);
      if (playing && advance(1)) speakCurrent(); else finish();
    };
    highlight(true);
    updateProgress();
    synth.speak(u);
  }

  function advance(step) {
    const g = offsets[pos.s] + pos.c + step;
    if (g < 0 || g >= total) return false;
    setGlobal(g);
    return true;
  }

  function play() {
    if (!sections.length) return;
    synth.cancel();
    playing = true;
    els.playBtn.textContent = '⏸';
    speakCurrent();
    setMediaState('playing');
  }

  function pause() {
    playing = false;
    token++;
    synth.cancel();
    els.playBtn.textContent = '▶';
    setMediaState('paused');
  }

  function stop() {
    pause();
  }

  function finish() {
    pause();
    els.progressText.textContent = '100 %';
  }

  function jump(step) {
    if (!sections.length) return;
    advance(step);
    if (playing) play(); else { highlight(true); updateProgress(); }
  }

  // Controles en la pantalla de bloqueo / auriculares
  function setMediaState(state) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = state;
  }
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', play);
      ms.setActionHandler('pause', pause);
      ms.setActionHandler('previoustrack', () => jump(-1));
      ms.setActionHandler('nexttrack', () => jump(1));
    } catch { /* no soportado */ }
  }

  // ---------- Eventos ----------

  els.fileInput.addEventListener('change', () => {
    const f = els.fileInput.files[0];
    if (f) loadFile(f);
    els.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('over');
  }));
  els.dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  els.playBtn.addEventListener('click', () => (playing ? pause() : play()));
  els.stopBtn.addEventListener('click', () => {
    stop();
    pos = { s: pos.s, c: 0 };
    highlight(true);
    updateProgress();
  });
  els.prevBtn.addEventListener('click', () => jump(-1));
  els.nextBtn.addEventListener('click', () => jump(1));

  els.sectionSelect.addEventListener('change', () => {
    pos = { s: parseInt(els.sectionSelect.value, 10), c: 0 };
    renderSection();
    if (playing) play(); else { highlight(false); updateProgress(); }
    window.scrollTo({ top: els.reader.offsetTop - 20, behavior: 'smooth' });
  });

  els.progress.addEventListener('input', () => {
    setGlobal(parseInt(els.progress.value, 10));
    if (playing) play(); else { highlight(true); updateProgress(); }
  });

  els.reader.addEventListener('click', (e) => {
    const el = e.target.closest('.chunk');
    if (!el) return;
    pos = { s: pos.s, c: parseInt(el.dataset.i, 10) };
    play();
  });

  const restartIfPlaying = () => { if (playing) play(); };
  els.voiceSelect.addEventListener('change', () => {
    store.set('lector:voice', els.voiceSelect.value);
    restartIfPlaying();
  });
  els.rate.addEventListener('input', () => { els.rateVal.textContent = `${parseFloat(els.rate.value).toFixed(1)}×`; });
  els.rate.addEventListener('change', () => { store.set('lector:rate', els.rate.value); restartIfPlaying(); });
  els.pitch.addEventListener('input', () => { els.pitchVal.textContent = parseFloat(els.pitch.value).toFixed(1); });
  els.pitch.addEventListener('change', restartIfPlaying);

  const savedRate = store.get('lector:rate');
  if (savedRate) { els.rate.value = savedRate; els.rateVal.textContent = `${parseFloat(savedRate).toFixed(1)}×`; }

  loadVoices();
  synth.addEventListener?.('voiceschanged', loadVoices);
  if ('onvoiceschanged' in synth && !synth.addEventListener) synth.onvoiceschanged = loadVoices;

  window.addEventListener('beforeunload', () => synth.cancel());
})();
