/**
 * ESCUCHA SOCIAL ACTIVA · Creativa Política
 *
 * Robot que corre solo en Google Apps Script. Cada 3 horas busca menciones de
 * cada cliente activo, las valora con Gemini y las carga en la solapa
 * Menciones del tablero. Cada mañana escribe el resumen del día anterior y
 * cada lunes el informe de la semana.
 *
 * Instalación paso a paso en escucha/GUIA.md. Las claves van en
 * Configuración del proyecto > Propiedades de la secuencia de comandos,
 * nunca en este archivo.
 *
 *   GEMINI_KEY    obligatoria. Clave de Google AI Studio.
 *   X_BEARER      opcional. Token de la API de X (plan pago).
 *   META_TOKEN    opcional. Token de Meta con acceso a las páginas propias.
 *   APIFY_TOKEN   opcional. Token de Apify para TikTok y redes de terceros (pago por uso).
 */

const PROYECTO = 'flujo-trabajo-cretiva-politica';
const ZONA = 'America/Argentina/Buenos_Aires';
const MODELO = 'gemini-flash-latest';          // se cambia con la propiedad GEMINI_MODELO
const MODELO_RESPALDO = 'gemini-flash-lite-latest'; // más cuota gratis, se usa si el principal está saturado
const LOTE_GEMINI = 12;             // menciones por consulta a Gemini
const PAUSA_GEMINI_MS = 6500;       // pausa entre consultas para no pasar el límite gratuito por minuto
const FS = 'https://firestore.googleapis.com/v1/projects/' + PROYECTO + '/databases/(default)/documents';
const MAX_POR_FUENTE = 30;          // menciones nuevas por fuente y por corrida
const MAX_COMENTARIOS_VIDEO = 15;
const DIAS_HACIA_ATRAS = 2;         // ventana de búsqueda de cada corrida

/* =========================================================================
   INSTALACIÓN Y PRUEBA
   ========================================================================= */

/** Crea las tareas automáticas. Se ejecuta una sola vez. */
function instalar() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('recolectar').timeBased().everyHours(3).create();
  ScriptApp.newTrigger('resumenDiario').timeBased().atHour(7).everyDays(1).inTimezone(ZONA).create();
  ScriptApp.newTrigger('informeSemanal').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).inTimezone(ZONA).create();
  Logger.log('Listo. Recolección cada 3 horas, resumen diario a las 7 y semanal los lunes a las 8.');
  diagnostico();
}

/** Revisa claves y accesos sin escribir menciones. */
function diagnostico() {
  geminiCaido = '';
  const p = props();
  Logger.log('Gemini: ' + (p.GEMINI_KEY ? 'clave cargada' : 'FALTA la clave GEMINI_KEY'));
  if (p.GEMINI_KEY) {
    try { gemini('Respondé solo con la palabra listo.', false); Logger.log('Gemini responde bien con el modelo ' + ultimoModelo); }
    catch (e) { Logger.log('Gemini NO responde. ' + e.message); }
  }
  Logger.log('X: ' + (p.X_BEARER ? 'token cargado' : 'sin token, se omite'));
  Logger.log('Meta (Facebook e Instagram propios): ' + (p.META_TOKEN ? 'token cargado' : 'sin token, se omite'));
  Logger.log('Apify (TikTok y redes de terceros): ' + (p.APIFY_TOKEN ? 'token cargado' : 'sin token, se omite'));
  const cs = clientesActivos();
  Logger.log('Clientes con escucha activa: ' + (cs.map(c => c.nombre + ' → "' + c.radar.nombre + '"').join(', ') || 'ninguno (falta cargar el Radar de búsqueda en Menciones)'));
}

/** Corre todo una vez, para probar. */
function probarAhora() { recolectar(); resumenDiario(); }

/* =========================================================================
   RECOLECCIÓN
   ========================================================================= */

function recolectar() {
  geminiCaido = '';
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const inicio = Date.now();
    clientesActivos().forEach(c => {
      if (Date.now() - inicio > 4.5 * 60 * 1000) return; // margen ante el límite de 6 minutos
      recolectarCliente(c);
    });
  } finally { lock.releaseLock(); }
}

