/* global L, maplibregl, supabase */

const STORAGE_KEY = "gaAppen_v1";
const MAPTILER_STORAGE_KEY = "gaAppen_maptiler_key";
const SUPABASE_STORAGE_KEY = "gaAppen_supabase_v1"; // { url, anon }

let sb = null;

function loadSupabaseConfig() {
  try {
    const raw = localStorage.getItem(SUPABASE_STORAGE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (!cfg?.url || !cfg?.anon) return null;
    return { url: String(cfg.url), anon: String(cfg.anon) };
  } catch {
    return null;
  }
}

function saveSupabaseConfig(cfg) {
  localStorage.setItem(SUPABASE_STORAGE_KEY, JSON.stringify(cfg));
}

function clearSupabaseConfig() {
  localStorage.removeItem(SUPABASE_STORAGE_KEY);
}

function ensureSupabase() {
  const cfg = loadSupabaseConfig();
  if (!cfg) {
    sb = null;
    return null;
  }
  if (!supabase?.createClient) {
    sb = null;
    return null;
  }
  if (sb) return sb;
  sb = supabase.createClient(cfg.url, cfg.anon, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return sb;
}

function updateSupabaseUi() {
  const cfg = loadSupabaseConfig();
  const status = document.querySelector("#sb-status");
  if (status) status.textContent = cfg ? "Konfigurert (klar til online toppliste)" : "Ikke konfigurert";
}

async function updateAuthUi() {
  const status = document.querySelector("#auth-status");
  const client = ensureSupabase();
  if (!status) return;
  if (!client) {
    status.textContent = "Konfigurer Supabase først";
    return;
  }
  const { data } = await client.auth.getSession();
  const email = data?.session?.user?.email;
  status.textContent = email ? `Innlogget: ${email}` : "Ikke innlogget";
}

async function ensureProfileInSupabase(displayNameOverride) {
  const client = ensureSupabase();
  if (!client || !state.profile) return;
  const { data: sess } = await client.auth.getSession();
  const user = sess?.session?.user;
  if (!user) return;

  const displayName =
    (displayNameOverride && String(displayNameOverride).trim()) ||
    (state.profile.epost ? String(state.profile.epost).split("@")[0] : "spiller");

  const row = {
    id: user.id,
    display_name: displayName,
    email: user.email ?? null,
    kommune: state.profile.kommune,
    skole: state.profile.skole,
  };

  await client.from("profiles").upsert(row, { onConflict: "id" });
}

function nowIsoDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function defaultState() {
  return {
    profile: null,
    totals: {
      pointsTotal: 0,
      lastActiveDate: null,
      streak: 0,
    },
    bonuses: {
      doubleUntil: null, // ISO date inclusive
    },
    school: {
      // demo-only shared scoreboard (local)
      publishedScores: [], // { id, name, school, kommune, seasonKey, points }
    },
    map: {
      trailEnabled: true,
      lastKnown: null, // { lat, lng, at }
      trail: [], // [{ lat, lng, at, acc }]
    },
    daily: {}, // by YYYY-MM-DD
  };
}

function getDaily(state, dateKey) {
  if (!state.daily[dateKey]) {
    state.daily[dateKey] = {
      points: 0,
      activeMeters: 0,
      lastMotivationAt: 0,
    };
  }
  return state.daily[dateKey];
}

function isoToDate(d) {
  return new Date(`${d}T00:00:00`);
}

function addDaysIso(dateKey, days) {
  const d = isoToDate(dateKey);
  d.setDate(d.getDate() + days);
  return nowIsoFromDate(d);
}

function nowIsoFromDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isIsoOnOrBefore(a, b) {
  return isoToDate(a).getTime() <= isoToDate(b).getTime();
}

function seasonKeyFromDate(dateKey) {
  // 3-month seasons (quarters): Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec
  const d = isoToDate(dateKey);
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

function seasonRangeFromKey(seasonKey) {
  const m = /^(\d{4})-Q([1-4])$/.exec(String(seasonKey));
  if (!m) return null;
  const year = Number(m[1]);
  const q = Number(m[2]);
  const startMonth = (q - 1) * 3; // 0,3,6,9
  const start = new Date(year, startMonth, 1);
  const end = new Date(year, startMonth + 3, 0); // last day of quarter
  return { startIso: nowIsoFromDate(start), endIso: nowIsoFromDate(end) };
}

function isIsoBetweenInclusive(d, startIso, endIso) {
  return isIsoOnOrBefore(startIso, d) && isIsoOnOrBefore(d, endIso);
}

function calcSeasonStats(state, seasonKey) {
  const range = seasonRangeFromKey(seasonKey);
  if (!range) return { points: 0, activeMeters: 0, range: null };
  let points = 0;
  let activeMeters = 0;
  for (const [dateKey, daily] of Object.entries(state.daily ?? {})) {
    if (!isIsoBetweenInclusive(dateKey, range.startIso, range.endIso)) continue;
    points += Number(daily?.points ?? 0);
    activeMeters += Number(daily?.activeMeters ?? 0);
  }
  return { points, activeMeters, range };
}

function detectActivity(speedMps, accuracyM) {
  if (typeof speedMps !== "number" || Number.isNaN(speedMps)) return "ukjent";

  // If GPS is very inaccurate, avoid confident classification.
  if (typeof accuracyM === "number" && accuracyM > 60) return "ukjent";

  // Heuristics:
  // walk: 0.6–2.2 m/s (2.2 m/s ≈ 7.9 km/t)
  // bike: 2.2–7.0 m/s (≈ 7.9–25.2 km/t)
  // vehicle: > 7.0 m/s
  if (speedMps < 0.6) return "stille";
  if (speedMps < 2.2) return "går";
  if (speedMps <= 7.0) return "sykler";
  return "kjøretøy";
}

function pointsForDelta(activity, deltaMeters) {
  // Simple scoring:
  // - walking: 10 pts / km
  // - cycling: 6 pts / km
  // - anything else: 0
  const km = deltaMeters / 1000;
  if (activity === "går") return Math.round(km * 10);
  if (activity === "sykler") return Math.round(km * 6);
  return 0;
}

function calc3DayKm(state, dateKey) {
  // Sum active meters for dateKey, dateKey-1, dateKey-2
  const d0 = dateKey;
  const d1 = addDaysIso(dateKey, -1);
  const d2 = addDaysIso(dateKey, -2);
  const m0 = getDaily(state, d0).activeMeters ?? 0;
  const m1 = getDaily(state, d1).activeMeters ?? 0;
  const m2 = getDaily(state, d2).activeMeters ?? 0;
  return (m0 + m1 + m2) / 1000;
}

function hasDoubleBonus(state, dateKey) {
  const until = state.bonuses?.doubleUntil;
  if (!until) return false;
  return isIsoOnOrBefore(dateKey, until);
}

function ensureDoubleBonusIfEarned(state, dateKey) {
  // Rule: If walked 5 km on 3 days => double points for 3 days then expires.
  // Interpreted as: if you have >=5 km active distance across last 3 days, you earn double for next 3 days.
  // If already has bonus, keep it.
  if (hasDoubleBonus(state, dateKey)) return;
  const km3 = calc3DayKm(state, dateKey);
  if (km3 >= 5) {
    state.bonuses.doubleUntil = addDaysIso(dateKey, 3); // inclusive
  }
}

function $(sel) {
  return document.querySelector(sel);
}

function setView(view) {
  const views = ["onboarding", "play", "school", "profile", "about"];
  for (const v of views) {
    const el = $(`#view-${v}`);
    if (!el) continue;
    el.hidden = v !== view;
  }
  for (const btn of document.querySelectorAll(".nav__btn")) {
    btn.classList.toggle("is-active", btn.dataset.view === view);
  }
}

function formatKm(m) {
  return `${(m / 1000).toFixed(2)} km`;
}

function setNotice(el, text, variant) {
  el.textContent = text;
  el.classList.remove("is-good", "is-warn");
  if (variant) el.classList.add(variant);
}

let state = loadState() ?? defaultState();
let map = null; // Leaflet fallback
let avatarMarker = null;
let pathLine = null;
let trailLine = null;

let map3d = null;
let map3dMarker = null;
let mapMode = "3d"; // always 3d by default
let map3dTrailSourceReady = false;

// Motion sensor (anti-cheat helper)
let motion = {
  enabled: false,
  lastSampleAt: 0,
  ema: 0,
  variance: 0,
  score: 0, // 0..1
  lastUpdatedAt: 0,
  stableHighSpeedSeconds: 0,
  // step/cadence heuristics
  hp: 0,
  hpEma: 0,
  lastStepAt: 0,
  stepCount: 0,
  cadenceSpm: 0,
  stepConfidence: 0, // 0..1
};

let session = {
  active: false,
  watchId: null,
  lastPos: null,
  lastAcceptedPos: null,
  lastActivity: "—",
  lastSpeedMps: null,
  lastUpdateAt: 0,
};

let snapWatchId = null;
let hasCenteredInitially = false;
let lastGeoError = null; // { code, message, at }

function maptilerKey() {
  const fromUrl = new URLSearchParams(location.search).get("maptilerKey");
  if (fromUrl && fromUrl.trim()) return fromUrl.trim();
  const fromStorage = localStorage.getItem(MAPTILER_STORAGE_KEY);
  if (fromStorage && fromStorage.trim()) return fromStorage.trim();
  // Optional hardcode for production:
  return "";
}

function ensureMap() {
  if (mapMode === "3d") {
    ensureMap3D();
    return;
  }
  if (map) return;
  map = L.map("map", { zoomControl: true });
  // Satellite-like fallback (no API key) so the screen is always a map.
  // Esri World Imagery is widely compatible in browsers.
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    detectRetina: true,
    attribution:
      'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noreferrer">Esri</a> • Data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
  }).addTo(map);

  const start = { lat: 59.9139, lng: 10.7522 }; // Oslo fallback
  map.setView([start.lat, start.lng], 14);

  const avatarIcon = L.divIcon({
    className: "avatar",
    html: `
      <div style="
        width: 38px; height: 38px; border-radius: 16px;
        background: linear-gradient(135deg, rgba(124,92,255,.95), rgba(46,229,157,.85));
        border: 2px solid rgba(255,255,255,.65);
        box-shadow: 0 16px 45px rgba(0,0,0,.38);
        display: grid; place-items: center;
        color: #071126; font-weight: 900;
      ">GÅ</div>
    `,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  });

  avatarMarker = L.marker([start.lat, start.lng], { icon: avatarIcon }).addTo(map);
  pathLine = L.polyline([], { color: "#7c5cff", weight: 4, opacity: 0.7 }).addTo(map);
  trailLine = L.polyline([], { color: "#2ee59d", weight: 5, opacity: 0.65 }).addTo(map);
  renderTrailOn2D();
}

function ensureMap3D() {
  if (map3d) return;

  const key = maptilerKey();
  const mot = $("#motivation");
  if (!key) {
    // No key: show satellite fallback so the whole screen is still a map.
    // When the user saves a key, we replace this with true 3D.
    mapMode = "2d";
    $("#map")?.classList.remove("is-3d");
    if (mot) setNotice(mot, "3D krever MapTiler-nøkkel. Viser satellitt-kart til du legger inn nøkkel.", "is-warn");
    ensureMap();
    return;
  }

  $("#map")?.classList.add("is-3d");

  map3d = new maplibregl.Map({
    container: "map",
    // Satellite + labels, similar to “Google Earth”-look
    style: `https://api.maptiler.com/maps/hybrid/style.json?key=${key}`,
    center: [10.7522, 59.9139],
    zoom: 15.5,
    pitch: 62,
    bearing: -18,
    antialias: true,
    pixelRatio: Math.min(2, window.devicePixelRatio || 1),
  });

  map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map3d.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: false,
      showAccuracyCircle: false,
    }),
    "top-right",
  );

  map3d.on("load", () => {
    // Reduce visible "tile seams" on mobile for raster layers (satellite imagery).
    // Works around faint grid lines between tiles.
    try {
      const style = map3d.getStyle();
      for (const layer of style.layers ?? []) {
        if (layer.type !== "raster") continue;
        try {
          map3d.setPaintProperty(layer.id, "raster-fade-duration", 0);
        } catch {
          // ignore
        }
        try {
          map3d.setPaintProperty(layer.id, "raster-resampling", "linear");
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    // Terrain (3D ground). Works with MapTiler terrain tiles.
    try {
      map3d.addSource("terrain", {
        type: "raster-dem",
        url: `https://api.maptiler.com/tiles/terrain-rgb/tiles.json?key=${key}`,
        tileSize: 256,
      });
      map3d.setTerrain({ source: "terrain", exaggeration: 1.15 });
      map3d.addLayer({
        id: "sky",
        type: "sky",
        paint: {
          "sky-type": "atmosphere",
          "sky-atmosphere-sun": [0.0, 0.0],
          "sky-atmosphere-sun-intensity": 8,
        },
      });
    } catch {
      // ignore
    }

    // Add 3D buildings if vector source is present.
    const layers = map3d.getStyle().layers ?? [];
    const labelLayerId = layers.find((l) => l.type === "symbol" && l.layout?.["text-field"])?.id;

    // This works on MapTiler streets-v2: building source/layer names are present.
    // If not present, it fails silently.
    try {
      map3d.addLayer(
        {
          id: "3d-buildings",
          source: "openmaptiles",
          "source-layer": "building",
          filter: ["==", "extrude", "true"],
          type: "fill-extrusion",
          minzoom: 14,
          paint: {
            "fill-extrusion-color": "rgba(255,255,255,0.78)",
            "fill-extrusion-height": ["get", "render_height"],
            "fill-extrusion-base": ["get", "render_min_height"],
            "fill-extrusion-opacity": 0.22,
          },
        },
        labelLayerId,
      );
    } catch {
      // ignore
    }

    map3dMarker = new maplibregl.Marker({ color: "#7c5cff" })
      .setLngLat([10.7522, 59.9139])
      .addTo(map3d);

    // Trail as GeoJSON line
    try {
      map3d.addSource("ga-trail", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [] },
          properties: {},
        },
      });
      map3d.addLayer({
        id: "ga-trail-line",
        type: "line",
        source: "ga-trail",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#2ee59d", "line-width": 4.5, "line-opacity": 0.7 },
      });
      map3dTrailSourceReady = true;
      renderTrailOn3D();
    } catch {
      map3dTrailSourceReady = false;
    }
  });
}

