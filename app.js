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
    pitchLabel: $('pitchLabel'), elevenBox: $('elevenBox'), elevenKey: $('elevenKey'),
    voiceStatus: $('voiceStatus'),
  };

  // Voces de ElevenLabs (necesitan API key). Para agregar otra, añade su ID aquí.
  // Los ajustes de Bunty son los de la muestra: …_pvc_sp100_s99_sb75_se0_b_m2.mp3
  const ELEVEN_VOICES = [
    {
      id: 'jbRykb1aT1FR2rySl8nh',
      name: 'Bunty – Warm and Clear',
      settings: { stability: 0.99, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1.0 },
    },
  ];
  const ELEVEN_MODEL = 'eleven_multilingual_v2';
  const ELEVEN_PREFIX = 'eleven:';

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

      clearClips();
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
    const saved = store.get('lector:voice');
    const sorted = [...voices].sort((a, b) => {
      const ae = a.lang.toLowerCase().startsWith('es') ? 0 : 1;
      const be = b.lang.toLowerCase().startsWith('es') ? 0 : 1;
      return ae - be || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
    });
    const eleven = ELEVEN_VOICES
      .map((v) => `<option value="${ELEVEN_PREFIX}${v.id}">⭐ ${escapeHtml(v.name)} (${v.id})</option>`).join('');
    const system = sorted
      .map((v) => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)} (${v.lang})</option>`).join('');
    els.voiceSelect.innerHTML =
      `<optgroup label="ElevenLabs (requiere API key)">${eleven}</optgroup>` +
      (system ? `<optgroup label="Voces del navegador">${system}</optgroup>` : '');
    const options = [...els.voiceSelect.options].map((o) => o.value);
    if (saved && options.includes(saved)) els.voiceSelect.value = saved;
    else els.voiceSelect.value = options[0];
    updateEngineUi();
  }

  function currentVoice() {
    return voices.find((v) => v.name === els.voiceSelect.value) || null;
  }

  function elevenVoiceId() {
    const v = els.voiceSelect.value;
    return v.startsWith(ELEVEN_PREFIX) ? v.slice(ELEVEN_PREFIX.length) : null;
  }

  function setVoiceStatus(msg, isError = false) {
    els.voiceStatus.textContent = msg || '';
    els.voiceStatus.classList.toggle('hidden', !msg);
    els.voiceStatus.classList.toggle('error', isError);
  }

  function updateEngineUi() {
    const eleven = !!elevenVoiceId();
    els.elevenBox.classList.toggle('hidden', !eleven);
    els.pitchLabel.classList.toggle('hidden', eleven);
    if (eleven && !els.elevenKey.value.trim()) {
      setVoiceStatus('Pega tu API key de ElevenLabs (elevenlabs.io → Developers → API Keys). Se guarda solo en este navegador.');
    } else {
      setVoiceStatus('');
    }
    if (eleven) fetchElevenNames();
  }

  // ---------- ElevenLabs ----------

  const audio = new Audio();
  audio.preservesPitch = true;
  const clipCache = new Map(); // "voz|índice" → Promise<URL de blob>
  let namesFetchedFor = null;

  function clearClips() {
    for (const p of clipCache.values()) p.then((url) => URL.revokeObjectURL(url), () => {});
    clipCache.clear();
  }

  function getClip(g) {
    const voiceId = elevenVoiceId();
    const voiceSettings = ELEVEN_VOICES.find((v) => v.id === voiceId)?.settings;
    const key = `${voiceId}|${g}`;
    if (clipCache.has(key)) return clipCache.get(key);

    let s = offsets.length - 1;
    while (s > 0 && offsets[s] > g) s--;
    const text = sections[s].chunks[g - offsets[s]];

    const p = fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: {
        'xi-api-key': els.elevenKey.value.trim(),
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: ELEVEN_MODEL, ...(voiceSettings && { voice_settings: voiceSettings }) }),
    }).then(async (res) => {
      if (!res.ok) {
        let detail = '';
        try { const j = await res.json(); detail = j.detail?.message || j.detail?.status || JSON.stringify(j.detail || j); } catch { /* sin cuerpo */ }
        const hint = res.status === 401 ? 'API key inválida o sin permiso de texto a voz.'
          : res.status === 429 ? 'Demasiadas solicitudes o sin créditos.' : '';
        throw new Error(`ElevenLabs ${res.status}. ${hint} ${detail}`.trim());
      }
      return URL.createObjectURL(await res.blob());
    });
    p.catch(() => clipCache.delete(key)); // permitir reintento
    clipCache.set(key, p);

    // Mantener la caché pequeña
    while (clipCache.size > 12) {
      const [oldKey, oldP] = clipCache.entries().next().value;
      clipCache.delete(oldKey);
      oldP.then((url) => URL.revokeObjectURL(url), () => {});
    }
    return p;
  }

  async function fetchElevenNames() {
    const apiKey = els.elevenKey.value.trim();
    if (!apiKey || namesFetchedFor === apiKey) return;
    namesFetchedFor = apiKey;
    for (const v of ELEVEN_VOICES) {
      try {
        const res = await fetch(`https://api.elevenlabs.io/v1/voices/${v.id}`, { headers: { 'xi-api-key': apiKey } });
        if (!res.ok) continue;
        const { name } = await res.json();
        const opt = els.voiceSelect.querySelector(`option[value="${ELEVEN_PREFIX}${v.id}"]`);
        if (name && opt) opt.textContent = `⭐ ${name} (ElevenLabs)`;
      } catch { /* el nombre es opcional */ }
    }
  }

  async function speakEleven(myToken) {
    if (!els.elevenKey.value.trim()) {
      pause();
      updateEngineUi();
      els.elevenKey.focus();
      return;
    }
    const g = offsets[pos.s] + pos.c;
    highlight(true);
    updateProgress();
    setVoiceStatus('Generando voz…');
    try {
      const url = await getClip(g);
      if (myToken !== token) return;
      setVoiceStatus('');
      // Pedir por adelantado las siguientes frases para que no haya pausas
      for (let k = 1; k <= 2 && g + k < total; k++) getClip(g + k).catch(() => {});
      audio.src = url;
      audio.playbackRate = parseFloat(els.rate.value);
      audio.onended = () => {
        if (myToken !== token || !playing) return;
        advance(1) ? speakCurrent() : finish();
      };
      await audio.play();
    } catch (err) {
      if (myToken !== token) return;
      console.error(err);
      pause();
      setVoiceStatus(err.name === 'TypeError'
        ? 'No se pudo conectar con ElevenLabs. Revisa tu conexión.'
        : err.message, true);
    }
  }

  function speakCurrent() {
    const myToken = ++token;
    if (elevenVoiceId()) { speakEleven(myToken); return; }
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
    audio.pause();
    playing = true;
    els.playBtn.textContent = '⏸';
    speakCurrent();
    setMediaState('playing');
  }

  function pause() {
    playing = false;
    token++;
    synth.cancel();
    audio.pause();
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

  $('sampleBtn').addEventListener('click', () => {
    const texto = `Capítulo 1. El sueño de Luffy.

Monkey D. Luffy quería ser el Rey de los Piratas. Desde niño soñaba con navegar por el Grand Line y encontrar el tesoro más grande del mundo: el One Piece.

Un día subió a un pequeño bote y se hizo a la mar. «¡Voy a reunir a la mejor tripulación!», gritó mirando el horizonte.

Capítulo 2. El cazador de piratas.

En la primera isla encontró a Roronoa Zoro, un espadachín atado en el patio de la base de la Marina. Zoro aceptó unirse a él con una condición: algún día sería el mejor espadachín del mundo.`;
    loadFile(new File([texto], 'Ejemplo - El sueño de Luffy.txt', { type: 'text/plain' }));
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
    updateEngineUi();
    restartIfPlaying();
  });
  els.elevenKey.value = store.get('lector:elevenKey') || '';
  els.elevenKey.addEventListener('change', () => {
    store.set('lector:elevenKey', els.elevenKey.value.trim());
    clearClips();
    updateEngineUi();
  });
  els.rate.addEventListener('input', () => {
    els.rateVal.textContent = `${parseFloat(els.rate.value).toFixed(1)}×`;
    audio.playbackRate = parseFloat(els.rate.value);
  });
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