function recolectarCliente(c) {
  const estado = { ultima: Date.now(), fuentes: {}, nuevas: 0 };
  const vistas = urlsRecientes(c.id);
  const candidatos = [];
  const fuentes = [
    ['medios', () => buscarMedios(c.radar)],
    ['youtube', () => buscarYouTube(c.radar)],
    ['x', () => buscarX(c.radar)],
    ['meta', () => buscarMeta(c.escucha)],
    ['apify', () => buscarApify(c.radar)]
  ];
  fuentes.forEach(([k, fn]) => {
    try {
      const r = fn();
      if (r === null) { estado.fuentes[k] = { activa: false }; return; }
      const nuevos = r.filter(m => m.url && !vistas.has(m.url)).slice(0, MAX_POR_FUENTE);
      nuevos.forEach(m => vistas.add(m.url));
      candidatos.push(...nuevos);
      estado.fuentes[k] = { activa: true, ok: true, encontradas: r.length, nuevas: nuevos.length };
    } catch (e) {
      estado.fuentes[k] = { activa: true, ok: false, error: String(e && e.message || e).slice(0, 300) };
    }
  });

  // Primero las que quedaron sin valorar en corridas anteriores
  let pendientes = 0, errorGemini = '';
  try { pendientes = revalorarPendientes(c); } catch (e) { errorGemini = e.message; }

  let escribir, descartadas = 0;
  if (errorGemini) {
    escribir = candidatos.map(sinValorar);
  } else {
    try {
      const valoradas = valorar(c.radar, candidatos);
      escribir = valoradas.filter(m => m.relevante !== false);
      descartadas = valoradas.length - escribir.length;
    } catch (e) {
      // Si Gemini no responde, las menciones se guardan igual y se valoran en la próxima corrida
      errorGemini = e.message;
      escribir = candidatos.map(sinValorar);
    }
  }
  escribirMenciones(c.id, escribir);
  estado.nuevas = escribir.length;
  estado.descartadas = descartadas;
  estado.gemini = errorGemini ? { ok: false, error: errorGemini.slice(0, 300), pendientes: pendientes + escribir.length } : { ok: true, modelo: ultimoModelo };
  fsSet('clientes/' + c.id + '/config/robot', estado);
}

/* ---------- Medios: diarios, revistas y sitios de noticias (Google Noticias) ---------- */
function buscarMedios(r) {
  const q = consulta(r) + ' when:' + DIAS_HACIA_ATRAS + 'd';
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=es-419&gl=AR&ceid=AR:es-419';
  const xml = XmlService.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: false }).getContentText());
  const items = xml.getRootElement().getChild('channel').getChildren('item');
  return items.map(it => {
    const fuente = it.getChild('source');
    const titulo = it.getChildText('title') || '';
    const medio = fuente ? fuente.getText() : '';
    return {
      fecha: dia(new Date(it.getChildText('pubDate'))),
      titulo: medio && titulo.endsWith(' - ' + medio) ? titulo.slice(0, -(medio.length + 3)) : titulo,
      url: it.getChildText('link'),
      medio: medio,
      fuente: 'medio',
      texto: limpiarHtml(it.getChildText('description') || '')
    };
  });
}

/* ---------- YouTube: videos recientes y sus comentarios ---------- */
function buscarYouTube(r) {
  const desde = new Date(Date.now() - DIAS_HACIA_ATRAS * 864e5).toISOString();
  const res = YouTube.Search.list('snippet', { q: consultaSimple(r), type: 'video', order: 'date', publishedAfter: desde, maxResults: 15, regionCode: 'AR', relevanceLanguage: 'es' });
  const out = [];
  (res.items || []).forEach(v => {
    const id = v.id.videoId, sn = v.snippet, url = 'https://www.youtube.com/watch?v=' + id;
    out.push({ fecha: dia(new Date(sn.publishedAt)), titulo: sn.title, url: url, medio: sn.channelTitle, fuente: 'youtube', texto: sn.description || '' });
    try {
      const cs = YouTube.CommentThreads.list('snippet', { videoId: id, maxResults: MAX_COMENTARIOS_VIDEO, order: 'relevance', textFormat: 'plainText' });
      (cs.items || []).forEach(t => {
        const s = t.snippet.topLevelComment.snippet;
        out.push({ fecha: dia(new Date(s.publishedAt)), titulo: s.textDisplay, url: url + '&lc=' + t.id, medio: 'Comentario en «' + sn.title + '»', firma: s.authorDisplayName, fuente: 'youtube', texto: s.textDisplay, esComentario: true });
      });
    } catch (e) { /* comentarios desactivados en ese video */ }
  });
  return out;
}