function pushTrailPoint(latlng, ts, accuracy) {
  const mapState = (state.map ??= { trailEnabled: true, lastKnown: null, trail: [] });
  mapState.lastKnown = { lat: latlng.lat, lng: latlng.lng, at: ts };

  if (!mapState.trailEnabled) return;

  const trail = (mapState.trail ??= []);
  const last = trail.length ? trail[trail.length - 1] : null;
  if (last) {
    const dt = (ts - (last.at || 0)) / 1000;
    if (dt < 4) return;
    const dist = haversineMeters({ lat: last.lat, lng: last.lng }, latlng);
    if (dist < 7) return;
  }

  trail.push({ lat: latlng.lat, lng: latlng.lng, at: ts, acc: accuracy ?? null });

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  while (trail.length > 1200) trail.shift();
  while (trail.length && (trail[0].at ?? 0) < cutoff) trail.shift();
}

function getTrailCoords() {
  const trail = state.map?.trail ?? [];
  return trail.map((p) => [p.lat, p.lng]);
}

function renderTrailOn2D() {
  if (!trailLine) return;
  const enabled = state.map?.trailEnabled !== false;
  const coords = enabled ? getTrailCoords() : [];
  trailLine.setLatLngs(coords.map(([lat, lng]) => ({ lat, lng })));
}

