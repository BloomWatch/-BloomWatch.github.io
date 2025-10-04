// FloraCast - Main application script (EN)
// All UI strings, comments, and labels are in English.
// Visual style, colors, and other functionalities not mentioned remain unchanged.

/* =========================================================
 * Global configuration
 * =======================================================*/
const CONFIG = {
    // Default location: Washington, DC
    INIT: { lat: 38.9072, lng: -77.0369 },
    YEAR: new Date().getUTCFullYear(),

    // Base map
    OSM: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',

    // NASA GIBS WMTS config
    GIBS_TM: 'GoogleMapsCompatible_Level9',
    GIBS_URL: (layer, dateISO, ext) =>
        `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${dateISO}/${CONFIG.GIBS_TM}/{z}/{y}/{x}.${ext}`,

    // MODIS RST API
    RST: 'https://modis.ornl.gov/rst/api/v1',

    // OpenAI API config (using provided de-obfuscation)
    OPENAI_BASE: 'https://api.openai.com/v1',
    OPENAI_MODEL: 'gpt-4o-mini'
};

/* =========================================================
 * App-wide state
 * =======================================================*/
const AppState = {
    // Maps
    map: null,        // Map A
    mapB: null,       // Map B (compare mode)
    syncing: false,   // View synchronization flag

    // Markers
    currentMarker: null,   // Marker on map A
    currentMarkerB: null,  // Mirror marker on map B

    // Panels / UI
    currentPanel: null,
    menuOpen: false,

    // Overlays
    gibsLayerA: null,
    gibsLayerB: null,

    // Heatmaps (exactly one per map)
    heatLayerA: null,
    heatLayerB: null,
    heatTypeA: 'off', // 'off' | 'ndvi' | 'evi' | 't2m' | 'precip'
    heatTypeB: 'off',

    // Photos/iNat
    inatActive: false,
    inatIndex: new Map(),
    inatMarkerLayer: null,
    inatHeatLayer: null,

    // AI chat
    chatHistory: [],

    // Data cache for AI & heatmaps (keyed by rounded lat,lng)
    dataCache: new Map() // key: `${lat.toFixed(3)},${lng.toFixed(3)}`
};
// expose globals for other scripts

// Ensure external overlay endpoints exist on CONFIG
CONFIG.OPG_BASE = CONFIG.OPG_BASE || 'https://weather.openportguide.de/tiles/actual';
CONFIG.GIBS_WMS_BASE = CONFIG.GIBS_WMS_BASE || (srs => (
  String(srs) === '4326'
    ? 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
    : 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi'
));

// Expose globals for the overlay script
window.CONFIG   = CONFIG;
window.AppState = AppState;


/* =========================================================
 * Utilities
 * =======================================================*/
const Utils = {
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),

    genDates: (year, step) => {
        // Generate ISO dates for a whole year with step = days
        const arr = [];
        const d0 = new Date(`${year}-01-01T00:00:00Z`);
        const d1 = new Date(`${year}-12-31T00:00:00Z`);
        for (let d = new Date(d0); d <= d1; d.setUTCDate(d.getUTCDate() + step)) {
            arr.push(d.toISOString().slice(0, 10)); // YYYY-MM-DD
        }
        if (arr[arr.length - 1] !== `${year}-12-31`) {
            arr.push(`${year}-12-31`);
        }
        return arr;
    },

    doyToDate: (year, doy) => {
        const d = new Date(Date.UTC(year, 0, 1));
        d.setUTCDate(doy);
        return d.toISOString().slice(0, 10);
    },

    numOrNull: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        if (n <= -900) return null;
        return n;
    },

    fmt: (v, digits = 4) => (v == null || isNaN(v) ? '—' : (+v).toFixed(digits))
};

/* =========================================================
 * Icons
 * =======================================================*/
const Icons = {
    selected: L.icon({
        iconUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(`
            <svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
                <circle cx="18" cy="18" r="16" fill="#3b82f6" fill-opacity="0.15" stroke="#60a5fa" stroke-width="2"/>
                <circle cx="18" cy="18" r="6" fill="#3b82f6"/>
                <circle cx="18" cy="18" r="2.5" fill="white"/>
            </svg>`),
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        popupAnchor: [0, -18]
    }),

    flower: L.icon({
        iconUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(`
            <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
                <g transform="translate(14,14)">
                    <circle r="4" fill="#f59e0b"/>
                    <g fill="#ef4444">
                        <circle cx="0" cy="-8" r="4"/>
                        <circle cx="0" cy="8" r="4"/>
                        <circle cx="8" cy="0" r="4"/>
                        <circle cx="-8" cy="0" r="4"/>
                        <circle cx="5.7" cy="-5.7" r="3.6"/>
                        <circle cx="-5.7" cy="-5.7" r="3.6"/>
                        <circle cx="5.7" cy="5.7" r="3.6"/>
                        <circle cx="-5.7" cy="5.7" r="3.6"/>
                    </g>
                </g>
            </svg>`),
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -14]
    })
};

/* =========================================================
 * UI Manager
 * =======================================================*/
const UIManager = {
    init() {
        this.setupMenuToggle();
        this.setupPanelControls();
        this.setupOverlay();
        this.initDateInputs();
    },

    setupMenuToggle() {
        const menuToggle = document.getElementById('menu-toggle');
        const mainMenu = document.getElementById('main-menu');
        const menuClose = document.getElementById('menu-close');

        menuToggle.addEventListener('click', () => this.toggleMenu());
        menuClose.addEventListener('click', () => this.closeMenu());

        // Panel links
        const menuLinks = document.querySelectorAll('.menu-list a');
        menuLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const panelId = link.dataset.panel;
                this.openPanel(panelId);
                this.closeMenu();
            });
        });
    },

    setupPanelControls() {
        document.querySelectorAll('.panel-close').forEach(btn => {
            btn.addEventListener('click', () => this.closePanel());
        });
    },

    setupOverlay() {
        const overlay = document.getElementById('overlay');
        overlay.addEventListener('click', () => {
            this.closeMenu();
            this.closePanel();
        });
    },

    toggleMenu() {
        const menuToggle = document.getElementById('menu-toggle');
        const mainMenu = document.getElementById('main-menu');
        const overlay = document.getElementById('overlay');

        AppState.menuOpen = !AppState.menuOpen;
        menuToggle.classList.toggle('active', AppState.menuOpen);
        mainMenu.classList.toggle('active', AppState.menuOpen);
        overlay.classList.toggle('active', AppState.menuOpen);
    },

    closeMenu() {
        if (!AppState.menuOpen) return;
        const menuToggle = document.getElementById('menu-toggle');
        const mainMenu = document.getElementById('main-menu');
        const overlay = document.getElementById('overlay');

        AppState.menuOpen = false;
        menuToggle.classList.remove('active');
        mainMenu.classList.remove('active');
        if (!AppState.currentPanel) overlay.classList.remove('active');
    },

    openPanel(panelId) {
        this.closePanel();
        const panel = document.getElementById(`${panelId}-panel`);
        const overlay = document.getElementById('overlay');

        if (panel) {
            AppState.currentPanel = panelId;
            panel.classList.add('active');
            overlay.classList.add('active');
            this.initPanel(panelId);
        }
    },

    closePanel() {
        if (!AppState.currentPanel) return;
        const panel = document.getElementById(`${AppState.currentPanel}-panel`);
        const overlay = document.getElementById('overlay');
        if (panel) panel.classList.remove('active');
        if (!AppState.menuOpen) overlay.classList.remove('active');
        AppState.currentPanel = null;

        // After closing a panel, maps may have changed visible area. Refresh sizes.
        MapManager.refreshMapSizes();
    },

    initPanel(panelId) {
        switch (panelId) {
            case 'layers': LayerManager.init(); break;
            case 'photos': PhotoManager.init(); break;
            case 'vegetation': VegetationManager.init(); break;
            case 'phenology': PhenologyManager.init(); break;
            case 'weather': WeatherManager.init(); break;
            case 'forecast':   ForecastManager.init(); break;
            case 'ai': AIManager.init(); break;
        }
        // When opening a panel, overlay appears; refresh map sizes to keep views centered.
        MapManager.refreshMapSizes();
    },

    initDateInputs() {
        // Default dates
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const weatherDate = document.getElementById('weather-date');
        if (weatherDate) weatherDate.value = yesterday.toISOString().slice(0, 10);

        const photosStart = document.getElementById('photos-start');
        const photosEnd = document.getElementById('photos-end');
        if (photosStart && photosEnd) {
            const startDate = new Date(today);
            startDate.setMonth(startDate.getMonth() - 3);
            photosStart.value = startDate.toISOString().slice(0, 10);
            photosEnd.value = today.toISOString().slice(0, 10);
        }

        const layerYear = document.getElementById('layer-year');
        if (layerYear) layerYear.value = CONFIG.YEAR;
        const layerYearB = document.getElementById('layer-year-b');
        if (layerYearB) layerYearB.value = CONFIG.YEAR;
    },

    updateCurrentLocation(lat, lng) {
        const coords = document.getElementById('current-coords');
        if (coords) coords.textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
};

/* =========================================================
 * Reverse geocoding helper (best-effort using OSM Nominatim)
 * =======================================================*/
const Geo = {
    async reverseGeocode(lat, lng) {
        const url = new URL('https://nominatim.openstreetmap.org/reverse');
        url.search = new URLSearchParams({
            format: 'jsonv2',
            lat: String(lat),
            lon: String(lng),
            zoom: '10',
            addressdetails: '1',
            'accept-language': 'en'
        }).toString();

        try {
            const resp = await fetch(url.toString(), {
                headers: { 'Accept': 'application/json' }
            });
            if (!resp.ok) throw new Error(`Reverse geocode failed: ${resp.status}`);
            const data = await resp.json();
            return data.display_name || null;
        } catch (e) {
            console.warn('Reverse geocoding error:', e.message);
            return null;
        }
    }
};

/* =========================================================
 * Map Manager (single + compare mode)
 * =======================================================*/
const MapManager = {
    init() {
        this.createMapA();
        this.attachMapEvents(AppState.map, 'A');
        this.setInitialLocation();
        this.setupCompareButtons();
    },

    createMapA() {
        AppState.map = L.map('map', {
            center: [CONFIG.INIT.lat, CONFIG.INIT.lng],
            zoom: 10,
            zoomControl: true
        });
        L.tileLayer(CONFIG.OSM, { attribution: '© OpenStreetMap contributors' }).addTo(AppState.map);
    },

    createMapB() {
        if (AppState.mapB) return;
        // Show second pane
        document.getElementById('map-b').classList.remove('hidden');

        // Mark container as dual to enforce left/right centering
        document.getElementById('map-wrap').classList.add('dual');

        // Create map B with same view as A
        const view = AppState.map.getCenter();
        const zoom = AppState.map.getZoom();

        AppState.mapB = L.map('map-b', {
            center: view,
            zoom: zoom,
            zoomControl: false
        });
        L.tileLayer(CONFIG.OSM, { attribution: '© OpenStreetMap contributors' }).addTo(AppState.mapB);

        // Mirror marker
        const loc = this.getCurrentLocation();
        this.ensureMarkerOnBoth(loc.lat, loc.lng);

        // Sync views
        this.enableSync();

        // Hook events
        this.attachMapEvents(AppState.mapB, 'B');

        // Resize/center correction after layout change
        this.refreshMapSizes();

        // Ensure B layer UI reflects defaults
        LayerManager.updateDateSlider('B');
        LayerManager.updateLayer('B');
        LayerManager.updateHeatmap('B'); // apply current selection for Map B heatmap
    },

    destroyMapB() {
        if (!AppState.mapB) return;

        // Remove B overlays
        if (AppState.gibsLayerB) {
            AppState.mapB.removeLayer(AppState.gibsLayerB);
            AppState.gibsLayerB = null;
        }

        // Remove B heatmap
        if (AppState.heatLayerB) {
            AppState.mapB.removeLayer(AppState.heatLayerB);
            AppState.heatLayerB = null;
            AppState.heatTypeB = 'off';
        }

        // Remove B marker
        if (AppState.currentMarkerB) {
            AppState.mapB.removeLayer(AppState.currentMarkerB);
            AppState.currentMarkerB = null;
        }

        // Disable sync
        this.disableSync();

        // Destroy map
        AppState.mapB.remove();
        AppState.mapB = null;

        // Hide pane and revert layout to single map
        document.getElementById('map-b').classList.add('hidden');
        document.getElementById('map-wrap').classList.remove('dual');

        // Resize/center correction after layout change
        this.refreshMapSizes();
    },

    setupCompareButtons() {
        const onBtn = document.getElementById('compare-on');
        const offBtn = document.getElementById('compare-off');
        const controlsB = document.getElementById('layer-controls-b');

        if (onBtn) onBtn.addEventListener('click', () => {
            this.createMapB();
            controlsB?.classList.remove('hidden');
        });

        if (offBtn) offBtn.addEventListener('click', () => {
            this.destroyMapB();
            controlsB?.classList.add('hidden');
        });
    },

    attachMapEvents(map, which) {
        map.on('click', (e) => this.setMarker(e.latlng.lat, e.latlng.lng));
    },

    enableSync() {
        if (!AppState.map || !AppState.mapB) return;
        const syncAtoB = () => {
            if (AppState.syncing) return;
            AppState.syncing = true;
            const c = AppState.map.getCenter();
            const z = AppState.map.getZoom();
            AppState.mapB.setView(c, z, { animate: false });
            AppState.syncing = false;
        };
        const syncBtoA = () => {
            if (AppState.syncing) return;
            AppState.syncing = true;
            const c = AppState.mapB.getCenter();
            const z = AppState.mapB.getZoom();
            AppState.map.setView(c, z, { animate: false });
            AppState.syncing = false;
        };
        this._syncA = syncAtoB;
        this._syncB = syncBtoA;
        AppState.map.on('moveend', this._syncA);
        AppState.mapB.on('moveend', this._syncB);
    },

    disableSync() {
        if (this._syncA && AppState.map) AppState.map.off('moveend', this._syncA);
        if (this._syncB && AppState.mapB) AppState.mapB.off('moveend', this._syncB);
        this._syncA = null; this._syncB = null;
    },

    refreshMapSizes() {
        // Invalidate Leaflet sizes so each map remains visually centered after layout changes
        setTimeout(() => {
            if (AppState.map) AppState.map.invalidateSize();
            if (AppState.mapB) AppState.mapB.invalidateSize();
        }, 50);
    },

    setMarker(lat, lng) {
        // Map A
        if (AppState.currentMarker) AppState.map.removeLayer(AppState.currentMarker);
        AppState.currentMarker = L.marker([lat, lng], { icon: Icons.selected }).addTo(AppState.map);

        // Map B (if exists)
        if (AppState.mapB) {
            if (AppState.currentMarkerB) AppState.mapB.removeLayer(AppState.currentMarkerB);
            AppState.currentMarkerB = L.marker([lat, lng], { icon: Icons.selected }).addTo(AppState.mapB);
        }

        UIManager.updateCurrentLocation(lat, lng);
        this.onLocationUpdate(lat, lng);
    },

    ensureMarkerOnBoth(lat, lng) {
        // Helper to place marker on both maps (used when enabling compare)
        if (!AppState.currentMarker) {
            AppState.currentMarker = L.marker([lat, lng], { icon: Icons.selected }).addTo(AppState.map);
        }
        if (AppState.mapB) {
            if (AppState.currentMarkerB) AppState.mapB.removeLayer(AppState.currentMarkerB);
            AppState.currentMarkerB = L.marker([lat, lng], { icon: Icons.selected }).addTo(AppState.mapB);
        }
    },

    setInitialLocation() {
        this.setMarker(CONFIG.INIT.lat, CONFIG.INIT.lng);
    },

    onLocationUpdate(lat, lng) {
        if (AppState.currentPanel === 'weather') {
            WeatherManager.updateLocation(lat, lng);
        }
        if (AppState.currentPanel === 'vegetation') {
            VegetationManager.updateLocation(lat, lng);
        }
        // When photos are active, reload around the selected point
        if (AppState.inatActive) {
            PhotoManager.loadPhotosAroundPoint();
        }
        // Refresh heatmaps around the new point (if enabled)
        LayerManager.refreshHeatmap('A');
        LayerManager.refreshHeatmap('B');
    },

    getCurrentLocation() {
        if (AppState.currentMarker) {
            const latlng = AppState.currentMarker.getLatLng();
            return { lat: latlng.lat, lng: latlng.lng };
        }
        return CONFIG.INIT;
    }
};