/* ---------- X: búsqueda reciente (requiere plan pago de la API) ---------- */
function buscarX(r) {
  const token = props().X_BEARER;
  if (!token) return null;
  const q = consulta(r) + ' -is:retweet lang:es';
  const url = 'https://api.x.com/2/tweets/search/recent?max_results=50&query=' + encodeURIComponent(q.slice(0, 512)) +
    '&tweet.fields=created_at,public_metrics&expansions=author_id&user.fields=username,name,public_metrics';
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('X respondió ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  const data = JSON.parse(res.getContentText());
  const users = {};
  ((data.includes && data.includes.users) || []).forEach(u => users[u.id] = u);
  return (data.data || []).map(t => {
    const u = users[t.author_id] || {};
    return { fecha: dia(new Date(t.created_at)), titulo: t.text, url: 'https://x.com/' + (u.username || 'i') + '/status/' + t.id, medio: u.name ? u.name + ' (@' + u.username + ')' : '', firma: u.username ? '@' + u.username : '', fuente: 'x', texto: t.text, seguidores: u.public_metrics ? u.public_metrics.followers_count : '' };
  });
}

/* ---------- Facebook e Instagram: publicaciones y comentarios de las páginas propias ---------- */
function buscarMeta(esc) {
  const token = props().META_TOKEN;
  if (!token || !esc || (!esc.fbPageId && !esc.igUserId)) return null;
  const G = 'https://graph.facebook.com/v21.0/';
  const get = (path, tk) => {
    const res = UrlFetchApp.fetch(G + path + (path.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(tk), { muteHttpExceptions: true });
    const j = JSON.parse(res.getContentText());
    if (j.error) throw new Error('Meta: ' + j.error.message);
    return j;
  };
  const desde = Math.floor((Date.now() - DIAS_HACIA_ATRAS * 864e5) / 1000);
  const out = [];
  if (esc.fbPageId) {
    const pageToken = get(esc.fbPageId + '?fields=access_token,name', token);
    const posts = get(esc.fbPageId + '/posts?since=' + desde + '&limit=25&fields=message,created_time,permalink_url,comments.limit(50){message,created_time,from,permalink_url}', pageToken.access_token || token);
    (posts.data || []).forEach(p => {
      ((p.comments && p.comments.data) || []).forEach(cm => {
        if (!cm.message) return;
        out.push({ fecha: dia(new Date(cm.created_time)), titulo: cm.message, url: cm.permalink_url || p.permalink_url + '#' + cm.id, medio: 'Comentario en Facebook · ' + (pageToken.name || 'página propia'), firma: cm.from ? cm.from.name : '', fuente: 'facebook', texto: cm.message, esComentario: true });
      });
    });
  }
  if (esc.igUserId) {
    const media = get(esc.igUserId + '/media?limit=20&fields=caption,permalink,timestamp,comments.limit(50){text,timestamp,username,id}', token);
    (media.data || []).forEach(p => {
      if (new Date(p.timestamp).getTime() / 1000 < desde - 5 * 86400) return;
      ((p.comments && p.comments.data) || []).forEach(cm => {
        out.push({ fecha: dia(new Date(cm.timestamp)), titulo: cm.text, url: p.permalink + '#c' + cm.id, medio: 'Comentario en Instagram', firma: cm.username ? '@' + cm.username : '', fuente: 'instagram', texto: cm.text, esComentario: true });
      });
    });
  }
  return out;
}

/* ---------- TikTok y redes de terceros con Apify (pago por uso) ----------
   Los "actores" de Apify se eligen al contratar. Por defecto busca en TikTok;
   se cambia con las propiedades APIFY_ACTOR_TIKTOK y APIFY_INPUT_TIKTOK. */
function buscarApify(r) {
  const token = props().APIFY_TOKEN;
  if (!token) return null;
  const actor = props().APIFY_ACTOR_TIKTOK || 'clockworks~tiktok-scraper';
  let input = { searchQueries: [consultaSimple(r)], resultsPerPage: 30, searchSection: '/video' };
  if (props().APIFY_INPUT_TIKTOK) input = JSON.parse(props().APIFY_INPUT_TIKTOK.replace('{{consulta}}', consultaSimple(r)));
  const res = UrlFetchApp.fetch('https://api.apify.com/v2/acts/' + actor + '/run-sync-get-dataset-items?timeout=120&token=' + encodeURIComponent(token), {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(input), muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('Apify respondió ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  const limite = Date.now() - (DIAS_HACIA_ATRAS + 1) * 864e5;
  return JSON.parse(res.getContentText()).map(it => {
    const f = it.createTimeISO || it.createTime && new Date(it.createTime * 1000).toISOString() || it.timestamp || it.date;
    const a = it.authorMeta || it.author || {};
    return { fecha: f ? dia(new Date(f)) : dia(new Date()), ts: f ? new Date(f).getTime() : Date.now(), titulo: it.text || it.title || it.caption || '', url: it.webVideoUrl || it.url || it.postUrl || '', medio: a.nickName || a.name || '', firma: a.name ? '@' + a.name : '', fuente: 'tiktok', texto: it.text || it.caption || '', seguidores: a.fans || a.followers || '' };
  }).filter(m => m.url && m.ts >= limite);
}

/* =========================================================================
   VALORACIÓN CON GEMINI
   ========================================================================= */

function sinValorar(m) { return Object.assign({}, m, { tono: 'neutro', puntaje: null, tema: '', accion: 'ninguna', resumen: '', valorada: false }); }

/** Valora las menciones que quedaron pendientes porque Gemini no respondió. Devuelve cuántas siguen pendientes. */
function revalorarPendientes(c) {
  const pend = fsQuery('clientes/' + c.id, 'menciones', { fieldFilter: { field: { fieldPath: 'valorada' }, op: 'EQUAL', value: { booleanValue: false } } }).slice(0, 36);
  if (!pend.length) return 0;
  const val = valorar(c.radar, pend.map(m => ({ titulo: m.titulo, texto: m.titulo, medio: m.medio, firma: m.firma, fuente: m.fuente, _id: m._id, accion: m.accion, nota: m.nota })));
  val.forEach((v, k) => {
    const orig = pend[k], ruta = 'clientes/' + c.id + '/menciones/' + orig._id;
    const tocada = (orig.nota || '') !== '' || (orig.accion || 'ninguna') !== 'ninguna';
    if (v.relevante === false && !tocada) { fetchFs('DELETE', FS + '/' + ruta); return; }
    const campos = { tono: v.tono, puntaje: v.puntaje, tema: v.tema, resumen: v.resumen, valorada: true };
    if (!tocada) campos.accion = v.accion; // no cambia una acción que eligió el equipo
    fsUpdate(ruta, campos);
  });
  return 0;
}

function valorar(r, items) {
  if (!items.length) return [];
  const out = [];
  for (let i = 0; i < items.length; i += LOTE_GEMINI) {
    if (i) Utilities.sleep(PAUSA_GEMINI_MS);
    const lote = items.slice(i, i + LOTE_GEMINI);
    const lista = lote.map((m, k) => ({ i: k, fuente: m.fuente, medio: m.medio, autor: m.firma || '', texto: (m.titulo + '\n' + (m.texto || '')).slice(0, 900) }));
    const prompt =
      'Sos analista de escucha social de una consultora política argentina. El cliente es "' + r.nombre + '"' +
      (r.contexto ? ' (contexto: ' + r.contexto + ')' : '') + '.\n' +
      'Para cada mención de la lista devolvé un objeto con estos campos.\n' +
      '- i, el mismo número recibido\n' +
      '- relevante, false si habla de otra persona con el mismo nombre o no tiene relación con el cliente\n' +
      '- tono, "positivo", "neutro" o "negativo" respecto del cliente\n' +
      '- puntaje, entero de -2 (muy negativo) a 2 (muy positivo)\n' +
      '- tema, dos a cuatro palabras\n' +
      '- accion, "ninguna", "monitorear", "responder" o "escalar" (escalar si hay riesgo de crisis, denuncia o ataque coordinado)\n' +
      '- resumen, una frase de hasta 200 caracteres sobre qué dice y por qué importa\n' +
      'Respondé solo con un arreglo JSON.\n\n' + JSON.stringify(lista);
    const res = gemini(prompt, true);
    const porI = {};
    (Array.isArray(res) ? res : []).forEach(x => { if (x && typeof x.i === 'number') porI[x.i] = x; });
    lote.forEach((m, k) => {
      const v = porI[k] || {};
      out.push(Object.assign({}, m, {
        relevante: v.relevante !== false,
        tono: ['positivo', 'neutro', 'negativo'].includes(v.tono) ? v.tono : 'neutro',
        puntaje: Math.max(-2, Math.min(2, parseInt(v.puntaje, 10) || 0)),
        tema: String(v.tema || '').slice(0, 60),
        accion: ['ninguna', 'monitorear', 'responder', 'escalar'].includes(v.accion) ? v.accion : 'ninguna',
        resumen: String(v.resumen || '').slice(0, 400),
        valorada: true
      }));
    });
  }
  return out;
}

let ultimoModelo = '', geminiCaido = '';
function gemini(prompt, json) {
  // Si ya falló en esta ejecución no insiste, para no pasar el límite de 6 minutos de Apps Script
  if (geminiCaido) throw new Error(geminiCaido);
  try { return geminiLlamar(prompt, json); }
  catch (e) { geminiCaido = e.message; throw e; }
}
function geminiLlamar(prompt, json) {
  const p = props(), key = p.GEMINI_KEY;
  if (!key) throw new Error('Falta la clave GEMINI_KEY en las propiedades del proyecto.');
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } };
  if (json) body.generationConfig.responseMimeType = 'application/json';
  const modelos = [p.GEMINI_MODELO || MODELO, MODELO_RESPALDO].filter((m, i, a) => a.indexOf(m) === i);
  let ultimo = '';
  for (const modelo of modelos) {
    for (let intento = 0; intento < 2; intento++) {
      const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent', {
        method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body), muteHttpExceptions: true
      });
      const code = res.getResponseCode(), txt = res.getContentText();
      if (code === 200) {
        ultimoModelo = modelo;
        const d = JSON.parse(txt);
        const out = (((d.candidates || [])[0] || {}).content || { parts: [] }).parts.map(x => x.text || '').join('');
        if (!json) return out;
        try { return JSON.parse(out); } catch (e) { const m = out.match(/[\[{][\s\S]*[\]}]/); return m ? JSON.parse(m[0]) : null; }
      }
      let msg = '', espera = 0;
      try {
        const e = JSON.parse(txt).error || {};
        msg = e.message || '';
        (e.details || []).forEach(d => { if (d.retryDelay) espera = parseFloat(d.retryDelay) || 0; });
      } catch (e) { msg = txt.slice(0, 200); }
      ultimo = modelo + ' respondió ' + code + (msg ? '. ' + msg.slice(0, 220) : '');
      if (code === 400 && /api key/i.test(msg)) throw new Error('La clave de Gemini no es válida. Revisá GEMINI_KEY. ' + msg.slice(0, 160));
      if (code === 403) throw new Error('La clave de Gemini no tiene permiso. Revisá que la API esté habilitada en Google AI Studio. ' + msg.slice(0, 160));
      if (code === 404) break;                                   // modelo inexistente, probar el de respaldo
      if (code === 429 && /per ?day|PerDay|daily/i.test(msg)) break; // cuota del día agotada en este modelo
      if (code === 429 || code >= 500) { Utilities.sleep(Math.min(30, Math.max(espera, 10)) * 1000); continue; }
      throw new Error('Gemini ' + ultimo);
    }
  }
  throw new Error('Gemini no respondió. Último intento, ' + ultimo + '. Si dice cuota (quota), el plan gratuito llegó a su límite y se libera solo en unas horas.');
}