function renderTrailOn3D() {
  if (!map3d || !map3dTrailSourceReady) return;
  const enabled = state.map?.trailEnabled !== false;
  const trail = state.map?.trail ?? [];
  const coords = enabled ? trail.map((p) => [p.lng, p.lat]) : [];
  try {
    const src = map3d.getSource("ga-trail");
    if (!src) return;
    src.setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {},
    });
  } catch {
    // ignore
  }
}

function updateTrailUi() {
  const btn = $("#btn-toggle-trail");
  if (!btn) return;
  const on = state.map?.trailEnabled !== false;
  btn.textContent = on ? "Spor: På" : "Spor: Av";
}

function updateLocationStatusUi() {
  const el = $("#location-status");
  if (!el) return;
  const lk = state.map?.lastKnown;
  const dbg = $("#location-debug");

  if (dbg) {
    const parts = [];
    if (location.protocol !== "https:" && location.hostname !== "localhost") {
      parts.push("Tips: posisjon kan kreve https (localhost er OK).");
    }
    if (lastGeoError) parts.push(`Siste feil: (${lastGeoError.code}) ${lastGeoError.message}`);
    dbg.textContent = parts.join(" ");
  }

  if (!lk) {
    el.textContent = "Posisjon: ikke oppdatert ennå";
    return;
  }
  const dtSec = Math.max(0, Math.round((Date.now() - (lk.at ?? 0)) / 1000));
  const age = dtSec < 60 ? `${dtSec}s` : `${Math.round(dtSec / 60)}m`;
  el.textContent = `Posisjon: oppdatert for ${age} siden`;
}

async function updatePermissionDebug() {
  // Optional: show current permission state if browser supports it.
  const dbg = $("#location-debug");
  if (!dbg) return;
  try {
    if (!navigator.permissions?.query) return;
    const p = await navigator.permissions.query({ name: "geolocation" });
    const line = `Tillatelse: ${p.state}`;
    dbg.textContent = dbg.textContent ? `${dbg.textContent} • ${line}` : line;
  } catch {
    // ignore
  }
}

function noteGeoError(err) {
  lastGeoError = {
    code: err?.code ?? "ukjent",
    message: err?.message ?? "Ukjent feil",
    at: Date.now(),
  };
  updateLocationStatusUi();
}

function startSnapMapTracking() {
  if (!navigator.geolocation) return;
  if (snapWatchId != null) return;

  updatePermissionDebug();

  // First: force a prompt / fresh fix once.
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lastGeoError = null;
      onPosition(pos);
      if (!hasCenteredInitially) {
        hasCenteredInitially = true;
        centerOnAvatar();
      }
      updateLocationStatusUi();
    },
    (err) => {
      noteGeoError(err);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
  );

  // Then: low-impact tracking while app is open. No points are awarded unless the user starts a session.
  snapWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      lastGeoError = null;
      onPosition(pos);
      if (!hasCenteredInitially) {
        hasCenteredInitially = true;
        centerOnAvatar();
      }
      updateLocationStatusUi();
    },
    (err) => {
      noteGeoError(err);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5_000,
      timeout: 12_000,
    },
  );
}