/* =========================================================
 * Layer Manager (supports Map A and Map B)
 * =======================================================*/
const LayerManager = {
    init() {
        this.setupControls('A');
        this.setupControls('B'); // will attach only if B controls exist
        this.updateDateSlider('A');
        this.updateDateSlider('B');
        this.updateLayer('A');
    },

    // Resolve DOM elements by map side
    _els(side) {
        const suf = side === 'B' ? '-b' : '';
        return {
            layerSelect: document.getElementById(`main-layer${suf}`),
            yearInput: document.getElementById(`layer-year${suf}`),
            dateSlider: document.getElementById(`layer-date${suf}`),
            dateLabel: document.getElementById(`layer-date-label${suf}`),
            opacitySlider: document.getElementById(`layer-opacity${suf}`),
            heatmapSelect: document.getElementById(`heatmap-${side === 'B' ? 'b' : 'a'}`) // may be null if UI not present
        };
    },

    setupControls(side) {
        const { layerSelect, yearInput, dateSlider, opacitySlider, heatmapSelect } = this._els(side);
        if (!layerSelect && side === 'B') return; // B controls may not be present yet

        if (layerSelect) layerSelect.addEventListener('change', () => this.updateLayer(side));
        if (yearInput) yearInput.addEventListener('change', () => { this.updateDateSlider(side); this.updateLayer(side); });
        if (dateSlider) dateSlider.addEventListener('input', () => { this.updateDateLabel(side); this.updateLayer(side); });
        if (opacitySlider) opacitySlider.addEventListener('input', () => this.updateLayer(side));
        if (heatmapSelect) heatmapSelect.addEventListener('change', () => this.updateHeatmap(side)); // NEW
        // Compare buttons handled by MapManager
    },

    updateDateSlider(side = 'A') {
        const { yearInput, dateSlider } = this._els(side);
        if (!yearInput || !dateSlider) return;
        const year = parseInt(yearInput.value) || CONFIG.YEAR;
        const dates = Utils.genDates(year, 1);
        dateSlider.max = dates.length - 1;
        if (dateSlider.value > dates.length - 1) dateSlider.value = dates.length - 1;
        this.updateDateLabel(side);
    },

    updateDateLabel(side = 'A') {
        const { yearInput, dateSlider, dateLabel } = this._els(side);
        if (!yearInput || !dateSlider || !dateLabel) return;
        const year = parseInt(yearInput.value) || CONFIG.YEAR;
        const dates = Utils.genDates(year, 1);
        const index = parseInt(dateSlider.value);
        if (dates[index]) dateLabel.textContent = dates[index];
    },

    updateLayer(side = 'A') {
        const els = this._els(side);
        const { layerSelect, yearInput, dateSlider, opacitySlider } = els;
        if (!layerSelect || !yearInput || !dateSlider || !opacitySlider) return;

        // Remove existing overlay on the corresponding map
        const isB = (side === 'B');
        const map = isB ? AppState.mapB : AppState.map;
        if (!map) return;

        const targetLayerKey = isB ? 'gibsLayerB' : 'gibsLayerA';
        const existing = AppState[targetLayerKey];
        if (existing) {
            map.removeLayer(existing);
            AppState[targetLayerKey] = null;
        }

        // Parse layer selection
        const layerInfo = layerSelect.value.split('|');
        if (layerInfo[0] === 'STD_OSM') return; // no overlay

        const year = parseInt(yearInput.value) || CONFIG.YEAR;
        const dates = Utils.genDates(year, 1);
        const index = parseInt(dateSlider.value);
        const opacity = parseFloat(opacitySlider.value);

        if (dates[index]) {
            // Use ISO date with dashes for GIBS
            const dateISO = dates[index]; // YYYY-MM-DD
            const url = CONFIG.GIBS_URL(layerInfo[0], dateISO, layerInfo[1]);

            // Set maxNativeZoom to 9 for GIBS overlays
            const overlay = L.tileLayer(url, {
                opacity,
                attribution: 'NASA GIBS',
                maxNativeZoom: 9,
                crossOrigin: true
            }).addTo(map);

            AppState[targetLayerKey] = overlay;
        }
    },

    // ---- Heatmap helpers (NEW) ----
    async updateHeatmap(side = 'A') {
        const { heatmapSelect } = this._els(side);
        if (!heatmapSelect) return;

        const type = heatmapSelect.value; // 'off' | 'ndvi' | 'evi' | 't2m' | 'precip'
        const isB = side === 'B';
        const map = isB ? AppState.mapB : AppState.map;
        if (!map) return;

        // Close previous heatmap (only one per map)
        const layerKey = isB ? 'heatLayerB' : 'heatLayerA';
        const typeKey  = isB ? 'heatTypeB'  : 'heatTypeA';

        if (AppState[layerKey]) {
            map.removeLayer(AppState[layerKey]);
            AppState[layerKey] = null;
        }
        AppState[typeKey] = type;

        if (type === 'off') return;

        // Build & add heat layer
        const points = await HeatmapHelper.buildPointsAroundSelection(type, map);
        if (!points.length) return;

        const hl = L.heatLayer(points, { radius: 28, blur: 20, maxZoom: 15 });
        hl.addTo(map);
        AppState[layerKey] = hl;
    },

    async refreshHeatmap(side = 'A') {
        // Rebuild current heatmap for this map if it is active
        const isB = side === 'B';
        const type = isB ? AppState.heatTypeB : AppState.heatTypeA;
        if (!type || type === 'off') return;
        await this.updateHeatmap(side);
    }
};

/* =========================================================
 * HeatmapHelper (NEW): fetch small grid of values around selected point
 * =======================================================*/
const HeatmapHelper = {
    // Grid config: 4x4 within ~0.4° box (~40 km at mid lat)
    gridSize: 4,
    halfSpanDeg: 0.4,

    // Cache for latest VI composite date
    _latestVIDate: null,
    _latestVIProduct: 'MOD13Q1',

    async buildPointsAroundSelection(type, map) {
        const { lat, lng } = MapManager.getCurrentLocation();
        const pts = this._grid(lat, lng);
        let values = [];

        if (type === 'ndvi' || type === 'evi') {
            const date = await this._getLatestVIDate();
            values = await this._pool(pts.map(p => () => this._fetchVIAt(p.lat, p.lng, date, type)), 4);
            // normalize NDVI/EVI to [0,1]
            const norm = (v) => v == null ? 0 : Utils.clamp((v + 0.1) / 0.7, 0, 1);
            return values.filter(v => v.val != null).map(v => [v.lat, v.lng, norm(v.val)]);
        }

        if (type === 't2m' || type === 'precip') {
            const now = new Date();
            const end = this._ymd(now);
            const startDate = new Date(now); startDate.setDate(now.getDate() - 29);
            const start = this._ymd(startDate);
            values = await this._pool(pts.map(p => () => this._fetchPowerAgg(p.lat, p.lng, start, end)), 4);
            if (type === 't2m') {
                // Temperature (30d mean): map [-10..35]C to [0..1]
                const normT = (v) => v == null ? 0 : Utils.clamp((v + 10) / 45, 0, 1);
                return values.filter(v => v.t2m_mean != null).map(v => [v.lat, v.lng, normT(v.t2m_mean)]);
            } else {
                // Precip (30d total): map [0..200]mm to [0..1]
                const normP = (v) => v == null ? 0 : Utils.clamp(v / 200, 0, 1);
                return values.filter(v => v.precip_sum != null).map(v => [v.lat, v.lng, normP(v.precip_sum)]);
            }
        }

        return [];
    },

    _grid(lat, lng) {
        const n = this.gridSize;
        const hs = this.halfSpanDeg;
        const step = (2 * hs) / (n - 1);
        const arr = [];
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                arr.push({ lat: lat - hs + i * step, lng: lng - hs + j * step });
            }
        }
        return arr;
    },

    async _getLatestVIDate() {
        if (this._latestVIDate) return this._latestVIDate;
        const { lat, lng } = MapManager.getCurrentLocation();
        const json = await VegetationManager.fetchDates(this._latestVIProduct, lat, lng);
        const arr = json?.dates || [];
        this._latestVIDate = arr.length ? (arr[arr.length - 1]?.modis_date || arr[arr.length - 1]) : null;
        return this._latestVIDate;
    },

    async _fetchVIAt(lat, lng, modisDate, viType) {
        try {
            const subset = await VegetationManager.fetchSubset(this._latestVIProduct, lat, lng, modisDate, modisDate);
            const bands = subset?.subset || [];
            const match = bands.find(b => (b.band || '').toLowerCase().includes(viType)); // 'ndvi' or 'evi'
            const raw = Array.isArray(match?.data) ? match.data[0] : match?.data;
            const val = raw == null || raw <= -9000 ? null : Number(raw) * 0.0001;
            return { lat, lng, val };
        } catch (_) {
            return { lat, lng, val: null };
        }
    },

    async _fetchPowerAgg(lat, lng, startYmd, endYmd) {
        try {
            const url = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
            url.search = new URLSearchParams({
                parameters: 'T2M,PRECTOTCORR',
                community: 'AG',
                longitude: String(lng),
                latitude: String(lat),
                start: startYmd,
                end: endYmd,
                format: 'JSON'
            }).toString();
            const r = await fetch(url);
            if (!r.ok) throw new Error('POWER fail');
            const data = await r.json();
            const T = Object.values(data?.properties?.parameter?.T2M || {}).map(v => Utils.numOrNull(v)).filter(v => v != null);
            const P = Object.values(data?.properties?.parameter?.PRECTOTCORR || {}).map(v => Utils.numOrNull(v)).filter(v => v != null);
            const mean = T.length ? (T.reduce((a,b)=>a+b,0) / T.length) : null;
            const sumP = P.length ? (P.reduce((a,b)=>a+b,0)) : null;
            return { lat, lng, t2m_mean: mean, precip_sum: sumP };
        } catch (_) {
            return { lat, lng, t2m_mean: null, precip_sum: null };
        }
    },

    _ymd(d) {
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth()+1).padStart(2,'0');
        const dd = String(d.getUTCDate()).padStart(2,'0');
        return `${y}${m}${dd}`;
    },

    // small async pool to limit concurrency
    async _pool(tasks, limit = 4) {
        const ret = [];
        let i = 0;
        const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
            while (i < tasks.length) {
                const t = tasks[i++];
                const v = await t();
                ret.push(v);
            }
        });
        await Promise.all(workers);
        return ret;
    }
};