/* =========================================================================
   RESUMEN DIARIO E INFORME SEMANAL
   ========================================================================= */

function resumenDiario() {
  geminiCaido = '';
  const ayer = dia(new Date(Date.now() - 864e5));
  clientesActivos().forEach(c => {
    try { escribirInforme(c, 'diario', ayer, ayer); } catch (e) { Logger.log(c.nombre + ': ' + e); }
  });
}

function informeSemanal() {
  geminiCaido = '';
  const hasta = dia(new Date(Date.now() - 864e5)), desde = dia(new Date(Date.now() - 7 * 864e5));
  clientesActivos().forEach(c => {
    try { escribirInforme(c, 'semanal', desde, hasta); } catch (e) { Logger.log(c.nombre + ': ' + e); }
  });
}

function escribirInforme(c, tipo, desde, hasta) {
  const ms = mencionesEntre(c.id, desde, hasta);
  const cuenta = lista => ({ total: lista.length, positivo: lista.filter(m => m.tono === 'positivo').length, neutro: lista.filter(m => (m.tono || 'neutro') === 'neutro').length, negativo: lista.filter(m => m.tono === 'negativo').length });
  const porFuente = {};
  ms.forEach(m => { porFuente[m.fuente || 'medio'] = (porFuente[m.fuente || 'medio'] || 0) + 1; });
  const conPuntaje = ms.filter(m => typeof m.puntaje === 'number');
  const indice = conPuntaje.length ? Math.round(conPuntaje.reduce((a, m) => a + m.puntaje, 0) / conPuntaje.length * 50) : null; // de -100 a 100

  let anterior = null;
  if (tipo === 'semanal') {
    const d0 = dia(new Date(new Date(desde + 'T12:00:00').getTime() - 7 * 864e5)), d1 = dia(new Date(new Date(desde + 'T12:00:00').getTime() - 864e5));
    anterior = cuenta(mencionesEntre(c.id, d0, d1));
  }

  let analisis = { titular: 'Sin menciones en el período', resumen: 'No se registraron menciones de ' + c.radar.nombre + ' entre el ' + desde + ' y el ' + hasta + '.', temas: [], alertas: [], recomendaciones: [] };
  if (ms.length) {
    const muestra = ms.sort((a, b) => Math.abs(b.puntaje || 0) - Math.abs(a.puntaje || 0)).slice(0, 250)
      .map(m => ({ fecha: m.fecha, fuente: m.fuente, medio: m.medio, tono: m.tono, puntaje: m.puntaje, tema: m.tema, texto: (m.resumen || m.titulo || '').slice(0, 300), accion: m.accion }));
    const prompt =
      'Sos jefe de monitoreo de una consultora política argentina. Escribí el ' + (tipo === 'diario' ? 'resumen diario del ' + desde : 'informe semanal del ' + desde + ' al ' + hasta) +
      ' sobre "' + c.radar.nombre + '". Tono profesional, frases cortas, sin relleno. Distinguí datos de interpretaciones y no confundas conversación digital con intención de voto.\n' +
      'Cifras ya calculadas ' + JSON.stringify(cuenta(ms)) + '. Por fuente ' + JSON.stringify(porFuente) + (anterior ? '. Semana anterior ' + JSON.stringify(anterior) : '') + '.\n' +
      'Devolvé solo un objeto JSON con titular (una frase), resumen (' + (tipo === 'diario' ? 'un párrafo' : 'dos o tres párrafos, con la comparación contra la semana anterior') + '), ' +
      'temas (arreglo de hasta 6 objetos con tema, menciones y tono), alertas (arreglo de textos, vacío si no hay) y recomendaciones (arreglo de hasta 4 textos).\n\nMenciones\n' + JSON.stringify(muestra);
    let r;
    try { r = gemini(prompt, true) || {}; }
    catch (e) {
      r = { titular: 'Resumen sin redactar', resumen: 'Gemini no respondió al armar este informe (' + e.message.slice(0, 160) + '). Las cifras y las menciones destacadas están completas.', temas: [], alertas: [], recomendaciones: [] };
    }
    analisis = {
      titular: String(r.titular || '').slice(0, 200),
      resumen: String(r.resumen || '').slice(0, 4000),
      temas: (Array.isArray(r.temas) ? r.temas : []).slice(0, 6).map(t => ({ tema: String(t.tema || '').slice(0, 60), menciones: parseInt(t.menciones, 10) || 0, tono: String(t.tono || '').slice(0, 20) })),
      alertas: (Array.isArray(r.alertas) ? r.alertas : []).slice(0, 6).map(x => String(x).slice(0, 400)),
      recomendaciones: (Array.isArray(r.recomendaciones) ? r.recomendaciones : []).slice(0, 4).map(x => String(x).slice(0, 400))
    };
  }
  const destacadas = ms.filter(m => m.accion === 'escalar' || m.accion === 'responder' || Math.abs(m.puntaje || 0) === 2).slice(0, 12)
    .map(m => ({ titulo: (m.titulo || '').slice(0, 200), url: m.url || '', medio: m.medio || '', tono: m.tono || 'neutro', fecha: m.fecha }));
  fsSet('clientes/' + c.id + '/informes/' + tipo + '-' + hasta, Object.assign({
    tipo: tipo, desde: desde, hasta: hasta, fecha: hasta, creado: Date.now(),
    cifras: cuenta(ms), porFuente: porFuente, indice: indice, anterior: anterior, destacadas: destacadas
  }, analisis));
}