function updateHeaderSubtitle() {
  const subtitle = $("#player-subtitle");
  if (!subtitle) return;
  if (!state.profile) {
    subtitle.textContent = "";
    return;
  }
  subtitle.textContent = `${state.profile.skole} • ${state.profile.kommune}`;
}

function updateProfileForm() {
  const form = $("#profile-form");
  if (!form || !state.profile) return;
  form.kommune.value = state.profile.kommune;
  form.skole.value = state.profile.skole;
  form.tlf.value = state.profile.tlf;
  form.epost.value = state.profile.epost;
}

function updateStatsUi() {
  const dateKey = nowIsoDate();
  const d = getDaily(state, dateKey);
  $("#points-today").textContent = String(d.points ?? 0);
  $("#distance-active").textContent = formatKm(d.activeMeters ?? 0);
  $("#activity-type").textContent = session.lastActivity ?? "—";
  $("#points-total").textContent = String(state.totals.pointsTotal ?? 0);
  $("#streak").textContent = String(state.totals.streak ?? 0);

  const motionEl = $("#motion-status");
  if (motionEl) {
    if (!motion.enabled) motionEl.textContent = "Ikke støttet";
    else {
      const steps = motion.stepConfidence != null ? Math.round(motion.stepConfidence * 100) : 0;
      const cad = motion.cadenceSpm ? Math.round(motion.cadenceSpm) : 0;
      motionEl.textContent = cad ? `${steps}% • ${cad} spm` : `${steps}%`;
    }
  }

  const bonusEl = $("#bonus-status");
  if (bonusEl) {
    if (hasDoubleBonus(state, dateKey)) bonusEl.textContent = `Dobbel t.o.m. ${state.bonuses.doubleUntil}`;
    else {
      const km3 = calc3DayKm(state, dateKey);
      bonusEl.textContent = `${km3.toFixed(1)} / 5.0 km (3 dager)`;
    }
  }
}

function updateSessionUi() {
  const status = $("#session-status");
  const start = $("#btn-start");
  const stop = $("#btn-stop");

  if (!status || !start || !stop) return;
  if (session.active) {
    status.textContent = "Aktiv";
    status.classList.add("is-on");
    status.classList.remove("is-off");
    start.disabled = true;
    stop.disabled = false;
  } else {
    status.textContent = "Ikke aktiv";
    status.classList.remove("is-on");
    status.classList.add("is-off");
    start.disabled = false;
    stop.disabled = true;
  }
}

function centerOnAvatar() {
  if (mapMode === "3d" && map3dMarker && map3d) {
    const ll = map3dMarker.getLngLat();
    map3d.easeTo({ center: [ll.lng, ll.lat], zoom: Math.max(map3d.getZoom(), 16), duration: 600 });
    return;
  }
  if (!map || !avatarMarker) return;
  map.setView(avatarMarker.getLatLng(), Math.max(map.getZoom(), 16), { animate: true });
}

function maybeUpdateStreak(dateKey) {
  const last = state.totals.lastActiveDate;
  if (!last) {
    state.totals.streak = 1;
    state.totals.lastActiveDate = dateKey;
    return;
  }
  if (last === dateKey) return;

  const lastD = new Date(`${last}T00:00:00`);
  const curD = new Date(`${dateKey}T00:00:00`);
  const diffDays = Math.round((curD - lastD) / (1000 * 60 * 60 * 24));

  if (diffDays === 1) state.totals.streak = (state.totals.streak ?? 0) + 1;
  else state.totals.streak = 1;

  state.totals.lastActiveDate = dateKey;
}

function motivationMessage(activity, pointsGained) {
  if (activity === "går" && pointsGained > 0) return "Sterkt! Du samler poeng ved å gå. Klarer du litt til?";
  if (activity === "sykler" && pointsGained > 0) return "Nice! Sykling teller. Husk hjelm og fortsett!";
  if (activity === "kjøretøy") return "Det ser ut som du kjører/er på kollektiv. Ingen poeng nå — prøv å gå eller sykle litt!";
  if (activity === "ukjent") return "GPS er litt usikker nå. Gå litt til, så stabiliserer det seg.";
  if (activity === "stille") return "Start rolig! Når du begynner å gå/sykle, begynner poengene å telle.";
  return "Heia! Hold deg i gang.";
}

function canAwardPoints(activity, speedMps) {
  // Anti-cheat gate:
  // - if motion sensor available, require some movement “texture”
  // - if speed stays high and very stable, suspect vehicle/scooter and block
  if (activity === "kjøretøy") return { ok: false, why: "Kjøretøy/kollektiv" };
  if (activity !== "går" && activity !== "sykler") return { ok: false, why: "Ikke aktiv nok" };

  if (!motion.enabled) return { ok: true, why: "Sensor ikke tilgjengelig" };

  const score = motion.score ?? 0;
  const stepC = motion.stepConfidence ?? 0;
  const cad = motion.cadenceSpm ?? 0;

  // Require "real body movement" like a watch.
  // - For walking: require step-like cadence.
  // - For cycling: allow smoother, but still require some motion texture.
  if (activity === "går") {
    if (stepC < 0.20 || cad < 80) return { ok: false, why: "Ingen steg registrert" };
  } else if (activity === "sykler") {
    if (score < 0.12 && stepC < 0.10) return { ok: false, why: "Lite kroppsbevegelse" };
  }

  // Stable high speed suggests vehicle/e-scooter. Block if >4.2 m/s for a while with low motion.
  if (typeof speedMps === "number" && speedMps > 4.2 && score < 0.16 && motion.stableHighSpeedSeconds >= 35) {
    return { ok: false, why: "Mistenker kjøretøy/sparkesykkel" };
  }

  // Extra e-scooter heuristic: medium-high speed with very low steps + low motion texture.
  if (typeof speedMps === "number" && speedMps >= 3.0 && speedMps <= 7.0 && stepC < 0.12 && score < 0.14) {
    return { ok: false, why: "Mistenker sparkesykkel" };
  }

  return { ok: true, why: "OK" };
}

function applyBonusMultiplier(dateKey, basePoints) {
  if (!basePoints) return 0;
  if (hasDoubleBonus(state, dateKey)) return basePoints * 2;
  return basePoints;
}