/* =========================================================
 * Photo Manager (iNaturalist): load around selected point first
 * =======================================================*/
const PhotoManager = {
    init() {
        this.setupControls();
    },

    setupControls() {
        const onBtn = document.getElementById('photos-on');
        const offBtn = document.getElementById('photos-off');
        const heatmapCheck = document.getElementById('photos-heatmap');

        if (onBtn) onBtn.addEventListener('click', () => this.enablePhotos());
        if (offBtn) offBtn.addEventListener('click', () => this.disablePhotos());
        if (heatmapCheck) heatmapCheck.addEventListener('change', () => this.toggleHeatmap());
    },

    async enablePhotos() {
        if (AppState.inatActive) return;
        AppState.inatActive = true;
        this.clearLayers();
        this.ensureLayers();

        try {
            await this.loadPhotosAroundPoint(); // start near selected point
            this.setupMapListener();
        } catch (error) {
            console.error('Failed to load photos:', error);
            AppState.inatActive = false;
        }
    },

    disablePhotos() {
        AppState.inatActive = false;
        this.clearLayers();
        this.removeMapListener();
        AppState.inatIndex.clear();
        const stats = document.getElementById('photos-stats');
        if (stats) stats.textContent = '—';
    },

    toggleHeatmap() {
        if (!AppState.inatActive) return;
        this.ensureLayers();
        this.renderPhotos();
    },

    ensureLayers() {
        const useHeatmap = document.getElementById('photos-heatmap')?.checked;

        if (useHeatmap) {
            if (AppState.inatMarkerLayer) {
                AppState.map.removeLayer(AppState.inatMarkerLayer);
                AppState.inatMarkerLayer = null;
            }
            if (!AppState.inatHeatLayer) {
                AppState.inatHeatLayer = L.heatLayer([], { radius: 25 }).addTo(AppState.map);
            }
        } else {
            if (AppState.inatHeatLayer) {
                AppState.map.removeLayer(AppState.inatHeatLayer);
                AppState.inatHeatLayer = null;
            }
            if (!AppState.inatMarkerLayer) {
                AppState.inatMarkerLayer = L.markerClusterGroup().addTo(AppState.map);
            }
        }
    },

    clearLayers() {
        if (AppState.inatMarkerLayer) {
            AppState.map.removeLayer(AppState.inatMarkerLayer);
            AppState.inatMarkerLayer = null;
        }
        if (AppState.inatHeatLayer) {
            AppState.map.removeLayer(AppState.inatHeatLayer);
            AppState.inatHeatLayer = null;
        }
    },

    // Load around the currently selected point
    async loadPhotosAroundPoint() {
        const { lat, lng } = MapManager.getCurrentLocation();
        const startDate = document.getElementById('photos-start')?.value;
        const endDate = document.getElementById('photos-end')?.value;
        const taxon = parseInt(document.getElementById('photos-taxon')?.value) || 47125;
        const maxPages = Utils.clamp(parseInt(document.getElementById('photos-max-pages')?.value) || 5, 1, 20);
        const radiusKm = Utils.clamp(parseInt(document.getElementById('photos-radius')?.value) || 25, 1, 200);

        let added = 0;
        let pages = 0;

        try {
            for (let page = 1; page <= maxPages; page++) {
                const observations = await this.fetchINatNearby(lat, lng, radiusKm, startDate, endDate, taxon, page, 200);
                pages++;
                if (!observations.length) break;

                for (const obs of observations) {
                    const id = obs.id;
                    if (AppState.inatIndex.has(id)) continue;

                    const latV = obs.geojson?.coordinates?.[1] ?? obs.location?.split(',')[0];
                    const lngV = obs.geojson?.coordinates?.[0] ?? obs.location?.split(',')[1];
                    if (!Number.isFinite(+latV) || !Number.isFinite(+lngV)) continue;

                    const species = obs.taxon?.preferred_common_name || obs.taxon?.name || '—';
                    const date = (obs.observed_on_details?.date || obs.observed_on || '').slice(0, 10);
                    const url = obs.uri || `https://www.inaturalist.org/observations/${id}`;
                    const thumb = obs.photos?.[0]?.url?.replace('square', 'small') || null;

                    AppState.inatIndex.set(id, { lat: +latV, lng: +lngV, species, date, url, thumb });
                    added++;
                }
                this.renderPhotos();
            }
        } catch (error) {
            console.error('Error loading iNaturalist data:', error);
        }

        const stats = document.getElementById('photos-stats');
        if (stats) {
            stats.textContent = `Loaded ${AppState.inatIndex.size} records (+${added}, pages ${pages}/${maxPages})`;
        }
    },

    // Keep this for moveend updates; still centers near current marker
    setupMapListener() {
        this.mapMoveHandler = () => this.loadPhotosAroundPoint();
        AppState.map.on('moveend', this.mapMoveHandler);
    },

    removeMapListener() {
        if (this.mapMoveHandler) {
            AppState.map.off('moveend', this.mapMoveHandler);
            this.mapMoveHandler = null;
        }
    },

    async fetchINatNearby(lat, lng, radiusKm, startDate, endDate, taxon, page, perPage) {
        const url = new URL('https://api.inaturalist.org/v1/observations');
        const params = {
            geo: true,
            photos: true,
            verifiable: true,
            lat: lat,
            lng: lng,
            radius: radiusKm, // kilometers
            taxon_id: taxon,
            per_page: perPage,
            page: page
        };
        if (startDate) params.d1 = startDate;
        if (endDate) params.d2 = endDate;

        url.search = new URLSearchParams(params).toString();
        const response = await fetch(url.toString());
        if (!response.ok) throw new Error(`iNaturalist API error: ${response.status}`);
        const data = await response.json();
        return data.results || [];
    },

    renderPhotos() {
        const useHeatmap = document.getElementById('photos-heatmap')?.checked;

        if (useHeatmap && AppState.inatHeatLayer) {
            const points = Array.from(AppState.inatIndex.values()).map(item => [item.lat, item.lng]);
            AppState.inatHeatLayer.setLatLngs(points);
        } else if (AppState.inatMarkerLayer) {
            AppState.inatMarkerLayer.clearLayers();
            for (const item of AppState.inatIndex.values()) {
                const marker = L.marker([item.lat, item.lng], { icon: Icons.flower });
                const popupContent = `
                    <div>
                        <strong>${item.species}</strong><br>
                        Date: ${item.date}<br>
                        <a href="${item.url}" target="_blank">View Details</a>
                        ${item.thumb ? `<br><img src="${item.thumb}" style="max-width: 150px; margin-top: 5px;">` : ''}
                    </div>`;
                marker.bindPopup(popupContent);
                AppState.inatMarkerLayer.addLayer(marker);
            }
        }
    }
};

/* =========================================================
 * Vegetation Manager
 * =======================================================*/