/* =========================================================================
   FIRESTORE
   ========================================================================= */

function clientesActivos() {
  const out = [];
  fsList('clientes').forEach(c => {
    if (c.data.estado === 'archivado') return;
    const radar = fsGet('clientes/' + c.id + '/config/radar') || {};
    const escucha = fsGet('clientes/' + c.id + '/config/escucha') || {};
    const nombre = (radar.nombre || c.data.nombre || '').trim();
    if (!nombre || escucha.activo === false) return;
    out.push({ id: c.id, nombre: c.data.nombre || nombre, radar: { nombre: nombre, contexto: radar.contexto || '', excluir: radar.excluir || '' }, escucha: escucha });
  });
  return out;
}

function urlsRecientes(cid) {
  const desde = dia(new Date(Date.now() - 20 * 864e5));
  return new Set(fsQuery('clientes/' + cid, 'menciones', { fieldFilter: { field: { fieldPath: 'fecha' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: desde } } }, ['url'])
    .map(m => (m.url || '').trim()).filter(Boolean));
}

function mencionesEntre(cid, desde, hasta) {
  return fsQuery('clientes/' + cid, 'menciones', { compositeFilter: { op: 'AND', filters: [
    { fieldFilter: { field: { fieldPath: 'fecha' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: desde } } },
    { fieldFilter: { field: { fieldPath: 'fecha' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: hasta } } }
  ] } });
}