function onPosition(pos) {
  const { latitude, longitude, accuracy, speed } = pos.coords;
  const ts = pos.timestamp || Date.now();
  const latlng = { lat: latitude, lng: longitude };

  ensureMap();
  // Snap Map-like offline location memory (always store last known + trail locally)
  pushTrailPoint(latlng, ts, accuracy);

  if (!session.lastPos) {
    session.lastPos = { latlng, ts, speed, accuracy };
    session.lastAcceptedPos = { latlng, ts };
    if (mapMode === "3d") {
      map3dMarker?.setLngLat([latlng.lng, latlng.lat]);
      map3d?.jumpTo({ center: [latlng.lng, latlng.lat], zoom: 16 });
      renderTrailOn3D();
    } else {
      avatarMarker.setLatLng(latlng);
      pathLine.addLatLng(latlng);
      map.setView([latlng.lat, latlng.lng], 16);
      renderTrailOn2D();
    }
    session.lastActivity = "—";
    updateStatsUi();
    return;
  }

  const prev = session.lastPos;
  session.lastPos = { latlng, ts, speed, accuracy };

  const dt = Math.max(1, (ts - prev.ts) / 1000);

  // If speed is missing (common), estimate from distance / time.
  const dist = haversineMeters(prev.latlng, latlng);
  let speedMps = typeof speed === "number" && !Number.isNaN(speed) ? speed : dist / dt;

  // Filter unrealistic jumps (GPS spikes)
  if (dist > 120 && dt < 5) return;
  if (typeof accuracy === "number" && accuracy > 120) return;

  // Smooth a bit.
  if (typeof session.lastSpeedMps === "number") {
    speedMps = 0.7 * session.lastSpeedMps + 0.3 * speedMps;
  }
  session.lastSpeedMps = speedMps;
  updateStableSpeedHeuristic(speedMps, dt);

  const activity = detectActivity(speedMps, accuracy);
  session.lastActivity = activity;

  if (mapMode === "3d") {
    map3dMarker?.setLngLat([latlng.lng, latlng.lat]);
    renderTrailOn3D();
  } else {
    avatarMarker.setLatLng(latlng);
    pathLine.addLatLng(latlng);
    renderTrailOn2D();
  }

  // Only count points if session active and movement looks like walking/cycling.
  const dateKey = nowIsoDate();
  const d = getDaily(state, dateKey);

  if (session.active) {
    const deltaFromAccepted = session.lastAcceptedPos
      ? haversineMeters(session.lastAcceptedPos.latlng, latlng)
      : dist;

    // Only accept increments if meaningful movement.
    if (deltaFromAccepted >= 8) {
      const gate = canAwardPoints(activity, speedMps);
      let pts = 0;
      if (gate.ok) {
        pts = pointsForDelta(activity, deltaFromAccepted);
        pts = applyBonusMultiplier(dateKey, pts);
      }

      if (pts > 0) {
        d.points = (d.points ?? 0) + pts;
        d.activeMeters = (d.activeMeters ?? 0) + deltaFromAccepted;
        state.totals.pointsTotal = (state.totals.pointsTotal ?? 0) + pts;
        maybeUpdateStreak(dateKey);
      }
      session.lastAcceptedPos = { latlng, ts };

      // Motivation rate limiting
      const mot = $("#motivation");
      if (mot) {
        const now = Date.now();
        if (now - (d.lastMotivationAt ?? 0) > 35_000) {
          d.lastMotivationAt = now;
          const msg =
            pts > 0
              ? motivationMessage(activity, pts)
              : gate.ok
                ? motivationMessage(activity, pts)
                : `Ingen poeng: ${gate.why}.`;
          const variant = pts > 0 ? "is-good" : gate.ok ? (activity === "kjøretøy" ? "is-warn" : null) : "is-warn";
          setNotice(mot, msg, variant);
        }
      }

      // Check/award bonus after updating distances
      ensureDoubleBonusIfEarned(state, dateKey);
    }
  }

  saveState(state);
  updateStatsUi();
  updateSessionUi();
  updateTrailUi();
  updateLocationStatusUi();
}

function onPositionError(err) {
  const mot = $("#motivation");
  if (!mot) return;
  const msg =
    err && err.code === 1
      ? "Du må tillate posisjon for å bruke kartet."
      : "Fikk ikke tak i posisjon akkurat nå. Prøv igjen.";
  setNotice(mot, msg, "is-warn");
}

function startSession() {
  ensureMap();
  const mot = $("#motivation");
  if (mot) setNotice(mot, "Starter GPS + sensorer… gå eller sykle for å få poeng.", null);

  if (!navigator.geolocation) {
    if (mot) setNotice(mot, "Nettleseren støtter ikke GPS på denne enheten.", "is-warn");
    return;
  }

  requestMotionPermissionIfNeeded().then((ok) => {
    if (ok) startMotion();
  });

  if (session.watchId != null) navigator.geolocation.clearWatch(session.watchId);

  session.active = true;
  updateSessionUi();

  // Try high accuracy; mobile browsers may throttle in background.
  session.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1500,
    timeout: 15_000,
  });
}

function stopSession() {
  session.active = false;
  updateSessionUi();
  if (session.watchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(session.watchId);
    session.watchId = null;
  }
  const mot = $("#motivation");
  if (mot) setNotice(mot, "Økta er stoppet. Bra jobba i dag!", "is-good");
}

function initNav() {
  for (const btn of document.querySelectorAll(".nav__btn")) {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      setView(view);
      if (view === "play") {
        ensureMap();
        // Leaflet needs an invalidate when container becomes visible
        setTimeout(() => {
          if (mapMode === "3d") map3d && map3d.resize();
          else map && map.invalidateSize();
        }, 50);
      }
      if (view === "school") {
        renderSchool();
      }
      updateHeaderSubtitle();
      updateProfileForm();
      updateStatsUi();
    });
  }
}