const VegetationManager = {
    init() { this.setupControls(); },

    setupControls() {
        const queryBtn = document.getElementById('vi-query');
        if (queryBtn) queryBtn.addEventListener('click', () => this.queryVegetationIndex());
    },

    async queryVegetationIndex() {
        const location = MapManager.getCurrentLocation();
        const product = document.getElementById('vi-product')?.value || 'MOD13Q1';
        try {
            await this.fetchVegetationIndex(location.lat, location.lng, product);
        } catch (error) {
            console.error('Failed to fetch vegetation index:', error);
            this.clearVegetationDisplay();
        }
    },

    async fetchVegetationIndex(lat, lng, product) {
        // Fetch available dates
        const dates = await this.fetchDates(product, lat, lng);
        const dateArray = dates?.dates || [];
        if (!dateArray.length) throw new Error('No composite dates available for this location');

        // Fetch latest subset
        const latestDate = dateArray[dateArray.length - 1]?.modis_date || dateArray[dateArray.length - 1];
        const subset = await this.fetchSubset(product, lat, lng, latestDate, latestDate);
        if (!subset?.subset?.length) throw new Error('Empty subset data');

        this.parseAndDisplayVegetationData(subset);
    },

    async fetchDates(product, lat, lng) {
        const url = `${CONFIG.RST}/${product}/dates?latitude=${lat}&longitude=${lng}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Dates API error: ${response.status}`);
        return response.json();
    },

    async fetchSubset(product, lat, lng, startDate, endDate) {
        const url = `${CONFIG.RST}/${product}/subset?latitude=${lat}&longitude=${lng}&startDate=${startDate}&endDate=${endDate}&kmAboveBelow=0&kmLeftRight=0`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Subset API error: ${response.status}`);
        return response.json();
    },

    parseAndDisplayVegetationData(json) {
        const grid = {};
        const arr = json?.subset || [];

        for (const item of arr) {
            const key = (item.band || '').toLowerCase();
            const val = Array.isArray(item.data) ? item.data[0] : item.data;
            grid[key] = {
                date: item.calendar_date || item.modis_date,
                raw: val,
                scaled: this.scaleValue(key, val)
            };
        }

        const tile = arr[0]?.tile || '—';
        const modisDate = arr[0]?.modis_date || null;
        const calendarDate = arr[0]?.calendar_date || null;

        const pick = (keyword) => {
            const key = Object.keys(grid).find(x => x.includes(keyword));
            return key ? grid[key] : { scaled: null, raw: null };
        };

        const ndvi = pick('ndvi').scaled;
        const evi = pick('evi').scaled;
        const red = pick('red_reflectance').scaled;
        const nir = pick('nir_reflectance').scaled;
        const blue = pick('blue_reflectance').scaled;
        const mir = pick('mir_reflectance').scaled;
        const reliability = pick('pixel_reliability').raw;
        const viQuality = pick('vi_quality').raw;

        this.updateVegetationDisplay({
            date: calendarDate || modisDate,
            tile,
            ndvi, evi, red, nir, blue, mir,
            reliability, viQuality
        });
    },

    scaleValue(bandName, raw) {
        if (raw == null) return null;
        const n = Number(raw);
        if (n <= -9000) return null; // fill / invalid
        const b = (bandName || '').toLowerCase();
        if (b.includes('reflectance')) return n * 0.0001;
        if (b.includes('ndvi') || b.includes('evi')) return n * 0.0001;
        if (b.includes('zenith') || b.includes('azimuth')) return n * 0.01;
        return n;
    },

    updateVegetationDisplay(data) {
        const elements = {
            'vi-meta': `Date: ${data.date || '—'}, Tile: ${data.tile}`,
            'vi-quality': this.getQualityBadge(data.reliability, data.viQuality),
            'vi-vigor': this.getVigorInfo(data.ndvi),
            'vi-ndvi': Utils.fmt(data.ndvi, 4),
            'vi-evi': Utils.fmt(data.evi, 4),
            'vi-red': Utils.fmt(data.red, 4),
            'vi-nir': Utils.fmt(data.nir, 4),
            'vi-blue': Utils.fmt(data.blue, 4),
            'vi-mir': Utils.fmt(data.mir, 4)
        };

        for (const [id, content] of Object.entries(elements)) {
            const element = document.getElementById(id);
            if (!element) continue;
            if (id === 'vi-quality' || id === 'vi-vigor') element.innerHTML = content;
            else element.textContent = content;
        }
    },

    getQualityBadge(reliability, viQuality) {
        const reliabilityMap = {
            0: ['Good', 'b-good'],
            1: ['Marginal', 'b-marg'],
            2: ['Snow/Ice', 'b-snow'],
            3: ['Cloud', 'b-cloud']
        };
        let result = '';
        if (reliability != null) {
            const [label] = reliabilityMap[Number(reliability)] || ['Unknown', ''];
            result += `<span class="badge">${label} (${reliability})</span>`;
        }
        if (viQuality != null) {
            result += (result ? ' · ' : '') + `VI Quality=${viQuality}`;
        }
        return result || '—';
    },

    getVigorInfo(ndvi) {
        if (ndvi == null || isNaN(ndvi)) return '<span class="vig-verylow">Unknown</span>';

        let label, cls;
        if (ndvi < 0.2)       { label = 'Very Low (Bare/Urban)'; cls = 'vig-verylow'; }
        else if (ndvi < 0.3)  { label = 'Low'; cls = 'vig-low'; }
        else if (ndvi < 0.5)  { label = 'Moderate'; cls = 'vig-medium'; }
        else if (ndvi < 0.7)  { label = 'High'; cls = 'vig-high'; }
        else                  { label = 'Very High'; cls = 'vig-veryhigh'; }
        return `<span class="${cls}">${label}</span> (NDVI=${Utils.fmt(ndvi, 3)})`;
    },

    clearVegetationDisplay() {
        const ids = ['vi-meta', 'vi-quality', 'vi-vigor', 'vi-ndvi', 'vi-evi', 'vi-red', 'vi-nir', 'vi-blue', 'vi-mir'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            if (id === 'vi-quality' || id === 'vi-vigor') el.innerHTML = '—';
            else el.textContent = '—';
        });
    },

    updateLocation(_lat, _lng) {
        // Could auto-refresh when location changes if needed
        // this.queryVegetationIndex();
    }
};

/* =========================================================
 * Phenology Manager
 * =======================================================*/
const PhenologyManager = {
    init() { this.setupControls(); },

    setupControls() {
        const calcBtn = document.getElementById('phenology-calc');
        if (calcBtn) calcBtn.addEventListener('click', () => this.calculatePhenology());
    },

    async calculatePhenology() {
        const location = MapManager.getCurrentLocation();
        theYear = parseInt(document.getElementById('layer-year')?.value) || CONFIG.YEAR;

        try {
            const dailyData = await this.fetchPOWERDaily(location.lat, location.lng, theYear);
            this.calculateFlowerPredictions(dailyData, theYear);
            this.plotTemperatureChart(dailyData);
        } catch (error) {
            console.error('Failed to calculate phenology:', error);
            alert('Computation failed. Please try again later.');
        }
    },

    async fetchPOWERDaily(lat, lng, year) {
        const url = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
        url.search = new URLSearchParams({
            parameters: 'T2M,T2M_MIN,T2M_MAX,PRECTOTCORR',
            community: 'AG',
            longitude: String(lng),
            latitude: String(lat),
            start: `${year}0101`,
            end: `${year}1231`,
            format: 'JSON'
        }).toString();

        const response = await fetch(url.toString());
        if (!response.ok) throw new Error(`POWER API error: ${response.status}`);

        const data = await response.json();
        const params = data?.properties?.parameter || {};
        const dates = Object.keys(params?.T2M || {}).sort();

        return dates.map(d => ({
            date: d,
            T2M: Utils.numOrNull(params.T2M[d]),
            T2M_MIN: Utils.numOrNull(params.T2M_MIN?.[d]),
            T2M_MAX: Utils.numOrNull(params.T2M_MAX?.[d]),
            P: Utils.numOrNull(params.PRECTOTCORR?.[d])
        }));
    },

    calculateFlowerPredictions(dailyData, year) {
        const temps = dailyData.map(d => d.T2M);
        const tbody = document.querySelector('#flowers-table tbody');
        if (!tbody) return;

        for (const tr of tbody.querySelectorAll('tr')) {
            const baseInput = tr.children[1].querySelector('input');
            const thrInput = tr.children[2].querySelector('input');
            const predCell = tr.querySelector('.pred');
            const daysCell = tr.querySelector('.days');

            const base = parseFloat(baseInput.value);
            const threshold = parseFloat(thrInput.value);

            if (!Number.isFinite(base) || !Number.isFinite(threshold)) {
                predCell.textContent = '—';
                daysCell.textContent = '—';
                predCell.className = 'pred';
                continue;
            }

            const result = this.estimateGDD(temps, base, threshold);

            if (result.doy) {
                predCell.textContent = Utils.doyToDate(year, result.doy);
                daysCell.textContent = result.days;
                predCell.className = 'pred ok';
            } else {
                predCell.textContent = 'Not Reached';
                daysCell.textContent = '—';
                predCell.className = 'pred bad';
            }
        }
    },

    estimateGDD(tempDaily, base, threshold) {
        let accumulation = 0;
        for (let i = 0; i < tempDaily.length; i++) {
            const temp = tempDaily[i];
            if (temp == null) continue;
            accumulation += Math.max(0, temp - base);
            if (accumulation >= threshold) {
                return { doy: i + 1, days: i + 1, gdd: accumulation };
            }
        }
        return { doy: null, days: null, gdd: accumulation };
    },

    plotTemperatureChart(dailyData) {
        const chartContainer = document.getElementById('weather-chart');
        if (!chartContainer || !window.Plotly) return;

        const x = dailyData.map(r => {
            const d = r.date;
            return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
        });

        const t2m = dailyData.map(r => r.T2M);
        const precip = dailyData.map(r => r.P);

        const traces = [
            { x, y: t2m, type: 'scatter', mode: 'lines', name: 'Temperature (°C)', line: { width: 1.5 }, connectgaps: false },
            { x, y: precip, type: 'bar', name: 'Precip (mm)', yaxis: 'y2', opacity: 0.35 }
        ];

        const layout = {
            paper_bgcolor: '#334155',
            plot_bgcolor: '#334155',
            margin: { l: 48, r: 48, t: 24, b: 32 },
            xaxis: { title: 'Date', color: '#cbd5e1' },
            yaxis: { title: 'Temperature (°C)', color: '#cbd5e1', gridcolor: '#475569' },
            yaxis2: { title: 'Precip (mm)', color: '#cbd5e1', overlaying: 'y', side: 'right', showgrid: false },
            font: { color: '#cbd5e1' },
            legend: { font: { color: '#cbd5e1' } }
        };

        Plotly.newPlot(chartContainer, traces, layout, { displayModeBar: false });
    }
};

/* =========================================================
 * Weather Manager
 * =======================================================*/
const WeatherManager = {
    init() { this.setupControls(); },

    setupControls() {
        const queryBtn = document.getElementById('weather-query');
        if (queryBtn) queryBtn.addEventListener('click', () => this.queryWeather());
    },

    async queryWeather() {
        const location = MapManager.getCurrentLocation();
        const date = document.getElementById('weather-date')?.value;
        if (!date) { alert('Please select a date.'); return; }

        try {
            await this.fetchWeatherData(location.lat, location.lng, date);
        } catch (error) {
            console.error('Failed to fetch weather data:', error);
            this.updateWeatherDisplay('Temp: — °C, Precip: — mm (failed)');
        }
    },

    async fetchWeatherData(lat, lng, isoDate) {
        const ymd = isoDate.replace(/-/g, '');
        const url = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
        url.search = new URLSearchParams({
            parameters: 'T2M,PRECTOTCORR',
            community: 'AG',
            longitude: String(lng),
            latitude: String(lat),
            start: ymd,
            end: ymd,
            format: 'JSON'
        }).toString();

        const response = await fetch(url);
        if (!response.ok) throw new Error(`POWER API error: ${response.status}`);

        const data = await response.json();
        const params = data?.properties?.parameter || {};

        const temp = Utils.numOrNull(Object.values(params.T2M || {})[0]);
        const precip = Utils.numOrNull(Object.values(params.PRECTOTCORR || {})[0]);

        const tempStr = temp == null ? '—' : temp.toFixed(1);
        const precipStr = precip == null ? '—' : precip.toFixed(1);

        this.updateWeatherDisplay(`Temp: ${tempStr} °C, Precip: ${precipStr} mm`);
    },

    updateWeatherDisplay(text) {
        const weatherInfo = document.getElementById('weather-current');
        if (weatherInfo) weatherInfo.textContent = text;
    },

    updateLocation(_lat, _lng) {
        // Could auto-refresh weather on location updates
        // this.queryWeather();
    }
};

/* =========================================================
 * DataHub (NEW): gather 30d weather, latest VI, and phenology predictions
 * =======================================================*/
const DataHub = {
    _key(lat, lng) { return `${lat.toFixed(3)},${lng.toFixed(3)}`; },

    async collectAll(lat, lng) {
        const key = this._key(lat, lng);
        if (AppState.dataCache.has(key)) return AppState.dataCache.get(key);

        const now = new Date();
        const end = this._ymd(now);
        const startDate = new Date(now); startDate.setDate(now.getDate() - 29);
        const start = this._ymd(startDate);

        const [w30, vi, phen] = await Promise.all([
            this._fetchPowerRange(lat, lng, start, end),
            this._fetchLatestVI(lat, lng),
            this._buildPhenology(lat, lng)
        ]);

        const payload = { weather30d: w30, vegetationLatest: vi, phenology: phen };
        AppState.dataCache.set(key, payload);
        return payload;
    },

    async _fetchPowerRange(lat, lng, start, end) {
        const url = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
        url.search = new URLSearchParams({
            parameters: 'T2M,T2M_MIN,T2M_MAX,PRECTOTCORR',
            community: 'AG',
            longitude: String(lng),
            latitude: String(lat),
            start, end, format: 'JSON'
        }).toString();
        const r = await fetch(url);
        if (!r.ok) throw new Error('POWER 30d failed');
        const j = await r.json();
        const par = j?.properties?.parameter || {};
        const dates = Object.keys(par?.T2M || {}).sort();
        const rows = dates.map(d => ({
            date: d,
            T2M: Utils.numOrNull(par.T2M?.[d]),
            T2M_MIN: Utils.numOrNull(par.T2M_MIN?.[d]),
            T2M_MAX: Utils.numOrNull(par.T2M_MAX?.[d]),
            P: Utils.numOrNull(par.PRECTOTCORR?.[d])
        }));
        const mean = (arr) => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length) : null;
        const sum = (arr) => arr.length ? arr.reduce((a,b)=>a+b,0) : null;
        return {
            series: rows,
            summaries: {
                t2m_mean: mean(rows.map(r=>r.T2M).filter(v=>v!=null)),
                t2m_min_mean: mean(rows.map(r=>r.T2M_MIN).filter(v=>v!=null)),
                t2m_max_mean: mean(rows.map(r=>r.T2M_MAX).filter(v=>v!=null)),
                precip_sum: sum(rows.map(r=>r.P).filter(v=>v!=null))
            }
        };
    },

    async _fetchLatestVI(lat, lng) {
        const dates = await VegetationManager.fetchDates('MOD13Q1', lat, lng);
        const arr = dates?.dates || [];
        const latest = arr.length ? (arr[arr.length - 1]?.modis_date || arr[arr.length - 1]) : null;
        if (!latest) return null;
        const subset = await VegetationManager.fetchSubset('MOD13Q1', lat, lng, latest, latest);
        if (!subset?.subset?.length) return null;

        const grid = {};
        for (const it of subset.subset) {
            const name = (it.band || '').toLowerCase();
            const v = Array.isArray(it.data) ? it.data[0] : it.data;
            grid[name] = v;
        }
        const val = (key, scale=0.0001) => {
            const k = Object.keys(grid).find(n => n.includes(key));
            const raw = k ? Number(grid[k]) : null;
            if (raw == null || raw <= -9000) return null;
            return raw * scale;
        };

        return {
            date: subset.subset[0]?.calendar_date || subset.subset[0]?.modis_date || null,
            ndvi: val('ndvi'),
            evi: val('evi'),
            red: val('red_reflectance'),
            nir: val('nir_reflectance'),
            blue: val('blue_reflectance'),
            mir: val('mir_reflectance')
        };
    },

    async _buildPhenology(lat, lng) {
        // Use existing logic to compute predictions for current year on-the-fly
        const year = new Date().getUTCFullYear();
        const daily = await PhenologyManager.fetchPOWERDaily(lat, lng, year);
        const temps = daily.map(d => d.T2M);
        const table = Array.from(document.querySelectorAll('#flowers-table tbody tr')).map(tr => {
            const name = tr.getAttribute('data-name') || tr.children[0].textContent.trim();
            const base = parseFloat(tr.children[1].querySelector('input')?.value);
            const thr  = parseFloat(tr.children[2].querySelector('input')?.value);
            return { name, base, thr };
        });
        const estimate = (base, thr) => {
            let acc=0;
            for (let i=0;i<temps.length;i++){
                const t=temps[i]; if (t==null) continue;
                acc += Math.max(0, t-base);
                if (acc >= thr) return { doy:i+1, date: Utils.doyToDate(year, i+1), gdd: acc };
            }
            return { doy:null, date:null, gdd: acc };
        };
        return table.map(row => {
            if (!Number.isFinite(row.base) || !Number.isFinite(row.thr)) return { name: row.name, date:null, gdd:null, days:null };
            const r = estimate(row.base, row.thr);
            return { name: row.name, date: r.date, days: r.doy, gdd: r.gdd };
        });
    },

    _ymd(d) {
        const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,'0'), dd=String(d.getUTCDate()).padStart(2,'0');
        return `${y}${m}${dd}`;
    }
};

/* =========================================================
 * AI Manager
 * =======================================================*/
function removeExclamationMarks(str) { return str.replace(/！/g, ''); }
const OPENAI_BASE  = 'https://api.openai.com/v1';
const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_KEY   = removeExclamationMarks('s！k-p！roj-d-PKY！kxmzmyZ！AnHdbWH4zbJ5mnxdvi7kgVU！vMpmXSMIuBdspcdSFIiyCbocTdPVqijv！9FNjcbBT3BlbkFJU-sRcJsKqcRH！0c1v_1FNm2lBHhqTKf0aQTcf！IjjktRWAfeDWJxUz！vrUDO6YlxZ7！ESP6BY-V6UA');

const AIManager = {
  init() {
    this.setupControls();
  },

  setupControls() {
    const analyzeBtn = document.getElementById('ai-analyze');
    const askBtn = document.getElementById('ai-ask');
    if (analyzeBtn) analyzeBtn.addEventListener('click', () => this.analyzeLocation());
    if (askBtn) askBtn.addEventListener('click', () => this.askQuestion());
  },

  async buildLocationContext() {
    const { lat, lng } = MapManager.getCurrentLocation();
    const place = await Geo.reverseGeocode(lat, lng);
    const coordStr = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const where = place ? `${place} (${coordStr})` : coordStr;

    // Gather app-known context (30d weather, latest VI, phenology predictions)
    const ctx = await DataHub.collectAll(lat, lng);

    // Compact markdown block for the model
    const mdContext =
`**App Data Context**
- **Location:** ${where}
- **Weather (last 30 days):**
  - Mean T2M: ${ctx.weather30d?.summaries?.t2m_mean?.toFixed?.(2) ?? '—'} °C
  - Mean Min: ${ctx.weather30d?.summaries?.t2m_min_mean?.toFixed?.(2) ?? '—'} °C
  - Mean Max: ${ctx.weather30d?.summaries?.t2m_max_mean?.toFixed?.(2) ?? '—'} °C
  - Total Precip: ${ctx.weather30d?.summaries?.precip_sum?.toFixed?.(1) ?? '—'} mm
- **Vegetation (latest composite):**
  - Date: ${ctx.vegetationLatest?.date ?? '—'}
  - NDVI: ${ctx.vegetationLatest?.ndvi?.toFixed?.(3) ?? '—'}
  - EVI: ${ctx.vegetationLatest?.evi?.toFixed?.(3) ?? '—'}
  - Red: ${ctx.vegetationLatest?.red?.toFixed?.(4) ?? '—'}, NIR: ${ctx.vegetationLatest?.nir?.toFixed?.(4) ?? '—'}
- **Bloom Predictions (current year):**
${(ctx.phenology || []).map(p => `  - ${p.name}: ${p.date ? p.date : 'Not reached'}${p.days ? ` (${p.days} days)` : ''}`).join('\n') || '  - —'}
`;

    return { where, lat, lng, mdContext };
  },

  async analyzeLocation() {
    const { where, mdContext } = await this.buildLocationContext();
    const prompt = `Given the ${mdContext}, analyze what plants/flowers would be suitable and what not suitable to grow here considering climate (temperature, precipitation), soil considerations, and seasonal bloom timing. Provide a actionable analyze  recommendation list with reasons.`;


    return this.callAI([
      { role: 'system', content: `You are an agronomy and phenology expert. Always reply in Markdown. Be practical and concise, but include enough detail to be actionable.` },
      { role: 'system', content: `Location context: ${where}` },
      { role: 'user', content: prompt }
    ]);
  }, 

  async askQuestion() {
    const questionInput = document.getElementById('ai-question');
    const question = questionInput?.value?.trim();
    if (!question) {
      alert('Please enter a question or use the Analyze button.');
      return;
    }

    const { where, mdContext } = await this.buildLocationContext();
    const prompt = `Data：${mdContext}

You are an agronomy and phenology expert. Please reply **only in Markdown** and keep guidance flexible (avoid over-prescriptive advice). 
Using the local data above, address the user's question with concrete, location-aware recommendations.

**User question:** ${question}
`;

    return this.callAI([
      { role: 'system', content: `You are an agronomy and phenology expert. Always reply in Markdown. Be practical and concise, but include enough detail to be actionable.` },
      { role: 'system', content: `Location context: ${where}` },
      { role: 'user', content: prompt }
    ]);
  }, 

  async callAI(messages) {
    const report = document.getElementById('ai-report');
    if (report) {
      report.innerHTML = 'Thinking<span class="loading"></span>';
    }

    try {
      const resp = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages,
          temperature: 0.4
        })
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`OpenAI error: ${resp.status} - ${txt}`);
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content?.trim() || '(no content)';

      if (report) {
        if (window.marked && typeof window.marked.parse === 'function') {
          report.innerHTML = window.marked.parse(content);
        } else {
          report.innerHTML = content
            .replace(/&/g,'&amp;')
            .replace(/</g,'&lt;')
            .replace(/>/g,'&gt;')
            .replace(/\n/g,'<br>');
        }
      }
    } catch (err) {
      console.error(err);
      if (report) report.textContent = `AI failed: ${err.message}`;
    }
  }
}; 

/* =====================================================================
 * Overlays: OpenPortGuide (XYZ) & NASA GIBS (WMS) for Map A / Map B
 * - No extra JS file required; this block wires UI and loads overlays.
 * - Works with your existing AppState.map (A) and AppState.mapB (B).
 * - Auto-picks latest WMS TIME from GetCapabilities, with fallbacks.
 * ===================================================================*/
(function () {
  'use strict';

  // Ensure globals are visible (harmless if already assigned above)
  window.CONFIG   = window.CONFIG   || CONFIG;
  window.AppState = window.AppState || AppState;

  // Ensure endpoints exist (keep your existing values if already set)
  CONFIG.OPG_BASE = CONFIG.OPG_BASE || 'https://weather.openportguide.de/tiles/actual';
  CONFIG.GIBS_WMS_BASE = CONFIG.GIBS_WMS_BASE || (srs =>
    String(srs) === '4326'
      ? 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
      : 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi'
  );

  // --- small helpers ---
  const $ = (id) => document.getElementById(id);
  const getMap = (side) => side === 'B' ? (AppState.mapB || null) : (AppState.map || AppState.mapA || null);
  const setOverlay = (side, kind, layer) => { AppState[kind + (side === 'B' ? 'B' : 'A')] = layer; };
  const getOverlay = (side, kind) => AppState[kind + (side === 'B' ? 'B' : 'A')] || null;
  const removeOverlay = (side, kind) => {
    const map = getMap(side);
    const lyr = getOverlay(side, kind);
    if (map && lyr) { map.removeLayer(lyr); setOverlay(side, kind, null); }
  };
  const normalizeFormat = (v) => (typeof v === 'string' && v.startsWith('image/')) ? v : 'image/png';
  const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;

  // ---------- OpenPortGuide (XYZ, var + step) ----------
  function opgUrl(variant, step) {
    return `${CONFIG.OPG_BASE}/${variant}/${step}/{z}/{x}/{y}.png`;
  }
  function addOPG(side = 'A') {
    const map = getMap(side);
    if (!map) return alert(`Map ${side} is not active.`);

    const varSel  = $(side === 'B' ? 'opg-b-var'  : 'opg-a-var');
    const stepSel = $(side === 'B' ? 'opg-b-step' : 'opg-a-step');
    if (!varSel || !stepSel) return alert('OpenPortGuide controls not found.');

    const variant = varSel.value || 'wind_stream';
    const step    = stepSel.value || '0h';

    removeOverlay(side, 'opg');
    const layer = L.tileLayer(opgUrl(variant, step), {
      maxZoom: 18, opacity: 0.9, crossOrigin: true, attribution: 'OpenPortGuide'
    }).addTo(map);
    setOverlay(side, 'opg', layer);
    console.log('[Overlays] OPG added on', side, variant, step);
  }
  function copyOPG(side = 'A') {
    const varSel  = $(side === 'B' ? 'opg-b-var'  : 'opg-a-var');
    const stepSel = $(side === 'B' ? 'opg-b-step' : 'opg-a-step');
    const url = opgUrl(varSel?.value || 'wind_stream', stepSel?.value || '0h');
    navigator.clipboard?.writeText(url);
    alert('Tile URL copied:\n' + url);
  }

  // ---------- NASA GIBS — WMS ----------
  async function getLastWMSTime(baseUrl, layerName) {
    try {
      const txt = await fetch(`${baseUrl}?service=WMS&request=GetCapabilities&version=1.3.0`).then(r => r.text());
      const xml = new DOMParser().parseFromString(txt, 'text/xml');
      const layer = Array.from(xml.querySelectorAll('Layer > Layer'))
        .find(L => L.querySelector('Name')?.textContent?.trim() === layerName);
      if (!layer) return '';
      const node = layer.querySelector('Dimension[name="time"], Extent[name="time"]');
      if (!node) return '';
      const def = (node.getAttribute('default') || '').trim();
      const raw = (node.textContent || '').trim();
      const pickEnd = (token) => {
        token = token.trim();
        if (!token) return '';
        if (token.includes('/')) return (token.split('/')[1] || '').slice(0, 10);
        return token.slice(0, 10);
      };
      if (raw) {
        const tokens = raw.split(',').map(s => s.trim()).filter(Boolean);
        const last = pickEnd(tokens[tokens.length - 1]);
        if (last) return last;
      }
      if (def) return def.slice(0, 10);
      return '';
    } catch (e) {
      console.warn('[Overlays] GetCapabilities failed', e);
      return '';
    }
  }
  async function fallbackRecentDate(base, layer, srs, format) {
    const now = new Date();
    const cands = [];
    for (let i = 0; i <= 10; i++) { const d = new Date(now); d.setUTCDate(d.getUTCDate() - i); cands.push(iso(d)); }
    const d1 = new Date(now); d1.setUTCDate(d1.getUTCDate() - 8);  cands.push(iso(d1));
    const d2 = new Date(now); d2.setUTCDate(d2.getUTCDate() - 16); cands.push(iso(d2));
    for (const t of cands) {
      const params = new URLSearchParams({
        service: 'WMS', request: 'GetMap', version: '1.3.0',
        layers: layer, styles: '', format, transparent: 'true',
        crs: srs === '4326' ? 'EPSG:4326' : 'EPSG:3857',
        bbox: srs === '4326' ? '-90,-180,90,180' : '-20037508.34,-20037508.34,20037508.34,20037508.34',
        width: '64', height: '64', time: t
      });
      try {
        const r = await fetch(`${base}?${params.toString()}`);
        if (r.ok && (r.headers.get('content-type') || '').startsWith('image/')) return t;
      } catch {}
    }
    return '';
  }
  function copyWMS(side = 'A') {
    const projSel   = $(side === 'B' ? 'wms-b-proj'   : 'wms-a-proj');
    const fmtSel    = $(side === 'B' ? 'wms-b-format' : 'wms-a-format');
    const layerSel  = $(side === 'B' ? 'wms-b-layer'  : 'wms-a-layer');
    const timeInput = $(side === 'B' ? 'wms-b-time'   : 'wms-a-time');
    if (!projSel || !fmtSel || !layerSel) return alert('WMS controls not found.');

    const srs    = (projSel.value || '3857') === '4326' ? '4326' : '3857';
    const base   = CONFIG.GIBS_WMS_BASE(srs);
    const layer  = layerSel.value;
    const format = normalizeFormat(fmtSel.value || 'image/png');
    const time   = (timeInput?.value || '').trim();

    const params = new URLSearchParams({
      service: 'WMS', request: 'GetMap', version: '1.3.0',
      layers: layer, styles: '', format, transparent: 'true',
      crs: srs === '4326' ? 'EPSG:4326' : 'EPSG:3857',
      bbox: srs === '4326' ? '-90,-180,90,180' : '-20037508.34,-20037508.34,20037508.34,20037508.34',
      width: '512', height: '512'
    });
    if (time) params.set('time', time);

    const url = `${base}?${params.toString()}`;
    navigator.clipboard?.writeText(url);
    alert('GetMap URL copied:\n' + url);
  }
  async function addWMS(side = 'A') {
    const map = getMap(side);
    if (!map) return alert(`Map ${side} is not active.`);

    const projSel   = $(side === 'B' ? 'wms-b-proj'   : 'wms-a-proj');
    const fmtSel    = $(side === 'B' ? 'wms-b-format' : 'wms-a-format');
    const layerSel  = $(side === 'B' ? 'wms-b-layer'  : 'wms-a-layer');
    const timeInput = $(side === 'B' ? 'wms-b-time'   : 'wms-a-time');
    if (!projSel || !fmtSel || !layerSel) return alert('WMS controls not found.');

    const srs    = (projSel.value || '3857') === '4326' ? '4326' : '3857';
    const base   = CONFIG.GIBS_WMS_BASE(srs);
    const layer  = layerSel.value;
    const format = normalizeFormat(fmtSel.value || 'image/png');
    let   time   = (timeInput?.value || '').trim();

    removeOverlay(side, 'wms');

    if (!time) {
      time = await getLastWMSTime(base, layer) ||
             await fallbackRecentDate(base, layer, srs, format);
    }

    const params = { layers: layer, format, transparent: true };
    if (time) params.time = time;

    const wms = L.tileLayer.wms(base, params)
      .on('tileerror', e => console.warn('[Overlays] WMS tile error', e))
      .addTo(map);

    setOverlay(side, 'wms', wms);
    console.log('[Overlays] WMS added on', side, { layer, srs, format, time });
  }

  // ---------- Wire buttons (A/B) ----------
  function wireOverlays() {
    // Map A — OPG
    $('opg-a-add')    ?.addEventListener('click', () => addOPG('A'));
    $('opg-a-remove') ?.addEventListener('click', () => removeOverlay('A', 'opg'));
    $('opg-a-copy')   ?.addEventListener('click', () => copyOPG('A'));
    // Map A — WMS
    $('wms-a-add')    ?.addEventListener('click', () => addWMS('A'));
    $('wms-a-remove') ?.addEventListener('click', () => removeOverlay('A', 'wms'));
    $('wms-a-copy')   ?.addEventListener('click', () => copyWMS('A'));

    // Map B — OPG
    $('opg-b-add')    ?.addEventListener('click', () => addOPG('B'));
    $('opg-b-remove') ?.addEventListener('click', () => removeOverlay('B', 'opg'));
    $('opg-b-copy')   ?.addEventListener('click', () => copyOPG('B'));
    // Map B — WMS
    $('wms-b-add')    ?.addEventListener('click', () => addWMS('B'));
    $('wms-b-remove') ?.addEventListener('click', () => removeOverlay('B', 'wms'));
    $('wms-b-copy')   ?.addEventListener('click', () => copyWMS('B'));

    console.log('[Overlays] handlers wired. maps:', !!getMap('A'), !!getMap('B'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireOverlays, { once: true });
  } else {
    wireOverlays();
  }

  // Optional: expose to console for debugging
  window.Overlays = { addOPG, addWMS, removeOverlay, copyOPG, copyWMS };
})();






/* =========================================================
 * ForecastManager — NDVI/EVI 30-day prediction (in-app)
 * 依赖：MapManager, VegetationManager, Utils；Plotly（画图），tf.js（可选）
 * =======================================================*/
const ForecastManager = {
  init() {
    // 只做一次事件绑定
    if (this._bound) return;
    this._bound = true;

    const trainBtn = document.getElementById('fc-train');
    const clearBtn = document.getElementById('fc-clear');
    if (trainBtn) trainBtn.addEventListener('click', () => this.run());
    if (clearBtn) clearBtn.addEventListener('click', () => this.clear());
  },

  async run() {
    const statsEl = document.getElementById('fc-stats');
    const product = document.getElementById('fc-product')?.value || 'MOD13Q1';
    const target  = document.getElementById('fc-target')?.value  || 'ndvi'; // 'ndvi'|'evi'
    const years   = Math.max(1, Math.min(8, parseInt(document.getElementById('fc-years')?.value || '3')));
    const epochs  = Math.max(20, Math.min(1000, parseInt(document.getElementById('fc-epochs')?.value || '120')));
    const lr      = Math.max(0.001, Math.min(0.1, parseFloat(document.getElementById('fc-lr')?.value || '0.01')));

    const { lat, lng } = MapManager.getCurrentLocation();
    if (statsEl) statsEl.textContent = 'Fetching VI history…';

    try {
      // 1) 历史 VI （按产品；用 RST dates/subset）
      const viSeries = await this._fetchVISeries(product, target, lat, lng, years);
      if (!viSeries.length) { if (statsEl) statsEl.textContent = 'No VI history here.'; return; }

      // 2) 同期 POWER 天气（按 VI 日期±8天聚合）
      if (statsEl) statsEl.textContent = 'Fetching weather…';
      const wxByDate = await this._fetchWeatherByDate(viSeries, lat, lng);

      // 3) 组数据集（滞后特征+季节项+天气）
      if (statsEl) statsEl.textContent = 'Building dataset…';
      const ds = this._buildDataset(viSeries, wxByDate);
      if (ds.x.length < 24) { if (statsEl) statsEl.textContent = 'Not enough samples to train.'; return; }

      // 4) 训练（优先 tf.js 小 MLP；否则线性回归兜底）
      if (statsEl) statsEl.textContent = (window.tf ? 'Training TF.js model…' : 'Training linear baseline…');
      const model = await this._trainModel(ds, { epochs, lr });

      // 5) 预测未来30天（逐日步进，天气用近30天统计近似）
      if (statsEl) statsEl.textContent = 'Forecasting next 30 days…';
      const fc = this._forecastNext30Days(viSeries, wxByDate, model);

      // 6) 画图
      this._plot(viSeries, fc, target);
      if (statsEl) statsEl.textContent = `Done. Samples: ${ds.x.length}, RMSE (train): ${model.rmse?.toFixed?.(4) ?? '—'}`;
    } catch (err) {
      console.error(err);
      if (statsEl) statsEl.textContent = `Failed: ${err.message}`;
    }
  },

  clear() {
    const statsEl = document.getElementById('fc-stats');
    const chartEl = document.getElementById('fc-chart');
    if (statsEl) statsEl.textContent = '—';
    if (chartEl && window.Plotly) Plotly.purge(chartEl);
    if (!window.Plotly && chartEl) chartEl.innerHTML = '';
  },

  // ---------- 数据获取 ----------

  async _fetchVISeries(product, viType, lat, lng, years) {
    const datesJson = await VegetationManager.fetchDates(product, lat, lng);
    const entries = (datesJson?.dates || []).slice(-Math.ceil((365/16) * years)); // ~16天合成
    const series = [];
    for (const d of entries) {
      const md = d?.modis_date || d; // 'YYYY-DOY' 或 'YYYY-MM-DD'
      try {
        const subset = await VegetationManager.fetchSubset(product, lat, lng, md, md);
        const bands = subset?.subset || [];
        const match = bands.find(b => (b.band || '').toLowerCase().includes(viType)); // ndvi/evi
        const raw = Array.isArray(match?.data) ? match.data[0] : match?.data;
        const val = raw == null || raw <= -9000 ? null : Number(raw) * 0.0001;
        const iso = this._toISO(md);
        if (val != null && iso) series.push({ date: iso, value: val });
      } catch(_) { /* skip bad date */ }
    }
    series.sort((a,b)=> (a.date < b.date ? -1 : 1));
    return series;
  },

  async _fetchWeatherByDate(viSeries, lat, lng) {
    if (!viSeries.length) return {};
    const start = viSeries[0].date.replace(/-/g,'');
    const end   = viSeries[viSeries.length-1].date.replace(/-/g,'');

    const url = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
    url.search = new URLSearchParams({
      parameters: 'T2M,PRECTOTCORR',
      community: 'AG',
      longitude: String(lng),
      latitude: String(lat),
      start, end, format:'JSON'
    }).toString();

    const r = await fetch(url);
    if (!r.ok) throw new Error(`POWER error ${r.status}`);
    const j = await r.json();
    const T = j?.properties?.parameter?.T2M || {};
    const P = j?.properties?.parameter?.PRECTOTCORR || {};

    const get = (obj, ymd) => {
      const v = obj?.[ymd]; const n = Number(v);
      return Number.isFinite(n) && n > -900 ? n : null;
    };

    const wx = {};
    for (const { date } of viSeries) {
      const d0 = new Date(`${date}T00:00:00Z`);
      let tList=[], pList=[];
      for (let k=-8;k<=8;k++){
        const d = new Date(d0); d.setUTCDate(d0.getUTCDate()+k);
        const ymd = this._ymd(d);
        const tv=get(T,ymd); const pv=get(P,ymd);
        if (tv!=null) tList.push(tv);
        if (pv!=null) pList.push(pv);
      }
      wx[date] = {
        tMean: tList.length? (tList.reduce((a,b)=>a+b,0)/tList.length) : null,
        pSum:  pList.length? (pList.reduce((a,b)=>a+b,0)) : null
      };
    }
    return wx;
  },

  // ---------- 数据集与特征 ----------

  _buildDataset(viSeries, wxByDate) {
    const x=[], y=[];
    const byDate = new Map(viSeries.map(v=>[v.date, v.value]));
    const dates  = viSeries.map(v=>v.date);

    const roll = (idx, win=3) => {
      const s = Math.max(0, idx-win+1);
      const arr = viSeries.slice(s, idx+1).map(v=>v.value).filter(v=>v!=null);
      return arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length) : null;
    };

    for (let i=2; i<viSeries.length; i++) {
      const d   = dates[i];
      const v   = byDate.get(d);
      const l1  = byDate.get(dates[i-1]);
      const l2  = byDate.get(dates[i-2]);
      const r3  = roll(i,3);
      const wx  = wxByDate[d] || {};
      if (v==null || l1==null || l2==null || r3==null || wx.tMean==null || wx.pSum==null) continue;

      const doy = this._doy(d);
      const feat = [
        l1, l2, r3,
        Math.sin(2*Math.PI*doy/365), Math.cos(2*Math.PI*doy/365),
        wx.tMean, wx.pSum
      ];
      x.push(feat); y.push(v);
    }
    return { x, y };
  },

  // ---------- 训练 ----------

  async _trainModel(ds, { epochs, lr }) {
    const X = ds.x, Y = ds.y;

    // 标准化
    const mu=[], sig=[]; const cols = X[0].length;
    for (let j=0;j<cols;j++){
      const col = X.map(r=>r[j]);
      const m = col.reduce((a,b)=>a+b,0)/col.length;
      const s = Math.sqrt(col.reduce((a,b)=>a+(b-m)*(b-m),0)/Math.max(1,col.length-1)) || 1;
      mu[j]=m; sig[j]=s;
    }
    const xN = X.map(r=> r.map((v,j)=>(v-mu[j])/sig[j]));

    const yMu = Y.reduce((a,b)=>a+b,0)/Y.length;
    const ySig = Math.sqrt(Y.reduce((a,b)=>a+(b-yMu)*(b-yMu),0)/Math.max(1,Y.length-1)) || 1;
    const yN = Y.map(v => (v - yMu)/ySig);

    if (window.tf) {
      // tf.js 小 MLP
      const model = tf.sequential();
      model.add(tf.layers.dense({ units: 32, activation: 'relu', inputShape:[cols] }));
      model.add(tf.layers.dense({ units: 16, activation: 'relu' }));
      model.add(tf.layers.dense({ units: 1 }));
      model.compile({ optimizer: tf.train.adam(lr), loss: 'meanSquaredError' });

      const tx = tf.tensor2d(xN);
      const ty = tf.tensor2d(yN, [yN.length,1]);
      await model.fit(tx, ty, { epochs, shuffle:true, verbose:0 });
      const pred = model.predict(tx);
      const rmse = Math.sqrt((await pred.sub(ty).square().mean().data())[0]) * ySig;
      tx.dispose(); ty.dispose(); pred.dispose();

      const infer = (row) => {
        const r = row.map((v,j)=>(v-mu[j])/sig[j]);
        const t = tf.tensor2d([r]);
        const p = model.predict(t);
        const vhat = p.dataSync()[0]*ySig + yMu;
        t.dispose(); p.dispose();
        return vhat;
      };
      return { type:'tf', infer, rmse };
    } else {
      // 线性回归
      const XT = this._transpose(xN);
      const XTX = this._matMul(XT, xN);
      const XTy = this._matVec(XT, yN);
      const XTXinv = this._invSym(XTX);
      const w = this._matVec(XTXinv, XTy);
      const yhat = this._matVec(xN, w);
      const rmse = Math.sqrt(this._mse(yhat, yN)) * ySig;

      const infer = (row) => {
        const r = row.map((v,j)=>(v-mu[j])/sig[j]);
        const yn = r.reduce((a,b,idx)=> a + b*w[idx], 0);
        return yn*ySig + yMu;
      };
      return { type:'lin', infer, rmse };
    }
  },

  _forecastNext30Days(viSeries, wxByDate, model) {
    const out = [];
    const keys = Object.keys(wxByDate);
    const last30 = keys.slice(-Math.min(30, keys.length));
    const tArr = last30.map(d=>wxByDate[d]?.tMean).filter(v=>v!=null);
    const pArr = last30.map(d=>wxByDate[d]?.pSum ).filter(v=>v!=null);
    const tConst = tArr.length ? (tArr.reduce((a,b)=>a+b,0)/tArr.length) : 10;
    const pConst = pArr.length ? (pArr.reduce((a,b)=>a+b,0)) : 10;

    const hist = viSeries.slice();
    let d = new Date(hist[hist.length-1].date+'T00:00:00Z');

    for (let i=1;i<=30;i++){
      d.setUTCDate(d.getUTCDate()+1);
      const iso = d.toISOString().slice(0,10);

      const len = hist.length;
      const l1 = hist[len-1]?.value ?? null;
      const l2 = hist[len-2]?.value ?? null;
      const r3 = (()=>{
        const arr = hist.slice(-3).map(v=>v.value).filter(v=>v!=null);
        return arr.length? (arr.reduce((a,b)=>a+b,0)/arr.length): null;
      })();
      if (l1==null || l2==null || r3==null) { out.push({ date: iso, value: null }); continue; }

      const f = [
        l1, l2, r3,
        Math.sin(2*Math.PI*this._doy(iso)/365), Math.cos(2*Math.PI*this._doy(iso)/365),
        tConst, pConst
      ];
      const vhat = model.infer(f);
      const clipped = Math.max(-0.1, Math.min(1.0, vhat));
      out.push({ date: iso, value: clipped });
      hist.push({ date: iso, value: clipped });
    }
    return out;
  },

  // ---------- 绘图 ----------

  _plot(hist, fc, label) {
    const el = document.getElementById('fc-chart');
    if (!el) return;

    if (!window.Plotly) {
      el.innerHTML = '<pre>'+[
        'HISTORY (date,value):',
        ...hist.map(d=>`${d.date}\t${d.value!=null?d.value.toFixed(4):'null'}`),
        '',
        'FORECAST (date,value):',
        ...fc.map(d=>`${d.date}\t${d.value!=null?d.value.toFixed(4):'null'}`)
      ].join('\n')+'</pre>';
      return;
    }

    const trHist = { x: hist.map(d=>d.date), y: hist.map(d=>d.value), mode:'lines+markers', name: `${label.toUpperCase()} (history)` };
    const trFc   = { x: fc.map(d=>d.date),   y: fc.map(d=>d.value),   mode:'lines+markers', name: `${label.toUpperCase()} (forecast)`, line:{ dash:'dash' } };

    Plotly.newPlot(el, [trHist, trFc], {
      margin: { l: 48, r: 20, t: 16, b: 40 },
      yaxis: { title: label.toUpperCase(), range: [-0.1, 1.0] },
      xaxis: { title: 'Date' }
    }, { displayModeBar: false, responsive: true });
  },

  // ---------- 小工具 ----------

  _toISO(modisDate) {
    if (/^\d{4}-\d{3}$/.test(modisDate)) {
      const [y, doy] = modisDate.split('-').map(Number);
      const d = new Date(Date.UTC(y, 0, 1));
      d.setUTCDate(d.getUTCDate() + (doy - 1));
      return d.toISOString().slice(0,10);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(modisDate)) return modisDate;
    return null;
  },
  _ymd(d){ const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,'0'), dd=String(d.getUTCDate()).padStart(2,'0'); return `${y}${m}${dd}`; },
  _doy(iso){ const d=new Date(iso+'T00:00:00Z'); const s=new Date(Date.UTC(d.getUTCFullYear(),0,0)); return Math.floor((d-s)/(1000*60*60*24)); },

  _transpose(A){ return A[0].map((_,i)=>A.map(r=>r[i])); },
  _matMul(A,B){ return A.map((r,ri)=>B[0].map((_,j)=>r.reduce((s,_,k)=>s + A[ri][k]*B[k][j],0))); },
  _matVec(A,v){ return A.map(r=>r.reduce((s,_,j)=> s + r[j]*v[j], 0)); },
  _mse(yhat, y){ const n=y.length; let s=0; for(let i=0;i<n;i++) s+=(yhat[i]-y[i])**2; return s/Math.max(1,n); },
  _invSym(M){
    const n=M.length;
    const A=M.map(r=>r.slice());
    const I=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?1:0));
    for(let i=0;i<n;i++){
      let p=i; for(let r=i+1;r<n;r++) if (Math.abs(A[r][i])>Math.abs(A[p][i])) p=r;
      if (Math.abs(A[p][i])<1e-10) throw new Error('Singular');
      [A[i],A[p]]=[A[p],A[i]]; [I[i],I[p]]=[I[p],I[i]];
      const inv=1/A[i][i];
      for(let j=0;j<n;j++){ A[i][j]*=inv; I[i][j]*=inv; }
      for(let r=0;r<n;r++){
        if(r===i) continue;
        const f=A[r][i];
        for(let j=0;j<n;j++){ A[r][j]-=f*A[i][j]; I[r][j]-=f*I[i][j]; }
      }
    }
    return I;
  }
};

// 挂到全局，供 UIManager 调用
window.ForecastManager = ForecastManager;




/* =======================================================================
 * Vegetation: Wildflower Stats (iNaturalist + NASA POWER)
 * Drop-in addon — append this WHOLE block to the END of your app.js
 * It binds to your existing HTML controls (all ids start with `vi-`).
 * Requirements:
 *   - MapManager.getCurrentLocation() -> { lat, lng }
 *   - AppState.map is a Leaflet map instance
 *   - Leaflet + (optional) leaflet.markercluster
 *   - Plotly loaded before app.js
 *   - Optional Icons.flower for markers (falls back to default marker)
 * =======================================================================*/
(() => {
  const VIAddon = {
    // Optional overlay: show some pollinator groups as reference lines
    POLLINATOR_TAXA: [
      { id: 630955, label: 'Apoidea (bees)' },
      { id: 47157,  label: 'Lepidoptera' }
    ],

    _speciesCache: [],       // [{id, name, common, count}]
    _speciesLayer: null,     // L.MarkerClusterGroup
    _busy: false,
    _invasiveList: [],       // [{id, name, common, total5y, flag, trend?}]
    _lastParams: null,       // {lat,lng,year,radius}

    /* ---------------------- lifecycle ---------------------- */
    init() {
      // Bind directly to EXISTING HTML (no UI injection)
      window.addEventListener('DOMContentLoaded', () => {
        this.bindEvents();
      });
    },

    bindEvents() {
      const $ = (id) => document.getElementById(id);

      // Species list / monthly plot / map overlay
      $('vi-load-species')?.addEventListener('click', () => this.loadSpeciesList());
      $('vi-species-filter')?.addEventListener('input', (e) => this.renderSpeciesList(e.target.value || ''));
      $('vi-plot-monthly')?.addEventListener('click', () => this.plotSelectedMonthly());
      $('vi-show-species')?.addEventListener('click', () => this.showSelectedSpeciesOnMap());
      $('vi-clear-species')?.addEventListener('click', () => this.clearSpeciesLayer());

      // Invasives (auto, last 5y)
      $('vi-inv-analyze')?.addEventListener('click', () => this.detectInvasives5y());
      $('vi-inv-show')?.addEventListener('click', () => this.showTopInvasivesOnMap());
      $('vi-inv-clear')?.addEventListener('click', () => this.clearSpeciesLayer());

      // POWER: last 365 days (rain + aridity + heuristic superbloom)
      $('vi-load-rain')?.addEventListener('click', () => this.loadRainAridity());

      // Pollinator monthly counts (free input of taxa ids)
      $('vi-plot-pollinators')?.addEventListener('click', () => this.plotPollinators());

      console.log('[VIAddon] events bound to vi-* controls.');
    },

    /* ---------------------- helpers ---------------------- */
    getParams() {
      const loc = (typeof MapManager?.getCurrentLocation === 'function')
        ? MapManager.getCurrentLocation()
        : { lat: 38.9072, lng: -77.0369 }; // fallback Washington, DC

      const year   = parseInt(document.getElementById('vi-year')?.value || '2024', 10);
      const radius = Math.max(1, Math.min(200, parseInt(document.getElementById('vi-radius')?.value || '25', 10)));
      return { lat: loc.lat, lng: loc.lng, year, radius };
    },

    /* ---------------------- species list ---------------------- */
    async loadSpeciesList() {
      if (this._busy) return;
      this._busy = true;

      const { lat, lng, year, radius } = this.getParams();
      this._lastParams = { lat, lng, year, radius };

      const listEl = document.getElementById('vi-species-list');
      if (listEl) { listEl.innerHTML = ''; const opt = document.createElement('option'); opt.textContent = 'Loading…'; listEl.appendChild(opt); }

      try {
        // iNaturalist species_counts for Angiosperms (47125)
        const per = 200;
        const out = [];
        for (let page=1; page<=5; page++){
          const u = new URL('https://api.inaturalist.org/v1/observations/species_counts');
          u.search = new URLSearchParams({
            lat, lng, radius, year,
            verifiable:'true', geo:'true',
            taxon_id:'47125',
            per_page:String(per), page:String(page)
          }).toString();

          const r = await fetch(u);
          if (!r.ok) break;
          const j = await r.json();
          const arr = j?.results || [];
          for (const s of arr){
            const t = s.taxon || {};
            if (!t.id) continue;
            out.push({
              id: t.id,
              name: t.name,
              common: t.preferred_common_name || t.english_common_name || '',
              count: s.count || 0
            });
          }
          if (arr.length < per) break;
        }
        out.sort((a,b)=>b.count-a.count);
        this._speciesCache = out;
        this.renderSpeciesList(document.getElementById('vi-species-filter')?.value || '');
        console.log(`[VIAddon] species loaded: ${out.length} (Y=${year}, R=${radius}km)`);
      } catch (e) {
        console.error(e);
        if (listEl) { listEl.innerHTML = ''; const opt = document.createElement('option'); opt.textContent = 'Failed. Try again.'; listEl.appendChild(opt); }
      } finally {
        this._busy = false;
      }
    },

    renderSpeciesList(filterText) {
      const sel = document.getElementById('vi-species-list');
      if (!sel) return;
      sel.innerHTML = '';

      const q = (filterText || '').trim().toLowerCase();
      const items = this._speciesCache
        .filter(s => !q || (s.name?.toLowerCase().includes(q) || s.common?.toLowerCase().includes(q)))
        .slice(0, 800);

      for (const s of items) {
        const opt = document.createElement('option');
        opt.value = String(s.id);
        opt.textContent = `${s.common ? (s.common + ' · ') : ''}${s.name} (${s.count})`;
        sel.appendChild(opt);
      }
    },

    /* ---------------------- monthly plot (legend at bottom) ---------------------- */
    async plotSelectedMonthly() {
      const sel = document.getElementById('vi-species-list');
      if (!sel || !sel.value) return alert('Please choose a species first.');
      if (!window.Plotly) return alert('Plotly not loaded.');

      const taxonId = parseInt(sel.value, 10);
      const label   = sel.options[sel.selectedIndex]?.textContent?.replace(/\s*\(\d+\)\s*$/, '') || `taxon ${taxonId}`;
      const { lat, lng, year, radius } = this.getParams();

      try {
        const [monthCounts, precipMonthly] = await Promise.all([
          this._inatMonthly(taxonId, lat, lng, radius, year),
          this._powerMonthly(lat, lng, year)
        ]);

        const names  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const months = Array.from({length:12}, (_,i)=>i+1);
        const yObs   = months.map(m => monthCounts[m] || 0);
        const yP     = months.map(m => precipMonthly[m] || 0);

        const traces = [
          { x:names, y:yObs, type:'scatter', mode:'lines+markers', name:`${label} (observations)` },
          { x:names, y:yP,   type:'bar',     name:'Precip (mm)', yaxis:'y2', opacity:0.5 }
        ];

        // Optional pollinator overlays
        const pol = await Promise.all(this.POLLINATOR_TAXA.map(async p=>{
          try{
            const mc = await this._inatMonthly(p.id, lat, lng, radius, year);
            return { x:names, y:months.map(m=>mc[m]||0), type:'scatter', mode:'lines', line:{width:1}, name:p.label };
          }catch{return null;}
        }));
        traces.push(...pol.filter(Boolean));

        const layout = {
          margin:{l:48,r:48,t:24,b:56},
          xaxis:{title:`Monthly in ${year}`},
          yaxis:{title:'Observations'},
          yaxis2:{title:'Precip (mm)', overlaying:'y', side:'right', showgrid:false},
          legend: { orientation:'h', yanchor:'top', y:-0.25, xanchor:'center', x:0.5 } // legend at bottom
        };
        Plotly.newPlot('vi-flower-chart', traces, layout, { displayModeBar:false });

        console.log('[VIAddon] monthly chart rendered (legend bottom).');
      } catch (e) {
        console.error(e);
        alert('Failed to plot monthly chart.');
      }
    },

    /* ---------------------- show selected species on map ---------------------- */
    async showSelectedSpeciesOnMap() {
      const sel = document.getElementById('vi-species-list');
      if (!sel || !sel.value) return alert('Please choose a species first.');
      const taxonId = parseInt(sel.value, 10);
      const { lat, lng, year, radius } = this.getParams();

      if (!AppState?.map) return alert('Map not ready.');
      this.clearSpeciesLayer();
      if (!this._speciesLayer) this._speciesLayer = L.markerClusterGroup();

      let total = 0;
      try {
        for (let page=1; page<=5; page++){
          const u = new URL('https://api.inaturalist.org/v1/observations');
          u.search = new URLSearchParams({
            lat, lng, radius, year,
            taxon_id: String(taxonId),
            verifiable:'true', geo:'true',
            order:'desc', order_by:'observed_on',
            per_page:'200', page:String(page)
          }).toString();

          const r = await fetch(u);
          if (!r.ok) break;
          const j = await r.json();
          const arr = j?.results || [];
          total += arr.length;

          for (const o of arr) {
            const y = o.geojson?.coordinates?.[1] ?? (o.location ? Number(o.location.split(',')[0]) : null);
            const x = o.geojson?.coordinates?.[0] ?? (o.location ? Number(o.location.split(',')[1]) : null);
            if (y==null || x==null) continue;

            const icon = (window.Icons && Icons.flower) ? Icons.flower : undefined;
            const marker = L.marker([y,x], icon?{icon}:{});
            const when = (o.observed_on_details?.date || o.observed_on || '').slice(0,10);
            const title = o.taxon?.preferred_common_name || o.taxon?.name || `taxon ${taxonId}`;
            marker.bindPopup(
              `<div style="min-width:220px">
                 <b>${title}</b><br>${when||''}<br>
                 <a target="_blank" rel="noopener" href="https://www.inaturalist.org/observations/${o.id}">Open on iNaturalist</a>
               </div>`
            );
            this._speciesLayer.addLayer(marker);
          }
          if (arr.length < 200) break;
        }

        this._speciesLayer.addTo(AppState.map);
        console.log(`[VIAddon] added ${total} markers.`);
      } catch (e) {
        console.error(e);
        alert('Failed to load observation points.');
      }
    },

    clearSpeciesLayer() {
      if (this._speciesLayer) {
        this._speciesLayer.clearLayers();
        if (AppState?.map) AppState.map.removeLayer(this._speciesLayer);
      }
      this._speciesLayer = null;
    },

    /* ---------------------- invasives (auto, last 5y) ---------------------- */
    async detectInvasives5y() {
      const { lat, lng, radius } = this.getParams();
      const endYear = new Date().getUTCFullYear();
      const d1 = `${endYear-4}-01-01`;
      const d2 = `${endYear}-12-31`;

      const tbody = document.querySelector('#vi-inv-table tbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="5">Analyzing…</td></tr>`;

      try {
        // Step 1: trust iNat "introduced" label if available
        let list = [];
        const uIntro = new URL('https://api.inaturalist.org/v1/observations/species_counts');
        uIntro.search = new URLSearchParams({
          lat, lng, radius, d1, d2,
          verifiable:'true', geo:'true',
          establishment_means:'introduced',
          per_page:'200'
        }).toString();
        let r = await fetch(uIntro);
        if (r.ok) {
          const j = await r.json();
          list = (j?.results||[]).map(s=>({
            id: s.taxon?.id,
            name: s.taxon?.name,
            common: s.taxon?.preferred_common_name || '',
            total5y: s.count || 0,
            flag: 'introduced'
          })).filter(x=>x.id);
        }

        // Step 2: if few introduced hits, fallback to 5y sum + trend heuristic
        if (!list.length) {
          const yearMap = new Map(); // id -> {name,common, y:[5], sum}
          for (let y=endYear-4; y<=endYear; y++) {
            const u = new URL('https://api.inaturalist.org/v1/observations/species_counts');
            u.search = new URLSearchParams({
              lat, lng, radius, year:String(y),
              verifiable:'true', geo:'true',
              taxon_id:'47125', per_page:'200'
            }).toString();
            const rr = await fetch(u);
            if (!rr.ok) continue;
            const jj = await rr.json();
            for (const s of (jj?.results||[])) {
              const id = s?.taxon?.id; if (!id) continue;
              const rec = yearMap.get(id) || { name: s.taxon?.name, common: s.taxon?.preferred_common_name||'', y:[0,0,0,0,0], sum:0 };
              rec.y[y-(endYear-4)] += (s.count||0);
              rec.sum += (s.count||0);
              yearMap.set(id, rec);
            }
          }
          list = Array.from(yearMap.entries()).map(([id, rec])=>{
            const first = rec.y[0] || 0, last = rec.y[4] || 0;
            const ratio = first===0 ? (last>0?Infinity:1) : (last/first);
            const trend = ratio>=1.5 ? '▲' : (ratio<=0.67 ? '▼' : '—');
            return { id, name:rec.name, common:rec.common, total5y:rec.sum, flag:'candidate', trend };
          }).sort((a,b)=>b.total5y-a.total5y).slice(0, 50);
        }

        list.sort((a,b)=>b.total5y-a.total5y);
        this._invasiveList = list;

        // Render table
        if (tbody) {
          tbody.innerHTML = '';
          let rank = 1;
          for (const sp of list) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>${rank++}</td>
              <td>${sp.common || '—'}</td>
              <td>${sp.name || '—'}</td>
              <td>${sp.total5y}</td>
              <td>${sp.flag}${sp.trend?` ${sp.trend}`:''}</td>
            `;
            tbody.appendChild(tr);
          }
          if (!list.length) {
            tbody.innerHTML = `<tr><td colspan="5">No invasive candidates found.</td></tr>`;
          }
        }
        console.log(`[VIAddon] invasive analyzed: ${list.length}`);
      } catch (e) {
        console.error(e);
        if (tbody) tbody.innerHTML = `<tr><td colspan="5">Analyze failed.</td></tr>`;
      }
    },

    async showTopInvasivesOnMap() {
      if (!this._invasiveList?.length) return alert('Run "Analyze top-N species" first.');
      if (!AppState?.map) return alert('Map not ready.');

      const topN = Math.max(1, Math.min(50, parseInt(document.getElementById('vi-inv-topN')?.value || '10', 10)));
      const { lat, lng, year, radius } = this.getParams();

      this.clearSpeciesLayer();
      this._speciesLayer = L.markerClusterGroup();

      let total = 0;
      try {
        for (const sp of this._invasiveList.slice(0, topN)) {
          // Limit pages per species to avoid overload
          for (let page=1; page<=2; page++) {
            const u = new URL('https://api.inaturalist.org/v1/observations');
            u.search = new URLSearchParams({
              lat, lng, radius, year,
              taxon_id:String(sp.id),
              verifiable:'true', geo:'true',
              order:'desc', order_by:'observed_on',
              per_page:'200', page:String(page)
            }).toString();
            const r = await fetch(u);
            if (!r.ok) break;
            const j = await r.json();
            const arr = j?.results || [];
            total += arr.length;

            for (const o of arr) {
              const y = o.geojson?.coordinates?.[1] ?? (o.location ? Number(o.location.split(',')[0]) : null);
              const x = o.geojson?.coordinates?.[0] ?? (o.location ? Number(o.location.split(',')[1]) : null);
              if (y==null || x==null) continue;

              const icon = (window.Icons && Icons.flower) ? Icons.flower : undefined;
              const marker = L.marker([y,x], icon?{icon}:{});
              const when = (o.observed_on_details?.date || o.observed_on || '').slice(0,10);
              const title = sp.common || sp.name || `taxon ${sp.id}`;
              marker.bindPopup(
                `<div style="min-width:220px">
                   <b>${title}</b><br>${when||''}<br>
                   <a target="_blank" rel="noopener" href="https://www.inaturalist.org/observations/${o.id}">Open on iNaturalist</a>
                 </div>`
              );
              this._speciesLayer.addLayer(marker);
            }
            if (arr.length < 200) break;
          }
        }
        this._speciesLayer.addTo(AppState.map);
        console.log(`[VIAddon] invasive markers added: ${total} points.`);
      } catch (e) {
        console.error(e);
        alert('Failed to add invasive markers.');
      }
    },

    /* ---------------------- POWER: last 365d (rain, aridity, heuristic superbloom) ---------------------- */
    async loadRainAridity() {
      if (!window.Plotly) return alert('Plotly not loaded.');

      const { lat, lng } = this.getParams();
      // Build date window: last 365 calendar days
      const end  = new Date();
      const start= new Date(end.getTime() - 365*24*3600*1000);
      const fmt  = (d) => d.toISOString().slice(0,10).replace(/-/g,'');
      const startStr = fmt(start), endStr = fmt(end);

      try {
        const daily = await this._powerDaily(lat, lng, startStr, endStr, ['PRECTOTCORR','T2M']);

        // Aggregate to weekly for a cleaner chart
        const weeks = [];
        let wkP = 0, wkTsum = 0, wkN = 0, lastWeekIdx = -1;
        daily.dates.forEach((iso, idx) => {
          const d = new Date(iso);
          const weekIdx = Math.floor((d - start) / (7*24*3600*1000));
          if (weekIdx !== lastWeekIdx && lastWeekIdx >= 0) {
            weeks.push({week:lastWeekIdx, precip: wkP, t2m: (wkN? wkTsum/wkN : null)});
            wkP = 0; wkTsum = 0; wkN = 0;
          }
          const p = Math.max(0, +daily.precip[idx] || 0);
          const t = (Number.isFinite(daily.t2m[idx]) ? daily.t2m[idx] : null);
          wkP += p;
          if (t !== null) { wkTsum += t; wkN++; }
          lastWeekIdx = weekIdx;
        });
        if (lastWeekIdx >= 0) weeks.push({week:lastWeekIdx, precip: wkP, t2m: (wkN? wkTsum/wkN : null)});

        // Aridity index: share of last-90d rainfall over 365d total (higher => less arid recently)
        const total365 = weeks.reduce((s,w)=>s+(w.precip||0),0);
        const last90ms = end.getTime() - 90*24*3600*1000;
        const r90 = daily.dates.reduce((s,iso,idx)=>{
          const t = new Date(iso).getTime();
          return s + (t>=last90ms ? Math.max(0, +daily.precip[idx]||0) : 0);
        }, 0);
        const aridityIdx = total365>0 ? Math.min(1, r90/total365) : 0;

        const aridBar = document.getElementById('vi-arid-bar');
        const aridLbl = document.getElementById('vi-arid-label');
        if (aridBar) aridBar.style.width = (aridityIdx*100).toFixed(0) + '%';
        if (aridLbl) aridLbl.textContent = `Aridity index (last 90d share of 365d rain): ${(aridityIdx*100).toFixed(0)}%`;

        const superb = document.getElementById('vi-superbloom');
        if (superb) {
          let msg = 'Low probability';
          if (total365 > 200 && aridityIdx > 0.55) msg = 'Moderate to High';
          if (total365 > 350 && aridityIdx > 0.60) msg = 'High (rainfall-based)';
          superb.textContent = `Superbloom prediction (heuristic): ${msg}`;
        }

        // Weekly bar (precip) + line (temp)
        const xLabels = weeks.map(w => `W${w.week+1}`);
        const bar = { x:xLabels, y:weeks.map(w=>w.precip||0), type:'bar', name:'Weekly Precip (mm)'};
        const line= { x:xLabels, y:weeks.map(w=>w.t2m), type:'scatter', mode:'lines', yaxis:'y2', name:'Weekly Mean T2M (°C)'};
        const layout = {
          margin:{l:48,r:48,t:24,b:56},
          yaxis:{title:'Precip (mm)'},
          yaxis2:{title:'T (°C)', overlaying:'y', side:'right', showgrid:false},
          legend:{orientation:'h', yanchor:'top', y:-0.25, xanchor:'center', x:0.5}
        };
        Plotly.newPlot('vi-rain-chart', [bar, line], layout, {displayModeBar:false});
      } catch (e) {
        console.error(e);
        alert('POWER fetch failed.');
      }
    },

    // POWER daily fetcher (supports multiple parameters)
    async _powerDaily(lat, lng, startYYYYMMDD, endYYYYMMDD, params=['PRECTOTCORR']) {
      const url = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
      url.search = new URLSearchParams({
        parameters: params.join(','),
        community: 'AG',
        longitude: String(lng),
        latitude: String(lat),
        start: startYYYYMMDD,
        end:   endYYYYMMDD,
        format: 'JSON'
      }).toString();
      const r = await fetch(url);
      if (!r.ok) throw new Error('POWER daily error');
      const j = await r.json();
      const obj = j?.properties?.parameter || {};
      const allDates = Object.keys(obj[params[0]] || {}).sort();
      const out = { dates: allDates.map(d => `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`) };
      for (const p of params) {
        const series = obj[p] || {};
        out[p.toLowerCase()] = allDates.map(d => {
          const v = Number(series[d]);
          return Number.isFinite(v) ? (p==='PRECTOTCORR' ? Math.max(0, v) : v) : null; // clamp negatives for precip
        });
      }
      out.precip = out.prectotcorr || [];
      out.t2m    = out.t2m || [];
      return out;
    },

    /* ---------------------- pollinators monthly plot ---------------------- */
    async plotPollinators() {
      if (!window.Plotly) return alert('Plotly not loaded.');

      const input = document.getElementById('vi-pollinator-taxa');
      const year  = parseInt(document.getElementById('vi-year')?.value || String(new Date().getFullYear()), 10);
      if (!input || !input.value.trim()) return alert('Enter taxa IDs (comma-separated).');

      const { lat, lng, radius } = this.getParams();
      const taxIds = input.value.split(',').map(s=>parseInt(s.trim(),10)).filter(n=>Number.isFinite(n));
      if (!taxIds.length) return alert('Invalid taxa IDs.');

      try {
        const names  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const months = Array.from({length:12},(_,i)=>i+1);

        const traces = [];
        for (const id of taxIds) {
          const mc = await this._inatMonthly(id, lat, lng, radius, year);
          traces.push({
            x:names, y:months.map(m=>mc[m]||0),
            type:'scatter', mode:'lines+markers', name:`Taxon ${id}`
          });
        }
        const layout = {
          margin:{l:48,r:48,t:24,b:56},
          xaxis:{title:`Monthly pollinator counts in ${year}`},
          yaxis:{title:'Observations'},
          legend:{orientation:'h', yanchor:'top', y:-0.25, xanchor:'center', x:0.5}
        };
        Plotly.newPlot('vi-poll-chart', traces, layout, {displayModeBar:false});
      } catch (e) {
        console.error(e);
        alert('Plot pollinator counts failed.');
      }
    },

    /* ---------------------- external data wrappers ---------------------- */
    async _inatMonthly(taxonId, lat, lng, radius, year) {
      // Use month_of_year (1..12) which is stable and explicit
      const u = new URL('https://api.inaturalist.org/v1/observations/histogram');
      u.search = new URLSearchParams({
        lat, lng, radius,
        verifiable:'true', geo:'true',
        taxon_id:String(taxonId),
        date_field:'observed', interval:'month_of_year',
        year:String(year)
      }).toString();
      const r = await fetch(u);
      if (!r.ok) throw new Error('iNat histogram failed');
      const j = await r.json();
      const obj = j?.results?.month_of_year || {};
      const out = {};
      for (let m=1;m<=12;m++) out[m] = Number(obj[String(m)]||0);
      return out;
    },

    async _powerMonthly(lat, lng, year) {
      // Sum daily PRECTOTCORR into months; clamp negatives to 0
      const u = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
      u.search = new URLSearchParams({
        parameters:'PRECTOTCORR', community:'AG',
        longitude:String(lng), latitude:String(lat),
        start:`${year}0101`, end:`${year}1231`, format:'JSON'
      }).toString();
      const r = await fetch(u);
      if (!r.ok) return {};
      const j = await r.json();
      const daily = j?.properties?.parameter?.PRECTOTCORR || {};
      const monthly = {};
      for (const [ymd, vRaw] of Object.entries(daily)) {
        const m = parseInt(String(ymd).slice(4,6), 10);
        const v = Math.max(0, Number(vRaw) || 0);
        monthly[m] = (monthly[m] || 0) + v;
      }
      return monthly;
    }
  };

  VIAddon.init();
})();






/* =========================================================
 * Bootstrap
 * =======================================================*/
window.addEventListener('DOMContentLoaded', () => {
    UIManager.init();
    MapManager.init();
});