function escribirMenciones(cid, lista) {
  if (!lista.length) return;
  const ahora = Date.now();
  const writes = lista.map(m => {
    const id = 'r' + Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, m.url).map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('').slice(0, 20);
    const seg = parseInt(m.seguidores, 10) || '';
    const doc = {
      fecha: m.fecha, url: String(m.url).slice(0, 600), titulo: String(m.titulo || m.url).replace(/\s+/g, ' ').slice(0, 300),
      resumen: m.resumen || '', medio: String(m.medio || '').slice(0, 120), firma: String(m.firma || '').slice(0, 120),
      fuente: m.fuente, tono: m.tono, puntaje: m.puntaje, tema: m.tema, etiquetas: m.esComentario ? 'comentario' : '',
      seguidores: seg, alcance: seg ? (seg >= 100000 ? 'alto' : seg >= 10000 ? 'medio' : 'bajo') : '',
      accion: m.accion, nota: '', origen: 'robot', autor: 'robot', at: ahora, valorada: m.valorada !== false
    };
    if (m.puntaje === null || m.puntaje === undefined) delete doc.puntaje;
    // exists:false no pisa una mención que el equipo ya editó
    return { update: { name: FS.replace('https://firestore.googleapis.com/v1/', '') + '/clientes/' + cid + '/menciones/' + id, fields: toFs(doc).mapValue.fields }, currentDocument: { exists: false } };
  });
  for (let i = 0; i < writes.length; i += 100) {
    fetchFs('POST', FS.replace('/documents', '/documents:batchWrite'), { writes: writes.slice(i, i + 100) });
  }
}