function initOnboarding() {
  const form = $("#onboarding-form");
  if (!form) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const profile = {
      kommune: String(fd.get("kommune") || "").trim(),
      skole: String(fd.get("skole") || "").trim(),
      tlf: String(fd.get("tlf") || "").trim(),
      epost: String(fd.get("epost") || "").trim(),
    };

    if (!profile.kommune || !profile.skole || !profile.tlf || !profile.epost) return;

    state.profile = profile;
    saveState(state);

    updateHeaderSubtitle();
    updateProfileForm();
    setView("play");
    ensureMap();
    setTimeout(() => map && map.invalidateSize(), 60);
    updateStatsUi();
    updateSessionUi();

    const mot = $("#motivation");
    if (mot) setNotice(mot, "Velkommen! Trykk “Start dagens tur” når du går hjemmefra.", "is-good");
  });
}

function initProfile() {
  // Supabase config UI
  const cfg = loadSupabaseConfig();
  const urlEl = document.querySelector("#sb-url");
  const anonEl = document.querySelector("#sb-anon");
  if (urlEl) urlEl.value = cfg?.url ?? "";
  if (anonEl) anonEl.value = cfg?.anon ?? "";
  document.querySelector("#btn-sb-save")?.addEventListener("click", () => {
    const url = String(document.querySelector("#sb-url")?.value || "").trim();
    const anon = String(document.querySelector("#sb-anon")?.value || "").trim();
    if (!url || !anon) return;
    saveSupabaseConfig({ url, anon });
    sb = null;
    ensureSupabase();
    updateSupabaseUi();
    setNotice(document.querySelector("#win-notice"), "Supabase lagret. Klar for online toppliste.", "is-good");
  });
  document.querySelector("#btn-sb-clear")?.addEventListener("click", () => {
    clearSupabaseConfig();
    sb = null;
    updateSupabaseUi();
    setNotice(document.querySelector("#win-notice"), "Supabase fjernet (tilbake til lokal demo).", "is-good");
    updateAuthUi();
  });
  updateSupabaseUi();

  // Auth UI (email OTP / magic link)
  const authEmail = document.querySelector("#auth-email");
  const authName = document.querySelector("#auth-name");
  if (authEmail && state.profile?.epost) authEmail.value = state.profile.epost;
  if (authName && state.profile?.epost) authName.value = String(state.profile.epost).split("@")[0] || "";

  document.querySelector("#btn-auth-login")?.addEventListener("click", async () => {
    const client = ensureSupabase();
    if (!client) {
      setNotice(document.querySelector("#win-notice"), "Konfigurer Supabase først.", "is-warn");
      return;
    }
    const email = String(authEmail?.value || "").trim();
    if (!email) return;
    const redirectTo = `${location.origin}${location.pathname}`;
    const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
    if (error) {
      setNotice(document.querySelector("#win-notice"), `Innlogging feilet: ${error.message}`, "is-warn");
      return;
    }
    setNotice(document.querySelector("#win-notice"), "Sjekk e-posten din for innloggingslink.", "is-good");
    await updateAuthUi();
  });

  document.querySelector("#btn-auth-logout")?.addEventListener("click", async () => {
    const client = ensureSupabase();
    if (!client) return;
    await client.auth.signOut();
    setNotice(document.querySelector("#win-notice"), "Logget ut.", "is-good");
    await updateAuthUi();
  });

  // Keep status fresh
  updateAuthUi();
  ensureSupabase()?.auth.onAuthStateChange(async () => {
    await updateAuthUi();
    await ensureProfileInSupabase(String(authName?.value || ""));
  });

  const form = $("#profile-form");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const profile = {
        kommune: String(fd.get("kommune") || "").trim(),
        skole: String(fd.get("skole") || "").trim(),
        tlf: String(fd.get("tlf") || "").trim(),
        epost: String(fd.get("epost") || "").trim(),
      };
      if (!profile.kommune || !profile.skole || !profile.tlf || !profile.epost) return;
      state.profile = profile;
      saveState(state);
      updateHeaderSubtitle();
      setNotice($("#win-notice"), "Profil lagret.", "is-good");
      ensureProfileInSupabase(String(authName?.value || ""));
    });
  }

  const reset = $("#btn-reset");
  if (reset) {
    reset.addEventListener("click", () => {
      stopSession();
      state = defaultState();
      saveState(state);
      location.reload();
    });
  }

  const fakeWin = $("#btn-fake-win");
  if (fakeWin) {
    fakeWin.addEventListener("click", () => {
      const kommune = state.profile?.kommune ?? "kommunen";
      setNotice(
        $("#win-notice"),
        `Gratulerer! I en ekte versjon ville du fått en “premie” i ${kommune}.`,
        "is-good",
      );
    });
  }
}

function initPlayControls() {
  $("#btn-start")?.addEventListener("click", startSession);
  $("#btn-stop")?.addEventListener("click", stopSession);
  $("#btn-center")?.addEventListener("click", centerOnAvatar);
  $("#btn-panel")?.addEventListener("click", () => {
    const play = document.querySelector(".play");
    if (!play) return;
    const collapsed = play.classList.toggle("is-panel-collapsed");
    const btn = $("#btn-panel");
    if (btn) {
      btn.textContent = collapsed ? "Vis" : "Skjul";
      btn.setAttribute("aria-expanded", String(!collapsed));
    }
    // Ensure map gets a resize after layout change
    setTimeout(() => {
      if (mapMode === "3d") map3d && map3d.resize();
      else map && map.invalidateSize();
    }, 80);
  });
  $("#btn-refresh-location")?.addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lastGeoError = null;
        onPosition(pos);
        centerOnAvatar();
        updateLocationStatusUi();
        setNotice($("#motivation"), "Oppdaterte posisjon (kun lokalt).", "is-good");
      },
      (err) => {
        noteGeoError(err);
        setNotice($("#motivation"), "Kunne ikke hente posisjon. Sjekk at posisjon er tillatt.", "is-warn");
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
    );
  });
  $("#btn-toggle-trail")?.addEventListener("click", () => {
    const m = (state.map ??= { trailEnabled: true, lastKnown: null, trail: [] });
    m.trailEnabled = !m.trailEnabled;
    saveState(state);
    updateTrailUi();
    renderTrailOn2D();
    renderTrailOn3D();
    setNotice($("#motivation"), m.trailEnabled ? "Spor vises (kun lokalt)." : "Spor skjult (kun lokalt).", "is-good");
  });
  $("#btn-clear-trail")?.addEventListener("click", () => {
    const m = (state.map ??= { trailEnabled: true, lastKnown: null, trail: [] });
    m.trail = [];
    saveState(state);
    renderTrailOn2D();
    renderTrailOn3D();
    setNotice($("#motivation"), "Spor slettet på denne enheten.", "is-good");
  });
}

function requestMotionPermissionIfNeeded() {
  // iOS requires a user gesture for motion permission.
  const needsPermission =
    typeof DeviceMotionEvent !== "undefined" &&
    typeof DeviceMotionEvent.requestPermission === "function";

  if (!needsPermission) return Promise.resolve(true);
  return DeviceMotionEvent.requestPermission()
    .then((res) => res === "granted")
    .catch(() => false);
}

function startMotion() {
  if (typeof window.DeviceMotionEvent === "undefined") {
    motion.enabled = false;
    return;
  }

  const handler = (e) => {
    const acc = e.accelerationIncludingGravity || e.acceleration || {};
    const x = typeof acc.x === "number" ? acc.x : 0;
    const y = typeof acc.y === "number" ? acc.y : 0;
    const z = typeof acc.z === "number" ? acc.z : 0;
    const mag = Math.sqrt(x * x + y * y + z * z);
    const t = Date.now();

    // Update at ~20Hz max
    if (t - motion.lastSampleAt < 40) return;
    motion.lastSampleAt = t;

    // Exponential moving average + variance proxy
    const alpha = 0.12;
    const prevEma = motion.ema || mag;
    const ema = prevEma + alpha * (mag - prevEma);
    const diff = mag - ema;
    const varAlpha = 0.10;
    motion.variance = (motion.variance || 0) + varAlpha * (diff * diff - (motion.variance || 0));
    motion.ema = ema;

    // Score 0..1 based on variance (tuned for phone-in-pocket)
    // 0.1 ~ still, 0.7+ ~ lots of motion
    const v = motion.variance || 0;
    motion.score = clamp((v - 0.06) / 0.55, 0, 1);
    motion.lastUpdatedAt = t;

    // Step / cadence estimation (watch-like feeling)
    // High-pass-ish signal from diff (removes gravity + slow drift)
    const hp = diff;
    const hpAbs = Math.abs(hp);
    // Smooth amplitude envelope
    motion.hpEma = (motion.hpEma || hpAbs) + 0.18 * (hpAbs - (motion.hpEma || hpAbs));

    // Dynamic threshold: requires some movement amplitude
    const thr = Math.max(0.22, (motion.hpEma || 0) * 0.85);
    const minStepGapMs = 280; // prevents double-counting
    const maxStepGapMs = 1400; // ignore very slow/erratic

    // Peak-ish detection: "hpAbs" crossing threshold with refractory period
    if (hpAbs > thr && t - (motion.lastStepAt || 0) > minStepGapMs) {
      const gap = t - (motion.lastStepAt || 0);
      if (!motion.lastStepAt || gap < maxStepGapMs) {
        motion.stepCount = (motion.stepCount || 0) + 1;
        // cadence in steps per minute from last gap
        if (motion.lastStepAt && gap > 0) {
          const spm = 60000 / gap;
          // clamp plausible walking cadence 60–200 spm
          const clamped = clamp(spm, 60, 200);
          motion.cadenceSpm = motion.cadenceSpm ? 0.7 * motion.cadenceSpm + 0.3 * clamped : clamped;
        }
        motion.lastStepAt = t;
      }
    }

    // Confidence: steps recently + cadence plausible
    const sinceStepMs = t - (motion.lastStepAt || 0);
    const recent = sinceStepMs < 1500 ? 1 : sinceStepMs < 3000 ? 0.5 : 0;
    const cadenceOk = motion.cadenceSpm >= 80 && motion.cadenceSpm <= 190 ? 1 : 0.4;
    motion.stepConfidence = clamp((recent * 0.65 + cadenceOk * 0.35) * motion.score, 0, 1);
  };

  window.addEventListener("devicemotion", handler, { passive: true });
  motion.enabled = true;
}

function updateStableSpeedHeuristic(speedMps, dt) {
  if (!motion.enabled) return;
  if (typeof speedMps !== "number") return;
  const score = motion.score ?? 0;
  if (speedMps > 4.2 && score < 0.16) motion.stableHighSpeedSeconds += dt;
  else motion.stableHighSpeedSeconds = Math.max(0, motion.stableHighSpeedSeconds - dt * 0.5);
  motion.stableHighSpeedSeconds = clamp(motion.stableHighSpeedSeconds, 0, 180);
}

async function renderSchool() {
  const dateKey = nowIsoDate();
  const seasonKey = seasonKeyFromDate(dateKey);
  const seasonPill = $("#season-pill");
  if (seasonPill) seasonPill.textContent = `Sesong: ${seasonKey}`;

  const seasonStats = calcSeasonStats(state, seasonKey);
  const seasonDistanceEl = $("#season-distance");
  if (seasonDistanceEl) seasonDistanceEl.textContent = `${(seasonStats.activeMeters / 1000).toFixed(2)} km`;
  const seasonPointsEl = $("#season-points");
  if (seasonPointsEl) seasonPointsEl.textContent = String(seasonStats.points);
  const seasonRangeEl = $("#season-range");
  if (seasonRangeEl) {
    seasonRangeEl.textContent = seasonStats.range ? `${seasonStats.range.startIso} → ${seasonStats.range.endIso}` : "—";
  }

  const school = state.profile?.skole ?? "";
  const online = ensureSupabase();
  const onlineRows = online ? await fetchSchoolLeaderboardFromSupabase(seasonKey, school) : null;
  const rows = onlineRows
    ? onlineRows
    : (state.school?.publishedScores ?? [])
        .filter((r) => r.seasonKey === seasonKey && r.school === school)
        .sort((a, b) => b.points - a.points)
        .slice(0, 10);

  const winnerBox = $("#winner-box");
  if (winnerBox) {
    if (!school) winnerBox.textContent = "Registrer skole i Profil først.";
    else if (rows.length === 0) winnerBox.textContent = "Ingen publiserte poeng ennå. Trykk “Publiser poeng” i denne demoen.";
    else {
      winnerBox.textContent = `🏆 ${rows[0].name} leder med ${rows[0].points} poeng.`;
      if (online) {
        const w = await fetchSeasonWinnerFromSupabase(seasonKey, school);
        if (w) {
          winnerBox.textContent = `🏆 ${w.name} leder med ${w.points} poeng • ${(w.activeMeters / 1000).toFixed(2)} km`;
        }
      }
    }
  }

  const lb = $("#leaderboard");
  if (lb) {
    lb.innerHTML = "";
    rows.forEach((r, i) => {
      const el = document.createElement("div");
      el.className = "leaderboard__row";
      el.innerHTML = `
        <div class="row" style="gap:10px">
          <div class="leaderboard__pos">${i + 1}</div>
          <div>
            <div class="leaderboard__name">${escapeHtml(r.name)}</div>
            <div class="leaderboard__meta">${escapeHtml(r.school)} • ${escapeHtml(r.kommune)}</div>
          </div>
        </div>
        <div class="leaderboard__score">${r.points}</div>
      `;
      lb.appendChild(el);
    });
  }
}

async function fetchSchoolLeaderboardFromSupabase(seasonKey, school) {
  const client = ensureSupabase();
  if (!client || !school) return null;
  const { data, error } = await client
    .from("season_scores")
    .select("points, active_meters, season_key, skole, kommune, user_id, profiles(display_name)")
    .eq("season_key", seasonKey)
    .eq("skole", school)
    .order("points", { ascending: false })
    .limit(10);
  if (error) return null;
  return (data ?? []).map((r) => ({
    name: r.profiles?.display_name ?? "spiller",
    school: r.skole,
    kommune: r.kommune,
    seasonKey: r.season_key,
    points: r.points ?? 0,
    activeMeters: r.active_meters ?? 0,
  }));
}

async function fetchSeasonWinnerFromSupabase(seasonKey, school) {
  const client = ensureSupabase();
  if (!client || !school) return null;
  // Uses the view from README (season_winners). If not created, this will fail silently.
  const { data, error } = await client
    .from("season_winners")
    .select("season_key, skole, kommune, user_id, points, active_meters, profiles(display_name)")
    .eq("season_key", seasonKey)
    .eq("skole", school)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  if (!data) return null;
  return {
    name: data.profiles?.display_name ?? "spiller",
    points: data.points ?? 0,
    activeMeters: data.active_meters ?? 0,
    kommune: data.kommune ?? "",
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#039;";
      default:
        return c;
    }
  });
}

function boot() {
  initNav();
  initOnboarding();
  initProfile();
  initPlayControls();

  // Initial route
  if (!state.profile) {
    setView("onboarding");
  } else {
    setView("play");
    ensureMap();
    setTimeout(() => {
      if (mapMode === "3d") map3d && map3d.resize();
      else map && map.invalidateSize();
    }, 60);
  }

  updateHeaderSubtitle();
  updateProfileForm();
  updateStatsUi();
  updateSessionUi();

  // Map key UI
  const keyInput = $("#maptiler-key");
  if (keyInput) keyInput.value = maptilerKey() || "";
  $("#btn-save-key")?.addEventListener("click", () => {
    const v = String($("#maptiler-key")?.value || "").trim();
    if (!v) return;
    localStorage.setItem(MAPTILER_STORAGE_KEY, v);
    // Recreate 3D map with new key
    if (map3d) {
      try {
        map3d.remove();
      } catch {
        // ignore
      }
      map3d = null;
      map3dMarker = null;
    }
    mapMode = "3d";
    ensureMap3D();
    const ll = session.lastPos?.latlng;
    if (ll) map3dMarker?.setLngLat([ll.lng, ll.lat]);
    setTimeout(() => map3d && map3d.resize(), 80);
    setNotice($("#motivation"), "3D-kart aktivert (satellitt).", "is-good");
  });

  // Motion setup
  // Start listening immediately where allowed; iOS will need permission after first click.
  startMotion();

  // Snap Map-like tracking while app is open (offline/local only).
  // This updates your position on the map even when the session is not active.
  startSnapMapTracking();
  updateLocationStatusUi();

  // School actions
  $("#btn-publish-score")?.addEventListener("click", async () => {
    if (!state.profile) return;
    const ok = await requestMotionPermissionIfNeeded();
    if (ok) startMotion();

    const dateKey = nowIsoDate();
    const seasonKey = seasonKeyFromDate(dateKey);
    const school = state.profile.skole;
    const kommune = state.profile.kommune;
    const points = state.totals.pointsTotal ?? 0;
    const seasonStats = calcSeasonStats(state, seasonKey);

    const client = ensureSupabase();
    if (client) {
      const { data: sess } = await client.auth.getSession();
      const user = sess?.session?.user;
      if (!user) {
        setNotice($("#winner-box"), "Logg inn først (Profil → Innlogging).", "is-warn");
        return;
      }
      await ensureProfileInSupabase();
      const row = {
        user_id: user.id,
        season_key: seasonKey,
        skole: school,
        kommune: kommune,
        points: seasonStats.points,
        active_meters: Math.round(seasonStats.activeMeters),
      };
      const { error } = await client.from("season_scores").upsert(row, { onConflict: "user_id,season_key" });
      if (error) {
        setNotice($("#winner-box"), `Kunne ikke publisere: ${error.message}`, "is-warn");
        return;
      }
      setView("school");
      await renderSchool();
      setNotice($("#winner-box"), "Publisert til online toppliste!", "is-good");
    } else {
      const name = (state.profile.epost || "spiller").split("@")[0] || "spiller";
      const entry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name,
        school,
        kommune,
        seasonKey,
        points: seasonStats.points,
        activeMeters: seasonStats.activeMeters,
      };
      state.school.publishedScores = [...(state.school.publishedScores ?? []).filter((r) => r.name !== name), entry];
      saveState(state);
      setView("school");
      await renderSchool();
      setNotice($("#winner-box"), "Publisert! (Demo: lagres bare lokalt)", "is-good");
    }
  });

  $("#btn-tv")?.addEventListener("click", async () => {
    document.body.classList.toggle("is-tv", true);
    setView("school");
    renderSchool();
    if (document.documentElement.requestFullscreen) {
      try {
        await document.documentElement.requestFullscreen();
      } catch {
        // ignore
      }
    }
  });

  // Prime GPS once to place avatar even before starting session (no points).
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(onPosition, () => {}, {
      enableHighAccuracy: true,
      maximumAge: 10_000,
      timeout: 8_000,
    });
  }
}

boot();
