/*! opg-gibs-overlays.js
 *  OpenPortGuide (XYZ) + NASA GIBS (WMS) overlays for Map A/B
 *  Works with main app where A map = AppState.map (NOT mapA)
 *  Robust: has fallbacks if CONFIG keys are missing, and waits for AppState
 */
(function () {
  'use strict';

  // ---------- tiny logger ----------
  const log  = (...a) => console.log('%c[OPG+GIBS]', 'color:#22d3ee', ...a);
  const warn = (...a) => console.warn('[OPG+GIBS]', ...a);
  const boom = (m) => (alert(m), warn(m));

  // ---------- config (with safe fallback) ----------
  function readConfig() {
    const C = (window.CONFIG || {});
    const OPG_BASE = C.OPG_BASE || 'https://weather.openportguide.de/tiles/actual';
    const GIBS_WMS_BASE = C.GIBS_WMS_BASE || ((srs='3857') =>
      String(srs) === '4326'
        ? 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
        : 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi'
    );
    return { OPG_BASE, GIBS_WMS_BASE };
  }

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const iso = (d)=>`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  const normalizeFormat = (v) => (typeof v === 'string' && v.startsWith('image/')) ? v : 'image/png';

  function getMap(side) {
    const AS = window.AppState || {};
    return side === 'B' ? (AS.mapB || null) : (AS.map || AS.mapA || null);
  }
  function setOverlay(side, kind, layer) {
    const key = kind + (side === 'B' ? 'B' : 'A'); // 'opgA','wmsB',...
    if (window.AppState) window.AppState[key] = layer;
  }
  function getOverlay(side, kind) {
    const key = kind + (side === 'B' ? 'B' : 'A');
    return (window.AppState && window.AppState[key]) || null;
  }
  function removeOverlay(side, kind) {
    const map = getMap(side);
    const lyr = getOverlay(side, kind);
    if (map && lyr) { map.removeLayer(lyr); setOverlay(side, kind, null); }
  }

  // ---------- OpenPortGuide (XYZ, var + step) ----------
  function opgUrl(OPG_BASE, variant, step) {
    return `${OPG_BASE}/${variant}/${step}/{z}/{x}/{y}.png`;
  }
  function addOPG(side='A') {
    const { OPG_BASE } = readConfig();
    const map = getMap(side);
    if (!map) return boom(`Map ${side} is not active.`);

    const varSel  = $(side==='B' ? 'opg-b-var'  : 'opg-a-var');
    const stepSel = $(side==='B' ? 'opg-b-step' : 'opg-a-step');
    if (!varSel || !stepSel) return boom('OpenPortGuide controls not found.');

    const variant = varSel.value || 'wind_stream';
    const step    = stepSel.value || '0h';

    removeOverlay(side, 'opg');
    const layer = L.tileLayer(opgUrl(OPG_BASE, variant, step), {
      maxZoom: 18, opacity: 0.9, crossOrigin: true, attribution: 'OpenPortGuide'
    }).addTo(map);
    setOverlay(side, 'opg', layer);
    log(`OPG added on ${side}`, { variant, step });
  }
  function copyOPG(side='A') {
    const { OPG_BASE } = readConfig();
    const varSel  = $(side==='B' ? 'opg-b-var'  : 'opg-a-var');
    const stepSel = $(side==='B' ? 'opg-b-step' : 'opg-a-step');
    const url = opgUrl(OPG_BASE, varSel?.value || 'wind_stream', stepSel?.value || '0h');
    navigator.clipboard?.writeText(url);
    alert('Tile URL copied:\n' + url);
  }

  // ---------- NASA GIBS — WMS ----------
  async function addWMS(side='A') {
    const { GIBS_WMS_BASE } = readConfig();
    const map = getMap(side);
    if (!map) return boom(`Map ${side} is not active.`);

    const projSel   = $(side==='B' ? 'wms-b-proj'   : 'wms-a-proj');
    const fmtSel    = $(side==='B' ? 'wms-b-format' : 'wms-a-format');
    const layerSel  = $(side==='B' ? 'wms-b-layer'  : 'wms-a-layer');
    const timeInput = $(side==='B' ? 'wms-b-time'   : 'wms-a-time');

    if (!projSel || !fmtSel || !layerSel) return boom('WMS controls not found.');

    const srs    = (projSel.value || '3857') === '4326' ? '4326' : '3857';
    const base   = GIBS_WMS_BASE(srs);
    const layer  = layerSel.value;
    const format = normalizeFormat(fmtSel.value || 'image/png');
    let   time   = (timeInput?.value || '').trim();

    removeOverlay(side, 'wms');

    if (!time) {
      time = await getLastWMSTime(base, layer) || await fallbackRecentDate(base, layer, srs, format);
    }

    const params = { layers: layer, format, transparent: true };
    if (time) params.time = time;

    const wms = L.tileLayer.wms(base, params)
      .on('tileerror', e => warn('WMS tile error', e))
      .addTo(map);

    setOverlay(side, 'wms', wms);
    log(`WMS added on ${side}`, { layer, srs, format, time });
  }
  function copyWMS(side='A') {
    const { GIBS_WMS_BASE } = readConfig();
    const projSel   = $(side==='B' ? 'wms-b-proj'   : 'wms-a-proj');
    const fmtSel    = $(side==='B' ? 'wms-b-format' : 'wms-a-format');
    const layerSel  = $(side==='B' ? 'wms-b-layer'  : 'wms-a-layer');
    const timeInput = $(side==='B' ? 'wms-b-time'   : 'wms-a-time');
    if (!projSel || !fmtSel || !layerSel) return boom('WMS controls not found.');

    const srs    = (projSel.value || '3857') === '4326' ? '4326' : '3857';
    const base   = GIBS_WMS_BASE(srs);
    const layer  = layerSel.value;
    const format = normalizeFormat(fmtSel.value || 'image/png');
    const time   = (timeInput?.value || '').trim();

    const params = new URLSearchParams({
      service:'WMS', request:'GetMap', version:'1.3.0',
      layers:layer, styles:'', format, transparent:'true',
      crs: srs==='4326' ? 'EPSG:4326' : 'EPSG:3857',
      bbox: srs==='4326' ? '-90,-180,90,180' : '-20037508.34,-20037508.34,20037508.34,20037508.34',
      width:'512', height:'512'
    });
    if (time) params.set('time', time);

    const url = `${base}?${params}`;
    navigator.clipboard?.writeText(url);
    alert('GetMap URL copied:\n' + url);
  }

  // ---- Capabilities: get latest TIME ----
  async function getLastWMSTime(baseUrl, layerName) {
    try {
      const txt = await fetch(`${baseUrl}?service=WMS&request=GetCapabilities&version=1.3.0`).then(r=>r.text());
      const xml = new DOMParser().parseFromString(txt, 'text/xml');
      const target = Array.from(xml.getElementsByTagName('Layer'))
        .find(n => n.getElementsByTagName('Name')[0]?.textContent === layerName);
      if (!target) return '';
      const node = target.querySelector('Dimension[name="time"], Extent[name="time"]');
      if (!node) return '';
      const def = (node.getAttribute('default') || '').trim();
      const raw = (node.textContent || '').trim();
      const pickEnd = (token) => {
        token = token.trim();
        if (!token) return '';
        if (token.includes('/')) return (token.split('/')[1] || '').slice(0,10);
        return token.slice(0,10);
      };
      if (raw) {
        const items = raw.split(',').map(s=>s.trim()).filter(Boolean);
        const last = pickEnd(items[items.length-1]);
        if (last) return last;
      }
      if (def) return def.slice(0,10);
      return '';
    } catch (e) {
      warn('GetCapabilities failed', e);
      return '';
    }
  }

  // ---- Fallback probing (today → -10d, plus -8/-16 for 8-day composites) ----
  async function fallbackRecentDate(base, layer, srs, format) {
    const now = new Date();
    const cands = [];
    for (let i=0;i<=10;i++){ const d=new Date(now); d.setUTCDate(d.getUTCDate()-i); cands.push(iso(d)); }
    const d1=new Date(now); d1.setUTCDate(d1.getUTCDate()-8);  cands.push(iso(d1));
    const d2=new Date(now); d2.setUTCDate(d2.getUTCDate()-16); cands.push(iso(d2));

    for (const t of cands) {
      const qs = new URLSearchParams({
        service:'WMS', request:'GetMap', version:'1.3.0',
        layers:layer, styles:'', format, transparent:'true',
        crs: srs==='4326' ? 'EPSG:4326' : 'EPSG:3857',
        bbox: srs==='4326' ? '-90,-180,90,180'
             : '-20037508.34,-20037508.34,20037508.34,20037508.34',
        width:'64', height:'64', time:t
      });
      try {
        const r = await fetch(`${base}?${qs}`);
        if (r.ok && (r.headers.get('content-type')||'').startsWith('image/')) return t;
      } catch {}
    }
    return '';
  }

  // ---------- wire UI ----------
  function wire(side) {
    const isB = side==='B';
    // OPG
    $('#'+(isB?'opg-b-add':'opg-a-add'))    ?.addEventListener('click', () => addOPG(side));
    $('#'+(isB?'opg-b-remove':'opg-a-remove'))?.addEventListener('click', () => removeOverlay(side, 'opg'));
    $('#'+(isB?'opg-b-copy':'opg-a-copy'))  ?.addEventListener('click', () => copyOPG(side));
    // WMS
    $('#'+(isB?'wms-b-add':'wms-a-add'))    ?.addEventListener('click', () => addWMS(side));
    $('#'+(isB?'wms-b-remove':'wms-a-remove'))?.addEventListener('click', () => removeOverlay(side, 'wms'));
    $('#'+(isB?'wms-b-copy':'wms-a-copy'))  ?.addEventListener('click', () => copyWMS(side));
  }

  function init() {
    if (!window.L) return boom('Leaflet not loaded.');
    if (!window.AppState) return boom('AppState not found. Ensure app.js loads before opg-gibs-overlays.js');
    wire('A'); wire('B');
    log('overlay controls ready', { hasA: !!getMap('A'), hasB: !!getMap('B') });
  }

  // Wait for DOM and (in case) retry a little while for AppState to appear
  function initWhenReady(attempt=0) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => initWhenReady(attempt), { once: true });
      return;
    }
    if (window.AppState && window.L) return init();
    if (attempt < 20) return setTimeout(() => initWhenReady(attempt+1), 100);
    boom('AppState not found after waiting. Did you expose window.AppState in app.js and load this file after app.js?');
  }
  initWhenReady();
})();