function fsGet(path) {
  const r = fetchFs('GET', FS + '/' + path, null, true);
  return r ? fromFs({ mapValue: { fields: r.fields || {} } }) : null;
}
function fsUpdate(path, campos) {
  const mask = Object.keys(campos).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  fetchFs('PATCH', FS + '/' + path + '?' + mask + '&currentDocument.exists=true', { fields: toFs(campos).mapValue.fields });
}
function fsSet(path, data) { fetchFs('PATCH', FS + '/' + path, { fields: toFs(data).mapValue.fields }); }
function fsList(col) {
  const out = []; let tok = '';
  do {
    const r = fetchFs('GET', FS + '/' + col + '?pageSize=300' + (tok ? '&pageToken=' + tok : '')) || {};
    (r.documents || []).forEach(d => out.push({ id: d.name.split('/').pop(), data: fromFs({ mapValue: { fields: d.fields || {} } }) }));
    tok = r.nextPageToken || '';
  } while (tok);
  return out;
}
function fsQuery(parent, col, where, campos) {
  const q = { structuredQuery: { from: [{ collectionId: col }], where: where, limit: 2000 } };
  if (campos) q.structuredQuery.select = { fields: campos.map(f => ({ fieldPath: f })) };
  const r = fetchFs('POST', FS + '/' + parent + ':runQuery', q) || [];
  return r.filter(x => x.document).map(x => Object.assign(fromFs({ mapValue: { fields: x.document.fields || {} } }), { _id: x.document.name.split('/').pop() }));
}
function fetchFs(method, url, body, permitir404) {
  const opt = { method: method, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch(url, opt), code = res.getResponseCode();
  if (code === 404 && permitir404) return null;
  if (code >= 300) throw new Error('Firestore ' + code + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText() || '{}');
}

function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  const fields = {};
  Object.keys(v).forEach(k => { if (v[k] !== undefined) fields[k] = toFs(v[k]); });
  return { mapValue: { fields: fields } };
}
function fromFs(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) { const o = {}; Object.keys(v.mapValue.fields || {}).forEach(k => o[k] = fromFs(v.mapValue.fields[k])); return o; }
  return null;
}

/* =========================================================================
   UTILIDADES
   ========================================================================= */

function props() { return PropertiesService.getScriptProperties().getProperties(); }
function dia(d) { return Utilities.formatDate(isNaN(d) ? new Date() : d, ZONA, 'yyyy-MM-dd'); }
function partes(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean); }
function comillas(x) { return /\s/.test(x) ? '"' + x + '"' : x; }
function consulta(r) {
  const ctx = partes(r.contexto), ex = partes(r.excluir);
  return '"' + r.nombre + '"' + (ctx.length ? ' (' + ctx.map(comillas).join(' OR ') + ')' : '') + ex.map(x => ' -' + comillas(x)).join('');
}
function consultaSimple(r) { const ctx = partes(r.contexto); return r.nombre + (ctx[0] ? ' ' + ctx[0] : ''); }
function limpiarHtml(s) { return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }
