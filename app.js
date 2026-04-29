/* global L, maplibregl, supabase */

const STORAGE_KEY = "gaAppen_v1";
const MAPTILER_STORAGE_KEY = "gaAppen_maptiler_key";
/** Vector 3D base: minimal “game map” look — fewer raster overlays than streets, smoother zoom. */
const MAPTILER_3D_STYLE_ID = "basic-v2";

function primaryVectorSourceIdFromStyle(style) {
  try {
    const sources = style?.sources || {};
    for (const [id, src] of Object.entries(sources)) {
      if (src && src.type === "vector") return id;
    }
  } catch {
    // ignore
  }
  return "openmaptiles";
}
const SUPABASE_STORAGE_KEY = "gaAppen_supabase_v1"; // { url, anon }
const DISPLAY_NAME_STORAGE_KEY = "gaAppen_display_name_v1";

let sb = null;

function loadDisplayName() {
  const v = localStorage.getItem(DISPLAY_NAME_STORAGE_KEY);
  return v ? String(v) : "";
}

function saveDisplayName(name) {
  localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, String(name || "").trim());
}

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
  const dn = loadDisplayName();
  status.textContent = email ? `Innlogget: ${email}${dn ? ` • Navn: ${dn}` : ""}` : "Ikke innlogget";
}

async function ensureProfileInSupabase(displayNameOverride) {
  const client = ensureSupabase();
  if (!client || !state.profile) return;
  const { data: sess } = await client.auth.getSession();
  const user = sess?.session?.user;
  if (!user) return;

  const displayName =
    (displayNameOverride && String(displayNameOverride).trim()) ||
    loadDisplayName() ||
    (state.profile.navn ? String(state.profile.navn).trim() : "") ||
    (state.profile.epost ? String(state.profile.epost).split("@")[0] : "spiller");

  const row = {
    id: user.id,
    display_name: displayName,
    email: user.email ?? null,
    kommune: state.profile.kommune,
    // Supabase schema uses column `skole`; we map it from `lag` in UI.
    skole: state.profile.navn ?? state.profile.lag ?? state.profile.skole ?? "",
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

function formatActivityForUi(a) {
  switch (a) {
    case "går":
      return "Går 🚶";
    case "sykler":
      return "Sykler 🚴";
    case "stille":
      return "Står stille";
    case "kjøretøy":
      return "Kjører / kollektiv";
    case "ukjent":
      return "Sjekker…";
    default:
      return a && a !== "—" ? String(a) : "—";
  }
}

function updatePlayHub() {
  const l1 = $("#play-hub-line1");
  const l2 = $("#play-hub-line2");
  if (!l1 || !l2) return;

  const streak = Number(state.totals?.streak ?? 0);
  const dateKey = nowIsoDate();
  const d = getDaily(state, dateKey);
  const goal = dailyGoalMeters();
  const m = Number(d.activeMeters ?? 0);
  const left = Math.max(0, goal - m);

  const bits = [];
  if (streak > 0) bits.push(`🔥 ${streak} dager på rad`);
  if (isWeeklyBoostActive()) bits.push("⚡ 2× boost (poeng + XP)");
  l1.textContent = bits.length ? bits.join(" • ") : "Klar for en liten tur?";

  if (m < goal) {
    l2.textContent = `${left.toFixed(0)} m igjen til dagens mål — ta det i ditt tempo.`;
  } else {
    l2.textContent = "Dagens mål er i boks! Sjekk Oppgaver for ekstra moro.";
  }
}

function xpNeededForLevel(lvl) {
  // Simple curve: quick early levels, slower later. Tuned for kids: frequent small wins.
  const L = Math.max(1, Number(lvl) || 1);
  return Math.round(180 + 70 * (L - 1) + 18 * (L - 1) * (L - 1));
}

function awardXp(amount, reason) {
  const g = ensureGamification(state);
  const level = (g.level ||= { xp: 0, lvl: 1 });
  const mult = isWeeklyBoostActive() ? 2 : 1;
  const add = Math.max(0, Math.round((Number(amount) || 0) * mult));
  if (!add) return;
  level.xp = Math.max(0, Math.round(Number(level.xp) || 0) + add);
  level.lvl = Math.max(1, Math.round(Number(level.lvl) || 1));
  let leveled = false;
  while (level.xp >= xpNeededForLevel(level.lvl)) {
    level.xp -= xpNeededForLevel(level.lvl);
    level.lvl += 1;
    leveled = true;
  }
  if (leveled) {
    showTrophyToast({ title: `Nivå ${level.lvl}!`, level: "gold", sub: reason ? String(reason) : "Du gikk/syklet deg opp!" });
  }
}

function isWeeklyBoostActive() {
  const g = ensureGamification(state);
  const wk = weekKeyNow();
  return !!g.weeklyBoost?.[wk];
}

function maybeActivateWeeklyBoostFromTasks() {
  const g = ensureGamification(state);
  const wk = weekKeyNow();
  if (g.weeklyBoost?.[wk]) return false;

  const { weekly } = getTaskDefs();
  const doneCount = (weekly ?? []).filter((t) => !!t.done).length;
  if (doneCount < 3) return false;

  g.weeklyBoost[wk] = { activatedAt: Date.now() };
  saveState(state);
  showTrophyToast({ title: "Boost aktiv!", level: "gold", sub: "Du fullførte 3 ukesoppgaver: 2× poeng og 2× XP!" });
  return true;
}

function canClaimDailyRewardToday() {
  const g = ensureGamification(state);
  const r = (g.rewards ||= { lastClaimDate: null, streak: 0, cosmetics: [] });
  const today = nowIsoDate();
  return r.lastClaimDate !== today;
}

function claimDailyReward() {
  const g = ensureGamification(state);
  const r = (g.rewards ||= { lastClaimDate: null, streak: 0, cosmetics: [] });
  const today = nowIsoDate();
  if (r.lastClaimDate === today) return { ok: false, text: "Du har allerede åpnet dagens premie. Kom tilbake i morgen!" };

  // Update streak: if claimed yesterday, +1 else reset.
  const yesterday = addDaysIso(today, -1);
  r.streak = r.lastClaimDate === yesterday ? (Number(r.streak || 0) + 1) : 1;
  r.lastClaimDate = today;

  // Reward: a bit of XP + sometimes a cosmetic sticker.
  const baseXp = 55 + Math.min(45, Math.round((r.streak - 1) * 6));
  awardXp(baseXp, "Daglig premie");

  const cosmetics = [
    { id: "sparkle", name: "✨ Glimt" },
    { id: "leaf", name: "🍃 Blad" },
    { id: "rocket", name: "🚀 Rakett" },
    { id: "crown", name: "👑 Krone" },
    { id: "star", name: "⭐ Stjerne" },
    { id: "trophy", name: "🏆 Mini-trofé" },
  ];
  let gotCosmetic = null;
  const roll = Math.random();
  if (roll < 0.45) {
    // Try to give something new first.
    const owned = new Set((r.cosmetics ?? []).map(String));
    const pool = cosmetics.filter((c) => !owned.has(c.id));
    const pickFrom = pool.length ? pool : cosmetics;
    gotCosmetic = pickFrom[Math.floor(Math.random() * pickFrom.length)];
    if (!owned.has(gotCosmetic.id)) r.cosmetics.push(gotCosmetic.id);
  }

  saveState(state);
  updateStatsUi();
  return {
    ok: true,
    text: gotCosmetic
      ? `Du fikk ${baseXp} XP + et samlemerke: ${gotCosmetic.name} (dag ${r.streak}).`
      : `Du fikk ${baseXp} XP! (dag ${r.streak})`,
  };
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
    const s = JSON.parse(raw);
    // Backward compat: older versions used profile.skole. New UI uses profile.lag.
    if (s?.profile && typeof s.profile === "object") {
      if (!s.profile.lag && s.profile.skole) s.profile.lag = s.profile.skole;
      // New: prefer profile.navn for in-map label.
      if (!s.profile.navn) {
        const dn = loadDisplayName?.() || "";
        const email = s.profile.epost ? String(s.profile.epost) : "";
        const fromEmail = email && email.includes("@") ? email.split("@")[0] : "";
        s.profile.navn = dn || fromEmail || s.profile.lag || "Spiller";
      }
    }
    return s;
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
    gamification: {
      badges: [], // array of { id, earnedAt, title }
      weekly: {}, // weekKey -> { challengeId, progress, target, completedAt? }
      sessions: {}, // dateKey -> { startedAt, endedAt, pointsStart, metersStart }
      level: { xp: 0, lvl: 1 }, // lightweight progression (local/demo)
      rewards: { lastClaimDate: null, streak: 0, cosmetics: [] }, // daily reward + collection
    },
    daily: {}, // by YYYY-MM-DD
  };
}

/** Gamification må eksistere før vi bruker weekly/badges; ikke bruk `a?.b ??=` (ugyldig LHS i flere nettlesere). */
function ensureGamification(s) {
  if (!s.gamification || typeof s.gamification !== "object") {
    s.gamification = {
      badges: [],
      weekly: {},
      sessions: {},
      trophies: {},
      tasks: {},
      level: { xp: 0, lvl: 1 },
      rewards: { lastClaimDate: null, streak: 0, cosmetics: [] },
      weeklyBoost: {}, // weekKey -> { activatedAt }
    };
  } else {
    if (!s.gamification.weekly || typeof s.gamification.weekly !== "object") s.gamification.weekly = {};
    if (!Array.isArray(s.gamification.badges)) s.gamification.badges = [];
    if (!s.gamification.sessions || typeof s.gamification.sessions !== "object") s.gamification.sessions = {};
    if (!s.gamification.trophies || typeof s.gamification.trophies !== "object") s.gamification.trophies = {};
    if (!s.gamification.tasks || typeof s.gamification.tasks !== "object") s.gamification.tasks = {};
    if (!s.gamification.level || typeof s.gamification.level !== "object") s.gamification.level = { xp: 0, lvl: 1 };
    if (!s.gamification.rewards || typeof s.gamification.rewards !== "object") {
      s.gamification.rewards = { lastClaimDate: null, streak: 0, cosmetics: [] };
    } else {
      if (!Array.isArray(s.gamification.rewards.cosmetics)) s.gamification.rewards.cosmetics = [];
      if (typeof s.gamification.rewards.streak !== "number") s.gamification.rewards.streak = 0;
      if (s.gamification.rewards.lastClaimDate != null) {
        s.gamification.rewards.lastClaimDate = String(s.gamification.rewards.lastClaimDate);
      }
    }
    if (!s.gamification.weeklyBoost || typeof s.gamification.weeklyBoost !== "object") s.gamification.weeklyBoost = {};
  }
  return s.gamification;
}

function tasksStore() {
  const g = ensureGamification(state);
  const t = (g.tasks ||= {});
  t.daily ||= {};
  t.weekly ||= {};
  return t;
}

function countActiveDaysLast7(minMeters = 500) {
  const today = new Date();
  let days = 0;
  for (let i = 0; i < 7; i++) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const k = nowIsoFromDate(dt);
    const m = Number(state.daily?.[k]?.activeMeters ?? 0);
    if (m >= minMeters) days += 1;
  }
  return days;
}

function sumLastNDaysActiveMeters(n = 7) {
  const today = new Date();
  let meters = 0;
  for (let i = 0; i < n; i++) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const k = nowIsoFromDate(dt);
    meters += Number(state.daily?.[k]?.activeMeters ?? 0);
  }
  return meters;
}

function getEntryMotivationMessage() {
  if (!state.profile) return null;
  const dateKey = nowIsoDate();
  const d = getDaily(state, dateKey);
  const todayMeters = Number(d.activeMeters ?? 0);
  const todayPoints = Number(d.points ?? 0);
  const streak = Number(state.totals?.streak ?? 0);
  const activeDays = countActiveDaysLast7(500);
  const weekMeters = sumLastNDaysActiveMeters(7);

  const name = String(state.profile?.navn || "Du");
  const km = (todayMeters / 1000).toFixed(1);
  const weekKm = (weekMeters / 1000).toFixed(1);

  if (todayMeters >= 3500 || todayPoints >= 260) {
    return {
      text: `${name}, du har vært kjempeflink i dag! 🔥 (${km} km) Fortsett sånn — du er på vei til å vinne.`,
      variant: "is-good",
    };
  }
  if (streak >= 4 && activeDays >= 4) {
    return {
      text: `${name}, rått! Du har vært aktiv flere dager på rad (streak: ${streak}). Fortsett sånn — dette gir resultater.`,
      variant: "is-good",
    };
  }
  if (activeDays >= 3) {
    return {
      text: `${name}, bra jobba de siste dagene! ${activeDays} aktive dager denne uka (${weekKm} km). I dag kan du ta en ny liten tur.`,
      variant: "is-good",
    };
  }
  if (todayMeters >= 800) {
    return {
      text: `${name}, bra start i dag! (${km} km) Vil du ta litt til og samle mer poeng?`,
      variant: null,
    };
  }
  return {
    text: `${name}, klar for en ny tur? Trykk «Start tur» når du begynner å gå eller sykle, så teller poengene.`,
    variant: null,
  };
}

function maybeShowEntryMotivation() {
  const g = ensureGamification(state);
  const dateKey = nowIsoDate();
  const bucket = (g.entryMotivation ||= {});
  if (bucket.lastShownDate === dateKey) return;
  bucket.lastShownDate = dateKey;
  saveState(state);
  const mot = $("#motivation");
  if (!mot) return;
  const msg = getEntryMotivationMessage();
  if (!msg) return;
  setNotice(mot, msg.text, msg.variant);
}

function getTaskDefs() {
  const dateKey = nowIsoDate();
  const week = weekKeyNow();
  const d = getDaily(state, dateKey);
  const { meters: weekMeters, points: weekPoints } = sumLast7DaysMetersPoints(state);
  const activeDays = countActiveDaysLast7(500);
  const streak = Number(state.totals?.streak ?? 0);
  const startedToday = !!(ensureGamification(state).sessions?.[dateKey]?.startedAt);

  return {
    dateKey,
    week,
    daily: [
      {
        id: "start_tur",
        title: "Start en tur",
        meta: "Trykk «Start tur» minst én gang i dag.",
        done: startedToday,
      },
      {
        id: "walk_1km",
        title: "Gå/sykle 1 km",
        meta: `${(Number(d.activeMeters ?? 0) / 1000).toFixed(2)} / 1.00 km`,
        done: Number(d.activeMeters ?? 0) >= 1000,
      },
      {
        id: "earn_150",
        title: "Få 150 poeng",
        meta: `${Number(d.points ?? 0)} / 150 poeng`,
        done: Number(d.points ?? 0) >= 150,
      },
    ],
    weekly: [
      {
        id: "week_10km",
        title: "10 km denne uka",
        meta: `${(weekMeters / 1000).toFixed(1)} / 10.0 km`,
        done: weekMeters >= 10_000,
      },
      {
        id: "week_3days",
        title: "Aktiv 3 dager",
        meta: `${activeDays} / 3 dager (min. 500m per dag)`,
        done: activeDays >= 3,
      },
      {
        id: "week_streak3",
        title: "Streak 3 dager",
        meta: `${streak} / 3 dager`,
        done: streak >= 3,
      },
    ],
  };
}

function renderTasks() {
  const dailyEl = $("#tasks-daily");
  const weeklyEl = $("#tasks-weekly");
  const pill = $("#tasks-pill");
  if (!dailyEl || !weeklyEl) return;

  const { dateKey, week, daily, weekly } = getTaskDefs();
  if (pill) pill.textContent = `I dag: ${dateKey} • Uke: ${week}`;

  const store = tasksStore();
  const dailyBucket = (store.daily[dateKey] ||= {});
  const weeklyBucket = (store.weekly[week] ||= {});

  const renderList = (el, list, bucket) => {
    el.innerHTML = "";
    for (const it of list) {
      if (it.done && !bucket[it.id]) bucket[it.id] = Date.now();
      const done = !!bucket[it.id] || !!it.done;
      const row = document.createElement("div");
      row.className = `check${done ? " is-done" : ""}`;
      row.innerHTML = `
        <div class="check__row">
          <div class="check__title">${escapeHtml(it.title)}</div>
          <div class="check__badge">${done ? "Ferdig ✅" : "Pågår"}</div>
        </div>
        <div class="check__meta">${escapeHtml(it.meta || "")}</div>
      `;
      el.appendChild(row);
    }
  };

  renderList(dailyEl, daily, dailyBucket);
  renderList(weeklyEl, weekly, weeklyBucket);
  saveState(state);

  // Activates once per week when 3 weekly tasks are done.
  maybeActivateWeeklyBoostFromTasks();
}

function weekKeyNow() {
  return isoWeekKey(new Date());
}

function sumLast7DaysMetersPoints(s) {
  const today = new Date();
  let meters = 0;
  let points = 0;
  for (let i = 0; i < 7; i++) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const k = nowIsoFromDate(dt);
    meters += Number(s.daily?.[k]?.activeMeters ?? 0);
    points += Number(s.daily?.[k]?.points ?? 0);
  }
  return { meters, points };
}

function trophyLevel(value, bronze, silver, gold) {
  if (value >= gold) return "gold";
  if (value >= silver) return "silver";
  if (value >= bronze) return "bronze";
  return null;
}

function pct(n) {
  return `${Math.round(clamp(n, 0, 1) * 100)}%`;
}

let trophyToastQueue = [];
let trophyToastShowing = false;
let lastTrophyCheckAt = 0;

function showTrophyToast(t) {
  trophyToastQueue.push(t);
  if (trophyToastShowing) return;

  const el = document.querySelector("#trophy-toast");
  if (!el) return;
  trophyToastShowing = true;

  const next = () => {
    const item = trophyToastQueue.shift();
    if (!item) {
      trophyToastShowing = false;
      el.hidden = true;
      el.innerHTML = "";
      return;
    }

    const levelClass = item.level === "gold" ? "is-gold" : item.level === "silver" ? "is-silver" : "is-bronze";
    const levelName = item.level === "gold" ? "Gull" : item.level === "silver" ? "Sølv" : "Bronse";

    el.hidden = false;
    el.innerHTML = `
      <div class="toast__card">
        <div class="toast__icon ${levelClass}">🏆</div>
        <div>
          <div class="toast__title">${escapeHtml(levelName)}-trofé: ${escapeHtml(item.title)}</div>
          <div class="toast__sub">${escapeHtml(item.sub || "")}</div>
        </div>
      </div>
    `;

    // Wait for animation to finish before showing the next
    setTimeout(() => {
      next();
    }, 3300);
  };

  next();
}

function checkWeeklyTrophies() {
  const now = Date.now();
  if (now - lastTrophyCheckAt < 2500) return; // throttle
  lastTrophyCheckAt = now;

  if (!state.profile) return;
  const g = ensureGamification(state);
  const week = weekKeyNow();
  const bucket = (g.trophies[week] ??= {}); // trophyId -> level

  const { meters: weekMeters, points: weekPoints } = sumLast7DaysMetersPoints(state);
  const streak = Number(state.totals?.streak ?? 0);

  const defs = [
    {
      id: "week_distance",
      title: "Uke-distanse",
      unit: "km",
      value: weekMeters / 1000,
      thresholds: [5, 12, 20],
      sub: (lvl) => `Du har gått/syklet ${(weekMeters / 1000).toFixed(1)} km denne uka.`,
    },
    {
      id: "week_points",
      title: "Uke-poeng",
      unit: "poeng",
      value: weekPoints,
      thresholds: [300, 800, 1400],
      sub: (lvl) => `Du har ${Math.round(weekPoints)} poeng denne uka.`,
    },
    {
      id: "streak",
      title: "Streak",
      unit: "dager",
      value: streak,
      thresholds: [3, 7, 14],
      sub: (lvl) => `Streak: ${streak} dager på rad.`,
    },
  ];

  for (const d of defs) {
    const lvl = trophyLevel(d.value, d.thresholds[0], d.thresholds[1], d.thresholds[2]);
    if (!lvl) continue;
    const prev = bucket[d.id];
    const order = { bronze: 1, silver: 2, gold: 3 };
    if (prev && order[prev] >= order[lvl]) continue;
    bucket[d.id] = lvl;
    saveState(state);
    showTrophyToast({ title: d.title, level: lvl, sub: d.sub(lvl) });
  }
}

function dailyGoalMeters() {
  // Simple default daily goal. Can be made configurable later.
  return 1500;
}

function updateDailyGoalUi() {
  const text = $("#daily-goal-text");
  const sub = $("#daily-goal-sub");
  const fill = $("#daily-goal-fill");
  if (!text || !sub || !fill) return;

  const goal = dailyGoalMeters();
  const dateKey = nowIsoDate();
  const d = getDaily(state, dateKey);
  const meters = Number(d.activeMeters ?? 0);
  const p = goal > 0 ? meters / goal : 0;
  fill.style.width = pct(p);
  text.textContent = `${(meters / 1000).toFixed(2)} / ${(goal / 1000).toFixed(1)} km`;
  sub.textContent = p >= 1 ? "Jippi — du klarte det!" : `${Math.max(0, goal - meters).toFixed(0)} m igjen (helt greit å ta pause)`;

  // One-time toast per day when goal reached
  const g = ensureGamification(state);
  const key = `daily_goal_${dateKey}`;
  if (p >= 1 && !g.trophies?.[key]) {
    // reuse trophies bucket as a generic "already celebrated" store
    g.trophies ??= {};
    g.trophies[key] = { reachedAt: Date.now() };
    saveState(state);
    showTrophyToast({ title: "Dagens mål", level: "gold", sub: "Du nådde dagens mål. Walk like a boss." });
  }
}

function updateReadyStatusUi() {
  const el = $("#ready-status");
  if (!el) return;

  const lk = state.map?.lastKnown;
  const ageMs = lk?.at ? Date.now() - lk.at : Infinity;
  const gpsOk = Number.isFinite(ageMs) && ageMs < 30_000;
  const gpsText = gpsOk ? "Finner deg ✅" : "Finner GPS…";

  const sensorOk = motion.enabled;
  const sensorText = sensorOk ? "Bevegelse ✅" : "Bevegelse: valgfri";

  let pointsText = "—";
  if (!session.active) pointsText = "Trykk «Start tur» for å telle poeng";
  else {
    const gate = canAwardPoints(session.lastActivity, session.lastSpeedMps ?? 0);
    pointsText = gate.ok ? "Poengene teller nå ⭐" : `Pause: ${gate.why}`;
  }

  el.textContent = `${gpsText} • ${sensorText} • ${pointsText}`;
}

function trophyDefsForUi() {
  const { meters: weekMeters, points: weekPoints } = sumLast7DaysMetersPoints(state);
  const streak = Number(state.totals?.streak ?? 0);
  return [
    {
      id: "week_distance",
      title: "Uke-distanse",
      value: weekMeters,
      unit: "m",
      display: `${(weekMeters / 1000).toFixed(1)} km`,
      thresholds: { bronze: 5000, silver: 12000, gold: 20000 },
    },
    {
      id: "week_points",
      title: "Uke-poeng",
      value: weekPoints,
      unit: "poeng",
      display: `${Math.round(weekPoints)} poeng`,
      thresholds: { bronze: 300, silver: 800, gold: 1400 },
    },
    {
      id: "streak",
      title: "Streak",
      value: streak,
      unit: "dager",
      display: `${streak} dager`,
      thresholds: { bronze: 3, silver: 7, gold: 14 },
    },
  ];
}

function renderWeeklyTrophiesUi() {
  const wrap = $("#trophies-week");
  const sub = $("#trophies-week-sub");
  if (!wrap || !sub) return;
  const week = weekKeyNow();
  sub.textContent = `Uke: ${week} • Resetter hver mandag`;

  const defs = trophyDefsForUi();
  const g = ensureGamification(state);
  const bucket = (g.trophies[week] ||= {}); // trophyId -> level
  const order = { bronze: 1, silver: 2, gold: 3 };

  wrap.innerHTML = "";
  for (const d of defs) {
    const lvl = trophyLevel(d.value, d.thresholds.bronze, d.thresholds.silver, d.thresholds.gold);
    const achieved = lvl ? lvl : null;
    const medalClass = achieved ? `is-${achieved}` : "is-bronze";
    const medalText = achieved ? (achieved === "gold" ? "G" : achieved === "silver" ? "S" : "B") : "—";
    const nextTarget =
      !achieved ? d.thresholds.bronze : achieved === "bronze" ? d.thresholds.silver : achieved === "silver" ? d.thresholds.gold : d.thresholds.gold;
    const prog = nextTarget > 0 ? d.value / nextTarget : 0;

    // sync latest achieved into bucket (no toast here)
    if (achieved && (!bucket[d.id] || order[bucket[d.id]] < order[achieved])) bucket[d.id] = achieved;

    const card = document.createElement("div");
    card.className = "trophy";
    card.innerHTML = `
      <div class="trophy__medal ${achieved ? `is-${achieved}` : "is-silver"}">🏆</div>
      <div>
        <div class="trophy__title">${escapeHtml(d.title)}</div>
        <div class="trophy__meta">${escapeHtml(d.display)} • Neste: ${
          d.unit === "m" ? `${(nextTarget / 1000).toFixed(1)} km` : escapeHtml(String(nextTarget))
        }</div>
        <div class="trophy__bar"><div class="trophy__barfill" style="width:${pct(prog)}"></div></div>
      </div>
    `;
    wrap.appendChild(card);
  }
  saveState(state);
}

async function shareTrophiesImage() {
  const note = $("#share-note");
  const week = weekKeyNow();
  const defs = trophyDefsForUi();
  const name = state.profile?.navn || "Spiller";

  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Background
  const grd = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  grd.addColorStop(0, "#6b63ff");
  grd.addColorStop(1, "#29d8a1");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Card
  ctx.fillStyle = "rgba(11,16,32,0.78)";
  roundRect(ctx, 80, 90, 920, 1170, 48);
  ctx.fill();

  // Title
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.font = "800 56px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("Gå Appen", 140, 190);
  ctx.font = "700 36px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillStyle = "rgba(255,255,255,0.80)";
  ctx.fillText(`${name} • ${week}`, 140, 245);

  // Items
  let y = 340;
  for (const d of defs) {
    const lvl = trophyLevel(d.value, d.thresholds.bronze, d.thresholds.silver, d.thresholds.gold);
    const label = lvl === "gold" ? "Gull" : lvl === "silver" ? "Sølv" : lvl === "bronze" ? "Bronse" : "På vei";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = "800 44px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText(d.title, 140, y);
    ctx.font = "700 34px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.fillText(`${d.display} • ${label}`, 140, y + 52);

    // progress bar
    const nextTarget =
      !lvl ? d.thresholds.bronze : lvl === "bronze" ? d.thresholds.silver : lvl === "silver" ? d.thresholds.gold : d.thresholds.gold;
    const prog = nextTarget > 0 ? d.value / nextTarget : 0;
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    roundRect(ctx, 140, y + 78, 800, 18, 999);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    roundRect(ctx, 140, y + 78, 800 * clamp(prog, 0, 1), 18, 999);
    ctx.fill();

    y += 170;
  }

  ctx.fillStyle = "rgba(255,255,255,0.70)";
  ctx.font = "600 28px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("Walk like a boss.", 140, 1215);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const file = new File([blob], "ga-appen-trofeer.png", { type: "image/png" });

  // Share if possible; otherwise download
  // @ts-ignore
  const canShareFiles = navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }));
  try {
    if (canShareFiles) {
      // @ts-ignore
      await navigator.share({ files: [file], title: "Gå Appen", text: "Trofeer denne uka" });
      if (note) setNotice(note, "Deling sendt.", "is-good");
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ga-appen-trofeer.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      if (note) setNotice(note, "Lastet ned bilde (deling støttes ikke her).", "is-good");
    }
  } catch (e) {
    if (note) setNotice(note, "Deling avbrutt.", "is-warn");
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
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

function isoWeekKey(d = new Date()) {
  // ISO week key like "2026-W17"
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function co2SavedKgFromMeters(meters) {
  // Simple estimate: average passenger car ~180 g CO2 / km (varies a lot).
  const km = meters / 1000;
  return km * 0.18;
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
  const views = ["splash", "loading", "onboarding", "play", "tasks", "leaderboard", "profile", "about"];
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

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForMapReady(timeoutMs = 9000) {
  const start = Date.now();

  // If 3D, wait for idle (style loaded + a frame rendered)
  if (mapMode === "3d") {
    ensureMap3D();
    if (!map3d) return false;
    return await new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try {
          map3d.off("idle", onIdle);
        } catch {
          // ignore
        }
        resolve(ok);
      };
      const onIdle = () => finish(true);
      map3d.once("idle", onIdle);
      setTimeout(() => finish(Date.now() - start < timeoutMs), timeoutMs);
    });
  }

  // 2D: wait for Leaflet tile layer "load" (all visible tiles loaded).
  ensureMap();
  if (!map || !map2dLayer) return false;
  return await new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        map2dLayer.off("load", onLoad);
      } catch {
        // ignore
      }
      resolve(ok);
    };
    const onLoad = () => finish(true);
    map2dLayer.once("load", onLoad);
    setTimeout(() => finish(Date.now() - start < timeoutMs), timeoutMs);
  });
}

async function enterPlayView() {
  setView("loading");
  // Restart the loading slogan animation every time.
  try {
    const s = document.querySelector("#loading-slogan");
    if (s) {
      s.classList.remove("is-anim");
      // force reflow
      void s.offsetWidth;
      s.classList.add("is-anim");
    }
  } catch {
    // ignore
  }
  updateHeaderSubtitle();
  updateProfileForm();
  updateStatsUi();
  updateSessionUi();

  // Start map + location tracking immediately while we show loading.
  ensureMap();
  startSnapMapTracking();

  // Wait for either: map ready OR a short time, then show play anyway (never block forever).
  await Promise.race([waitForMapReady(9000), wait(1800)]);

  setView("play");
  ensureMap();
  try {
    const card = document.querySelector(".play__card");
    if (card) {
      card.classList.remove("is-panel-enter");
      void card.offsetWidth;
      card.classList.add("is-panel-enter");
      setTimeout(() => card.classList.remove("is-panel-enter"), 900);
    }
  } catch {
    // ignore
  }
  setTimeout(() => {
    if (mapMode === "3d") map3d && map3d.resize();
    else map && map.invalidateSize();
  }, 60);

  updateStatsUi();
  updateSessionUi();
  updateLocationStatusUi();
  // Friendly “welcome back” message based on recent activity (show once per day).
  maybeShowEntryMotivation();
}

function refreshLocationAfterResume() {
  if (!navigator.geolocation) return;
  // If we've been away for a while, avoid awarding a huge jump as "walking".
  const now = Date.now();
  const lastTs = session.lastPos?.ts || state.map?.lastKnown?.at || 0;
  const awayMs = lastTs ? now - lastTs : 0;
  if (awayMs > 120_000) suppressAwardOnce = true;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lastGeoError = null;
      onPosition(pos); // updates map + trail + UI immediately
      updateLocationStatusUi();
    },
    (err) => {
      noteGeoError(err);
      updateLocationStatusUi();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
  );
}

let state = loadState() ?? defaultState();
let map = null; // Leaflet fallback
let avatarMarker = null;
let pathLine = null;
let trailLine = null;
let map2dLayer = null;

let map3d = null;
let map3dMarker = null;
let map3dCustomBuildingsAdded = false;
let mapMode = "3d"; // always 3d by default
let map3dTrailSourceReady = false;
let followMode = true; // Pokemon-Go style follow camera
let lastBearing = -18;

// Prevent accidental view switching while pinching/dragging the map on mobile.
let navLockUntil = 0;
function lockNav(ms = 900) {
  navLockUntil = Math.max(navLockUntil, Date.now() + ms);
}

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
  /** Sekunder med «sykelfart» men nesten ingen skritt/vibrasjon → mistenker el-spark. */
  escooterSuspectSeconds: 0,
  /** Sekunder med GPS-hastighet i typisk gå-sone (for lomme-modus uten tydelige enkelt-skritt). */
  walkBandStableSeconds: 0,
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

/** Holder skjermen våken under tur (best effort) — nettlesere pauser ofte GPS/sensor når skjermen sover. */
let screenWakeLock = null;

async function acquireScreenWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    screenWakeLock = await navigator.wakeLock.request("screen");
    screenWakeLock.addEventListener("release", () => {
      screenWakeLock = null;
    });
  } catch {
    screenWakeLock = null;
  }
}

function releaseScreenWakeLock() {
  try {
    const l = screenWakeLock;
    screenWakeLock = null;
    l?.release?.();
  } catch {
    screenWakeLock = null;
  }
}

// When app resumes after a long pause, we may get a big location jump.
// Suppress point awarding for that first fix to avoid unrealistic “backfill”.
let suppressAwardOnce = false;

let snapWatchId = null;
let hasCenteredInitially = false;
let lastGeoError = null; // { code, message, at }

/** Toppliste-fane: «kommune» = filtrert på profil.kommune, «all» = landstoppen. */
let leaderboardScope = "kommune";

function normalizeKommuneKey(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

let weather = {
  lastFetchAt: 0,
  mode: "clear", // clear | rain | snow
  intensity: 0, // 0..1
  cloud: 0, // 0..1
};

let weatherFx = {
  canvas: null,
  ctx: null,
  w: 0,
  h: 0,
  drops: [],
  running: false,
  raf: 0,
};

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
  map2dLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    detectRetina: true,
    updateWhenIdle: false,
    updateWhenZooming: true,
    keepBuffer: 8,
    attribution:
      'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noreferrer">Esri</a> • Data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
  }).addTo(map);

  const start = { lat: 59.9139, lng: 10.7522 }; // Oslo fallback
  map.setView([start.lat, start.lng], 14);

  const avatarIcon = L.divIcon({
    className: "avatar",
    html: `
      <div style="
        display: grid;
        place-items: center;
        gap: 6px;
        transform: translateY(-6px);
      ">
        <div style="
          width: 38px; height: 38px; border-radius: 16px;
          background: linear-gradient(135deg, rgba(124,92,255,.95), rgba(46,229,157,.85));
          border: 2px solid rgba(255,255,255,.65);
          box-shadow: 0 16px 45px rgba(0,0,0,.38);
          display: grid; place-items: center;
          color: #071126; font-weight: 900;
        ">•</div>
        <div style="
          max-width: 120px;
          padding: 4px 8px;
          border-radius: 999px;
          background: rgba(11,16,32,.62);
          border: 1px solid rgba(255,255,255,.16);
          color: rgba(255,255,255,.92);
          font-size: 12px;
          font-weight: 800;
          line-height: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          box-shadow: 0 14px 45px rgba(0,0,0,.35);
          backdrop-filter: blur(10px);
        ">${escapeHtml(state.profile?.navn || "Spiller")}</div>
      </div>
    `,
    iconSize: [150, 74],
    iconAnchor: [75, 62],
  });

  avatarMarker = L.marker([start.lat, start.lng], { icon: avatarIcon }).addTo(map);
  pathLine = L.polyline([], { color: "#7c5cff", weight: 4, opacity: 0.7 }).addTo(map);
  trailLine = L.polyline([], { color: "#2ee59d", weight: 5, opacity: 0.65 }).addTo(map);
  renderTrailOn2D();

  // UX: if the user drags/zooms the map, disable follow so it doesn't fight them.
  map.on("dragstart zoomstart", () => {
    lockNav(1100);
    if (!followMode) return;
    followMode = false;
    const b = document.querySelector("#btn-follow");
    if (b) b.textContent = "Følg: Av";
    setNotice($("#motivation"), "Følg er av (du drar kartet). Trykk «Følg: På» for å følge deg igjen.", null);
  });
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

  const fallbackTo2D = (reason) => {
    // Avoid repeated fallbacks / loops.
    if (mapMode === "2d") return;
    try {
      map3d?.remove();
    } catch {
      // ignore
    }
    map3d = null;
    map3dMarker = null;
    map3dCustomBuildingsAdded = false;
    map3dTrailSourceReady = false;
    mapMode = "2d";
    $("#map")?.classList.remove("is-3d");
    ensureMap();
    setTimeout(() => map && map.invalidateSize(), 60);
    if (mot) {
      setNotice(
        mot,
        reason ||
          "3D-kartet ble midlertidig sperret (for mange forespørsler). Jeg byttet til 2D-kart så du kan fortsette å spille.",
        "is-warn",
      );
    }
  };

  let rateLimitHits = 0;

  map3dCustomBuildingsAdded = false;
  map3d = new maplibregl.Map({
    container: "map",
    // Vector + 3D buildings + terrain: continuous look when zooming (no satellite photo tiles).
    style: `https://api.maptiler.com/maps/${MAPTILER_3D_STYLE_ID}/style.json?key=${key}`,
    center: [10.7522, 59.9139],
    zoom: 15.5,
    pitch: 62,
    bearing: -18,
    antialias: true,
    pixelRatio: Math.min(2.5, (window.devicePixelRatio || 1) * 1.05),
    fadeDuration: 360,
  });
  lastBearing = -18;

  // If MapTiler (or network) rate-limits, don't brick the app.
  // MapLibre emits 'error' events for tile/style/source failures.
  map3d.on("error", (evt) => {
    const err = evt?.error;
    const msg = String(err?.message || "");
    const status = err?.status || err?.statusCode;
    const isRate =
      status === 429 ||
      /429/.test(msg) ||
      /too many requests/i.test(msg) ||
      /rate limit/i.test(msg) ||
      /quota/i.test(msg);
    if (isRate) {
      rateLimitHits += 1;
      // Prefer to keep 3D (as requested). Only auto-fallback after repeated blocks.
      if (mot) {
        setNotice(
          mot,
          "3D-kartet blir sperret akkurat nå (for mange forespørsler). Vent litt og trykk «Prøv 3D igjen», eller legg inn egen MapTiler-nøkkel. (Appen kan bytte til 2D hvis dette fortsetter.)",
          "is-warn",
        );
      }
      if (rateLimitHits >= 3) {
        fallbackTo2D(
          "3D-kartet ble sperret flere ganger (for mange forespørsler). Bytter til 2D-kart så du kan fortsette å spille.",
        );
      }
    }
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
    // Rasters (hillshade, etc.): longer crossfade + linear resampling hides tile edges while zooming.
    const applyRasterTuning = () => {
      try {
        const style = map3d.getStyle();
        for (const layer of style.layers ?? []) {
          if (layer.type !== "raster") continue;
          const lid = String(layer.id || "");
          const isHill = /hill|shade|dem|relief|terrain/i.test(lid);
          try {
            map3d.setPaintProperty(layer.id, "raster-fade-duration", isHill ? 520 : 380);
          } catch {
            // ignore
          }
          try {
            map3d.setPaintProperty(layer.id, "raster-resampling", "linear");
          } catch {
            // ignore
          }
          if (isHill) {
            try {
              map3d.setPaintProperty(layer.id, "raster-opacity", 0.32);
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }
    };

    const touchupBuildingPaint = () => {
      if (!map3d) return;
      const blockColor = [
        "interpolate",
        ["linear"],
        ["coalesce", ["get", "render_height"], ["get", "height"], 0],
        0,
        "#5c6ea3",
        25,
        "#6f82b8",
        70,
        "#8fa0cf",
        140,
        "#b8c4e8",
      ];
      try {
        for (const layer of map3d.getStyle().layers ?? []) {
          if (layer.type !== "fill-extrusion") continue;
          if (layer["source-layer"] !== "building") continue;
          try {
            map3d.setPaintProperty(layer.id, "fill-extrusion-color", blockColor);
            map3d.setPaintProperty(layer.id, "fill-extrusion-opacity", 0.82);
          } catch {
            // ignore
          }
          try {
            map3d.setPaintProperty(layer.id, "fill-extrusion-vertical-gradient", true);
          } catch {
            // ignore
          }
          try {
            map3d.setPaintProperty(layer.id, "fill-extrusion-ambient-occlusion-intensity", 0.18);
          } catch {
            // ignore
          }
          try {
            map3d.setPaintProperty(layer.id, "fill-extrusion-ambient-occlusion-radius", 3);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    };

    const ensureCustomBuildingsIfMissing = () => {
      if (!map3d || map3dCustomBuildingsAdded) return;
      try {
        const layers = map3d.getStyle().layers ?? [];
        const hasBuiltin = layers.some(
          (l) => l.type === "fill-extrusion" && l["source-layer"] === "building",
        );
        if (hasBuiltin) return;
        const labelLayerId = layers.find((l) => l.type === "symbol" && l.layout?.["text-field"])?.id;
        const vSource = primaryVectorSourceIdFromStyle(map3d.getStyle());
        map3d.addLayer(
          {
            id: "ga-3d-buildings",
            source: vSource,
            "source-layer": "building",
            filter: ["==", "extrude", "true"],
            type: "fill-extrusion",
            minzoom: 14,
            paint: {
              "fill-extrusion-color": [
                "interpolate",
                ["linear"],
                ["coalesce", ["get", "render_height"], ["get", "height"], 0],
                0,
                "#5c6ea3",
                25,
                "#6f82b8",
                70,
                "#8fa0cf",
                140,
                "#b8c4e8",
              ],
              "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 12],
              "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
              "fill-extrusion-opacity": 0.82,
              "fill-extrusion-vertical-gradient": true,
            },
          },
          labelLayerId,
        );
        map3dCustomBuildingsAdded = true;
      } catch {
        // ignore
      }
    };

    const tuneAll = () => {
      applyRasterTuning();
      touchupBuildingPaint();
    };
    tuneAll();
    map3d.on("styledata", tuneAll);
    ensureCustomBuildingsIfMissing();
    map3d.once("idle", () => {
      touchupBuildingPaint();
      ensureCustomBuildingsIfMissing();
    });

    // Terrain (3D ground). Works with MapTiler terrain tiles.
    try {
      map3d.addSource("terrain", {
        type: "raster-dem",
        url: `https://api.maptiler.com/tiles/terrain-rgb/tiles.json?key=${key}`,
        tileSize: 256,
      });
      map3d.setTerrain({ source: "terrain", exaggeration: 0.62 });
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

    // Custom 3D marker with name label (pro feel)
    const el = document.createElement("div");
    el.style.display = "grid";
    el.style.placeItems = "center";
    el.style.gap = "6px";
    el.style.transform = "translateY(-10px)";
    const dot = document.createElement("div");
    dot.style.width = "18px";
    dot.style.height = "18px";
    dot.style.borderRadius = "999px";
    dot.style.background = "linear-gradient(135deg, rgba(124,92,255,.95), rgba(46,229,157,.85))";
    dot.style.border = "2px solid rgba(255,255,255,.75)";
    dot.style.boxShadow = "0 16px 45px rgba(0,0,0,.35)";
    const lab = document.createElement("div");
    lab.textContent = state.profile?.navn || "Spiller";
    lab.style.maxWidth = "140px";
    lab.style.padding = "4px 8px";
    lab.style.borderRadius = "999px";
    lab.style.background = "rgba(11,16,32,.62)";
    lab.style.border = "1px solid rgba(255,255,255,.16)";
    lab.style.color = "rgba(255,255,255,.92)";
    lab.style.fontSize = "12px";
    lab.style.fontWeight = "800";
    lab.style.whiteSpace = "nowrap";
    lab.style.overflow = "hidden";
    lab.style.textOverflow = "ellipsis";
    // @ts-ignore
    lab.style.backdropFilter = "blur(10px)";
    el.appendChild(dot);
    el.appendChild(lab);
    map3dMarker = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([10.7522, 59.9139]).addTo(map3d);

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

  // UX: user gesture disables follow (so the camera doesn't fight the finger).
  const stopFollow = () => {
    lockNav(1100);
    if (!followMode) return;
    followMode = false;
    const b = document.querySelector("#btn-follow");
    if (b) b.textContent = "Følg: Av";
    setNotice($("#motivation"), "Følg er av (du drar kartet). Trykk «Følg: På» for å følge deg igjen.", null);
  };
  map3d.on("dragstart", stopFollow);
  map3d.on("zoomstart", stopFollow);
  map3d.on("rotatestart", stopFollow);
  map3d.on("pitchstart", stopFollow);
}

function bearingDeg(from, to) {
  // from/to: {lat,lng}
  const toRad = (x) => (x * Math.PI) / 180;
  const toDeg = (x) => (x * 180) / Math.PI;
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLon = toRad(to.lng - from.lng);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = toDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}

function update3DCamera(latlng, prevLatLng) {
  if (!map3d) return;
  if (!followMode) return;
  const prev = prevLatLng || session.lastPos?.latlng;
  if (prev && (prev.lat !== latlng.lat || prev.lng !== latlng.lng)) {
    const b = bearingDeg(prev, latlng);
    // smooth bearing changes
    const delta = ((b - lastBearing + 540) % 360) - 180;
    lastBearing = (lastBearing + delta * 0.22 + 360) % 360;
  }
  const speed = session.lastSpeedMps ?? 0;
  const targetZoom = speed > 4 ? 16.2 : 16.6; // a bit more zoomed-in when walking
  map3d.easeTo({
    center: [latlng.lng, latlng.lat],
    bearing: lastBearing,
    pitch: 62,
    zoom: Math.max(map3d.getZoom(), targetZoom),
    duration: 380,
    essential: true,
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
  subtitle.textContent = `${state.profile.navn ?? "Spiller"} • ${state.profile.kommune}`;
}

function updateProfileForm() {
  const form = $("#profile-form");
  if (!form || !state.profile) return;
  form.kommune.value = state.profile.kommune;
  if (form.navn) form.navn.value = state.profile.navn ?? "";
  form.tlf.value = state.profile.tlf;
  form.epost.value = state.profile.epost;
}

function updateStatsUi() {
  const dateKey = nowIsoDate();
  const d = getDaily(state, dateKey);
  $("#points-today").textContent = String(d.points ?? 0);
  $("#distance-active").textContent = formatKm(d.activeMeters ?? 0);
  $("#activity-type").textContent = formatActivityForUi(session.lastActivity);
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

  const co2El = $("#co2-today");
  if (co2El) co2El.textContent = `${co2SavedKgFromMeters(d.activeMeters ?? 0).toFixed(1)} kg`;

  // Weekly challenge + badges
  const week = isoWeekKey(new Date());
  const weekly = ensureGamification(state).weekly;
  if (!weekly[week]) {
    // Default weekly challenge (fast, simple): walk/bike 10 km this week
    weekly[week] = { challengeId: "weekly_10km", progress: 0, target: 10_000 };
  }
  // progress = sum active meters this week (approx; computed from daily keys)
  let weekMeters = 0;
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const k = nowIsoFromDate(dt);
    weekMeters += Number(state.daily?.[k]?.activeMeters ?? 0);
  }
  weekly[week].progress = weekMeters;
  if (!weekly[week].completedAt && weekMeters >= weekly[week].target) weekly[week].completedAt = Date.now();

  const weeklyEl = $("#weekly-challenge");
  if (weeklyEl) {
    const km = (weekMeters / 1000).toFixed(1);
    const tgt = (weekly[week].target / 1000).toFixed(0);
    weeklyEl.textContent = weekly[week].completedAt ? `Ferdig! (${km}/${tgt} km)` : `${km}/${tgt} km`;
  }

  const g = ensureGamification(state);
  const levelEl = $("#level-text");
  if (levelEl) {
    const lvl = Math.max(1, Number(g.level?.lvl ?? 1));
    const xp = Math.max(0, Number(g.level?.xp ?? 0));
    const need = xpNeededForLevel(lvl);
    levelEl.textContent = `Lv ${lvl} • ${Math.min(need, xp)}/${need} XP`;
  }

  // Daily reward UI
  const rewardSub = $("#daily-reward-sub");
  const rewardBtn = $("#btn-claim-reward");
  const r = g.rewards || { lastClaimDate: null, streak: 0, cosmetics: [] };
  if (rewardSub) {
    rewardSub.textContent = canClaimDailyRewardToday()
      ? `Gratis nå • dag ${Number(r.streak || 0) + 1}`
      : `Åpnet i dag • kom tilbake i morgen (streak: ${Number(r.streak || 0)})`;
  }
  if (rewardBtn) {
    rewardBtn.disabled = !canClaimDailyRewardToday();
    rewardBtn.textContent = canClaimDailyRewardToday() ? "Åpne" : "Åpnet";
  }

  // Award trophies continuously (weekly reset via weekKey).
  checkWeeklyTrophies();

  // If weekly tasks are completed while in Play view, activate boost immediately.
  maybeActivateWeeklyBoostFromTasks();

  updateDailyGoalUi();
  updateReadyStatusUi();
  updatePlayHub();
  renderWeeklyTrophiesUi();
  // If tasks view is visible, keep it fresh.
  if (!document.querySelector("#view-tasks")?.hidden) renderTasks();
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
  // Anti-cheat: ingen poeng for stille, usikker GPS, bil/kollektiv, el-spark (heuristikk), eller «tur» uten kroppsbevegelse.
  if (activity === "kjøretøy") return { ok: false, why: "Kjøretøy/kollektiv — ingen poeng" };
  if (activity === "stille") return { ok: false, why: "Står stille — ingen poeng før du går/sykler" };
  if (activity === "ukjent") return { ok: false, why: "GPS usikker — ingen poeng akkurat nå" };
  if (activity !== "går" && activity !== "sykler") return { ok: false, why: "Ikke aktiv nok" };

  if (!motion.enabled) return { ok: true, why: "Sensor ikke tilgjengelig" };

  const score = motion.score ?? 0;
  const stepC = motion.stepConfidence ?? 0;
  const cad = motion.cadenceSpm ?? 0;

  // Gå: telefon i lomma gir ofte svakere «skritt»-pigger — godta GPS+gange + vibrasjon, ikke bare høy stepConfidence.
  if (activity === "går") {
    const stableWalk = (motion.walkBandStableSeconds ?? 0) >= 3.2;
    const v = motion.variance ?? 0;
    const strongSteps = stepC >= 0.17 && cad >= 76;
    const pocketWalk =
      stableWalk &&
      score >= 0.065 &&
      v >= 0.032 &&
      (cad >= 62 || stepC >= 0.11);
    const pocketSwing = stableWalk && score >= 0.078 && v >= 0.042 && cad >= 52;
    if (!strongSteps && !pocketWalk && !pocketSwing) {
      return {
        ok: false,
        why: "For lite gange-registrert — tillat bevegelsessensor, eller unngå helt stiv lomme",
      };
    }
  } else if (activity === "sykler") {
    if (score < 0.12 && stepC < 0.10) return { ok: false, why: "Lite kroppsbevegelse (sykkel)" };
  }

  // Akkumulert mistanke om el-spark: jevn «sykkelfart» nesten uten vibrasjon/skritt.
  if (activity === "sykler" && (motion.escooterSuspectSeconds ?? 0) >= 14) {
    return { ok: false, why: "Mistenker el-sparkesykkel — ingen poeng" };
  }

  // Høy hastighet lenge med lav bevegelse → bil / sterk spark.
  if (typeof speedMps === "number" && speedMps > 4.2 && score < 0.16 && motion.stableHighSpeedSeconds >= 28) {
    return { ok: false, why: "Mistenker kjøretøy/el-spark — ingen poeng" };
  }

  // Rask sperre: typisk sparkesone (~12–28 km/t) med veldig lav kroppsaktivitet.
  if (
    typeof speedMps === "number" &&
    speedMps >= 2.5 &&
    speedMps <= 8.2 &&
    stepC < 0.12 &&
    score < 0.14
  ) {
    return { ok: false, why: "Mistenker el-sparkesykkel — ingen poeng" };
  }

  return { ok: true, why: "OK" };
}

function applyBonusMultiplier(dateKey, basePoints) {
  if (!basePoints) return 0;
  let out = basePoints;
  if (hasDoubleBonus(state, dateKey)) out *= 2;
  if (isWeeklyBoostActive()) out *= 2;
  return out;
}

function initWeatherFx() {
  if (weatherFx.canvas) return;
  const canvas = document.querySelector("#weather-fx");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: true });
  weatherFx.canvas = canvas;
  weatherFx.ctx = ctx;

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    weatherFx.w = Math.max(1, Math.round(rect.width * dpr));
    weatherFx.h = Math.max(1, Math.round(rect.height * dpr));
    canvas.width = weatherFx.w;
    canvas.height = weatherFx.h;
  };
  resize();
  window.addEventListener("resize", resize, { passive: true });

  // init particles
  weatherFx.drops = [];
  for (let i = 0; i < 180; i++) weatherFx.drops.push(spawnDrop());
  startWeatherFxLoop();
}

function spawnDrop() {
  return {
    x: Math.random(),
    y: Math.random(),
    z: Math.random(), // depth
    v: 0.8 + Math.random() * 1.6,
  };
}

function startWeatherFxLoop() {
  if (weatherFx.running) return;
  weatherFx.running = true;
  const tick = () => {
    weatherFx.raf = requestAnimationFrame(tick);
    drawWeatherFx();
  };
  tick();
}

function drawWeatherFx() {
  const ctx = weatherFx.ctx;
  if (!ctx) return;
  const w = weatherFx.w;
  const h = weatherFx.h;

  ctx.clearRect(0, 0, w, h);

  // Cloud tint
  const cloud = clamp(weather.cloud ?? 0, 0, 1);
  if (cloud > 0.05) {
    ctx.fillStyle = `rgba(200,220,255,${0.08 * cloud})`;
    ctx.fillRect(0, 0, w, h);
  }

  const mode = weather.mode;
  const intensity = clamp(weather.intensity ?? 0, 0, 1);
  if (intensity <= 0.03) return;

  const count = Math.floor(40 + intensity * 220);
  ctx.save();
  ctx.lineCap = "round";

  if (mode === "rain") {
    ctx.strokeStyle = `rgba(185,220,255,${0.32 + 0.35 * intensity})`;
    ctx.lineWidth = 1.2;
    for (let i = 0; i < Math.min(count, weatherFx.drops.length); i++) {
      const d = weatherFx.drops[i];
      const x = d.x * w;
      const y = d.y * h;
      const len = (10 + d.z * 16) * (0.9 + intensity);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - len * 0.25, y + len);
      ctx.stroke();
      d.y += (0.006 + d.v * 0.0025) * (0.7 + intensity);
      d.x += -0.001 * (0.4 + intensity);
      if (d.y > 1.08) {
        d.y = -0.05;
        d.x = Math.random();
        d.z = Math.random();
        d.v = 0.8 + Math.random() * 1.6;
      }
    }
  } else if (mode === "snow") {
    ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.35 * intensity})`;
    for (let i = 0; i < Math.min(count, weatherFx.drops.length); i++) {
      const d = weatherFx.drops[i];
      const x = d.x * w;
      const y = d.y * h;
      const r = (1.2 + d.z * 2.6) * (0.9 + intensity * 0.3);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      d.y += (0.0025 + d.v * 0.0014) * (0.7 + intensity);
      d.x += Math.sin((Date.now() / 600) + d.z * 6) * 0.0009;
      if (d.y > 1.08) {
        d.y = -0.05;
        d.x = Math.random();
        d.z = Math.random();
        d.v = 0.8 + Math.random() * 1.6;
      }
    }
  }

  ctx.restore();
}

async function maybeFetchWeather(latlng) {
  const now = Date.now();
  if (now - (weather.lastFetchAt ?? 0) < 120_000) return; // every 2 min
  weather.lastFetchAt = now;

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latlng.lat)}` +
      `&longitude=${encodeURIComponent(latlng.lng)}` +
      `&current=precipitation,rain,showers,snowfall,cloud_cover,weather_code` +
      `&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    const cur = data?.current;
    if (!cur) return;
    const precip = Number(cur.precipitation ?? 0);
    const rain = Number(cur.rain ?? 0) + Number(cur.showers ?? 0);
    const snow = Number(cur.snowfall ?? 0);
    const cloud = clamp(Number(cur.cloud_cover ?? 0) / 100, 0, 1);

    if (snow > 0.01) {
      weather.mode = "snow";
      weather.intensity = clamp(snow / 3, 0.1, 1);
    } else if (rain > 0.01 || precip > 0.01) {
      weather.mode = "rain";
      weather.intensity = clamp((rain || precip) / 6, 0.1, 1);
    } else {
      weather.mode = "clear";
      weather.intensity = 0;
    }
    weather.cloud = cloud;
  } catch {
    // ignore
  }
}

function onPosition(pos) {
  const { latitude, longitude, accuracy, speed } = pos.coords;
  const ts = pos.timestamp || Date.now();
  const latlng = { lat: latitude, lng: longitude };

  ensureMap();
  initWeatherFx();
  maybeFetchWeather(latlng);
  // Snap Map-like offline location memory (always store last known + trail locally)
  pushTrailPoint(latlng, ts, accuracy);

  if (!session.lastPos) {
    session.lastPos = { latlng, ts, speed, accuracy };
    session.lastAcceptedPos = { latlng, ts };
    if (mapMode === "3d") {
      map3dMarker?.setLngLat([latlng.lng, latlng.lat]);
      update3DCamera(latlng, null);
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
  const prevLatLng = prev?.latlng;
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
  const activity = detectActivity(speedMps, accuracy);
  updateAntiCheatHeuristics(speedMps, activity, dt);
  session.lastActivity = activity;

  if (mapMode === "3d") {
    map3dMarker?.setLngLat([latlng.lng, latlng.lat]);
    update3DCamera(latlng, prevLatLng);
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
    // If app just resumed after long pause, don't award on the first fix.
    if (suppressAwardOnce) {
      suppressAwardOnce = false;
      session.lastAcceptedPos = { latlng, ts };
      saveState(state);
      updateStatsUi();
      updateSessionUi();
      updateTrailUi();
      updateLocationStatusUi();
      return;
    }

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
        // Progression: XP is driven by real movement/points (healthy “come back” loop).
        awardXp(Math.round(pts * 0.9 + deltaFromAccepted / 90), activity === "går" ? "Gange" : "Sykling");
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

      // Badge: 5 km in 3 days unlock (when bonus triggers)
      if (hasDoubleBonus(state, dateKey)) {
        const badges = ensureGamification(state).badges;
        const id = `bonus_${state.bonuses.doubleUntil}`;
        if (!badges.some((b) => b.id === id)) {
          badges.push({ id, earnedAt: Date.now(), title: "Boost!" });
        }
      }
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

  // Save session baseline so we can show a nice "arrived" summary.
  const dateKey = nowIsoDate();
  (state.gamification ??= { badges: [], weekly: {}, sessions: {} });
  state.gamification.sessions[dateKey] = {
    startedAt: Date.now(),
    endedAt: null,
    pointsStart: Number(getDaily(state, dateKey).points ?? 0),
    metersStart: Number(getDaily(state, dateKey).activeMeters ?? 0),
  };
  saveState(state);
  const arrived = document.querySelector("#btn-arrived");
  if (arrived) arrived.disabled = false;

  // Try high accuracy; mobile browsers may throttle in background.
  session.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1500,
    timeout: 15_000,
  });

  // Unngå at skjermen går i dvale midt i turen (da slår mange mobiler ned GPS/poeng i nettleser).
  void acquireScreenWakeLock();
}

function stopSession() {
  session.active = false;
  releaseScreenWakeLock();
  updateSessionUi();
  if (session.watchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(session.watchId);
    session.watchId = null;
  }
  const mot = $("#motivation");
  if (mot) setNotice(mot, "Økta er stoppet. Bra jobba i dag!", "is-good");

  const arrived = document.querySelector("#btn-arrived");
  if (arrived) arrived.disabled = true;
}

function initNav() {
  for (const btn of document.querySelectorAll(".nav__btn")) {
    btn.addEventListener("click", () => {
      if (Date.now() < navLockUntil) return;
      const view = btn.dataset.view;
      if (view === "play") {
        enterPlayView();
        return;
      }
      setView(view);
      if (view === "play") {
        ensureMap();
        // Leaflet needs an invalidate when container becomes visible
        setTimeout(() => {
          if (mapMode === "3d") map3d && map3d.resize();
          else map && map.invalidateSize();
        }, 50);
      }
      if (view === "tasks") {
        renderTasks();
      }
      if (view === "leaderboard") {
        renderLeaderboard();
      }
      updateHeaderSubtitle();
      updateProfileForm();
      updateStatsUi();
    });
  }
}

function initOnboarding() {
  const form = $("#onboarding-form");
  if (!form) {
    console.warn("ga-appen: #onboarding-form ikke funnet");
    return;
  }

  const runOnboardingComplete = () => {
    const note = document.querySelector("#onboarding-note");
    const showNote = (text, variant = "is-warn") => {
      if (note) {
        note.style.display = "block";
        setNotice(note, text, variant);
      }
    };

    // Eksplisitt sjekk (ikke bare checkValidity): på flere mobiler blokkerer
    // nettleseren submit uten synlig feilmelding. index.html har novalidate.
    const kommune = String(form.elements.kommune?.value ?? "").trim();
    const navn = String(form.elements.navn?.value ?? "").trim();
    const tlf = String(form.elements.tlf?.value ?? "").trim();
    const epost = String(form.elements.epost?.value ?? "").trim();
    const consentEl = document.querySelector("#consent");
    const consentOk = !!(consentEl && consentEl.checked);

    const missing = [];
    if (!kommune) missing.push("kommune");
    if (!navn) missing.push("navn eller kallenavn");
    if (!consentOk) missing.push("huk av at du forstår posisjon");

    if (missing.length) {
      showNote("Nesten klar! Fyll ut: " + missing.join(", ") + ".");
      try {
        if (!kommune) form.elements.kommune?.focus();
        else if (!navn) form.elements.navn?.focus();
        else if (!consentOk) consentEl?.focus();
      } catch {
        // ignore focus errors (iOS)
      }
      return;
    }

    const profile = { kommune, navn, tlf, epost };
    state.profile = profile;
    saveState(state);

    updateHeaderSubtitle();
    updateProfileForm();
    enterPlayView();

    const mot = $("#motivation");
    if (mot) setNotice(mot, "Velkommen! Trykk «Start tur» når du begynner å gå eller sykle.", "is-good");
    if (note) note.style.display = "none";
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    runOnboardingComplete();
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
  if (authName) {
    authName.value =
      loadDisplayName() ||
      (state.profile?.navn ? String(state.profile.navn) : "") ||
      (state.profile?.epost ? String(state.profile.epost).split("@")[0] : "");
  }

  document.querySelector("#btn-auth-login")?.addEventListener("click", async () => {
    const client = ensureSupabase();
    if (!client) {
      setNotice(document.querySelector("#win-notice"), "Konfigurer Supabase først.", "is-warn");
      return;
    }
    const email = String(authEmail?.value || "").trim();
    const name = String(authName?.value || "").trim();
    if (!name) {
      setNotice(document.querySelector("#win-notice"), "Skriv navnet ditt først (for topplista).", "is-warn");
      return;
    }
    saveDisplayName(name);
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
        navn: String(fd.get("navn") || "").trim(),
        tlf: String(fd.get("tlf") || "").trim(),
        epost: String(fd.get("epost") || "").trim(),
      };
      if (!profile.kommune || !profile.navn) return;
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
  $("#btn-claim-reward")?.addEventListener("click", () => {
    const note = $("#daily-reward-note");
    const res = claimDailyReward();
    if (note) setNotice(note, res.text, res.ok ? "is-good" : "is-warn");
  });
  $("#btn-arrived")?.addEventListener("click", () => {
    const dateKey = nowIsoDate();
    const sess = state.gamification?.sessions?.[dateKey];
    stopSession();

    const d = getDaily(state, dateKey);
    const pointsNow = Number(d.points ?? 0);
    const metersNow = Number(d.activeMeters ?? 0);
    const gainedPoints = sess ? Math.max(0, pointsNow - Number(sess.pointsStart ?? 0)) : 0;
    const gainedMeters = sess ? Math.max(0, metersNow - Number(sess.metersStart ?? 0)) : 0;

    if (sess) {
      sess.endedAt = Date.now();
      saveState(state);
    }

    // Badge: first arrival of the day with >= 500m active
    const badges = ensureGamification(state).badges;
    const badgeId = `arrival_${dateKey}`;
    if (gainedMeters >= 500 && !badges.some((b) => b.id === badgeId)) {
      badges.push({ id: badgeId, earnedAt: Date.now(), title: "Kom fram!" });
      saveState(state);
    }

    const mot = $("#motivation");
    if (mot) {
      const km = (gainedMeters / 1000).toFixed(2);
      const co2 = co2SavedKgFromMeters(gainedMeters).toFixed(2);
      setNotice(mot, `Fremme! +${gainedPoints} poeng • ${km} km • ca. ${co2} kg CO₂ spart`, "is-good");
    }
    updateStatsUi();
  });
  $("#btn-center")?.addEventListener("click", centerOnAvatar);
  $("#btn-follow")?.addEventListener("click", () => {
    followMode = !followMode;
    const b = document.querySelector("#btn-follow");
    if (b) b.textContent = followMode ? "Følg: På" : "Følg: Av";
    if (followMode && session.lastPos?.latlng && mapMode === "3d") update3DCamera(session.lastPos.latlng);
  });
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

    // Score 0..1 — mer følsomt for lomme (svakere, jevn pendling)
    const v = motion.variance || 0;
    motion.score = clamp((v - 0.042) / 0.44, 0, 1);
    motion.lastUpdatedAt = t;

    // Step / cadence estimation (watch-like feeling)
    // High-pass-ish signal from diff (removes gravity + slow drift)
    const hp = diff;
    const hpAbs = Math.abs(hp);
    // Smooth amplitude envelope
    motion.hpEma = (motion.hpEma || hpAbs) + 0.18 * (hpAbs - (motion.hpEma || hpAbs));

    const thr = Math.max(0.13, (motion.hpEma || 0) * 0.78);
    const minStepGapMs = 260;
    const maxStepGapMs = 1550;

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

    const sinceStepMs = t - (motion.lastStepAt || 0);
    const recent = sinceStepMs < 1600 ? 1 : sinceStepMs < 3200 ? 0.55 : 0.2;
    let cadenceOk = 0.38;
    const spm = motion.cadenceSpm || 0;
    if (spm >= 80 && spm <= 190) cadenceOk = 1;
    else if (spm >= 65 && spm < 80) cadenceOk = 0.78;
    else if (spm >= 52 && spm < 65) cadenceOk = 0.58;
    // Ikke gang alt ned med lav score (lomme): minst ~40 % av «steg-puls» kommer gjennom
    motion.stepConfidence = clamp((recent * 0.62 + cadenceOk * 0.38) * (0.4 + 0.6 * motion.score), 0, 1);
  };

  window.addEventListener("devicemotion", handler, { passive: true });
  motion.enabled = true;
}

function updateAntiCheatHeuristics(speedMps, activity, dt) {
  if (!motion.enabled) {
    motion.stableHighSpeedSeconds = 0;
    motion.escooterSuspectSeconds = 0;
    motion.walkBandStableSeconds = 0;
    return;
  }
  if (typeof speedMps !== "number") return;
  const score = motion.score ?? 0;
  const stepC = motion.stepConfidence ?? 0;

  if (speedMps > 4.2 && score < 0.16) motion.stableHighSpeedSeconds += dt;
  else motion.stableHighSpeedSeconds = Math.max(0, motion.stableHighSpeedSeconds - dt * 0.5);
  motion.stableHighSpeedSeconds = clamp(motion.stableHighSpeedSeconds, 0, 180);

  const inScooterSpeedBand = speedMps >= 2.5 && speedMps <= 8.5;
  const passiveRider = stepC < 0.14 && score < 0.16;
  if (activity === "sykler" && inScooterSpeedBand && passiveRider) {
    motion.escooterSuspectSeconds = (motion.escooterSuspectSeconds ?? 0) + dt;
  } else {
    motion.escooterSuspectSeconds = Math.max(0, (motion.escooterSuspectSeconds ?? 0) - dt * 1.8);
  }
  motion.escooterSuspectSeconds = clamp(motion.escooterSuspectSeconds ?? 0, 0, 120);

  if (activity === "går" && speedMps >= 0.7 && speedMps <= 2.48) {
    motion.walkBandStableSeconds = (motion.walkBandStableSeconds ?? 0) + dt;
  } else {
    motion.walkBandStableSeconds = Math.max(0, (motion.walkBandStableSeconds ?? 0) - dt * 2.2);
  }
  motion.walkBandStableSeconds = clamp(motion.walkBandStableSeconds ?? 0, 0, 50);
}

function mapSeasonRowToLeader(r) {
  return {
    userId: r.user_id ?? null,
    name: r.profiles?.display_name ?? "spiller",
    school: r.skole ?? "",
    kommune: r.kommune ?? "",
    seasonKey: r.season_key,
    points: r.points ?? 0,
    activeMeters: r.active_meters ?? 0,
  };
}

async function fetchMySupabaseRank(seasonKey, scope, kommune) {
  const client = ensureSupabase();
  if (!client) return null;
  const { data: sess } = await client.auth.getSession();
  const uid = sess?.session?.user?.id;
  if (!uid) return { kind: "guest" };

  const { data: mine, error } = await client
    .from("season_scores")
    .select("points")
    .eq("season_key", seasonKey)
    .eq("user_id", uid)
    .maybeSingle();
  if (error || !mine) return { kind: "none" };

  const myPts = mine.points ?? 0;
  let q = client
    .from("season_scores")
    .select("*", { count: "exact", head: true })
    .eq("season_key", seasonKey)
    .gt("points", myPts);
  if (scope === "kommune" && String(kommune ?? "").trim()) {
    q = q.ilike("kommune", String(kommune).trim());
  }
  const { count, error: e2 } = await q;
  if (e2) return null;
  const rank = (count ?? 0) + 1;
  return { kind: "rank", rank, points: myPts };
}

async function fetchKommuneLeaderboardFromSupabase(seasonKey, kommune) {
  const client = ensureSupabase();
  const k = String(kommune ?? "").trim();
  if (!client || !k) return null;
  const { data, error } = await client
    .from("season_scores")
    .select("points, active_meters, season_key, skole, kommune, user_id, profiles(display_name)")
    .eq("season_key", seasonKey)
    .ilike("kommune", k)
    .order("points", { ascending: false })
    .limit(50);
  if (error) return null;
  return (data ?? []).map(mapSeasonRowToLeader);
}

async function fetchAllLeaderboardFromSupabase(seasonKey) {
  const client = ensureSupabase();
  if (!client) return null;
  const { data, error } = await client
    .from("season_scores")
    .select("points, active_meters, season_key, skole, kommune, user_id, profiles(display_name)")
    .eq("season_key", seasonKey)
    .order("points", { ascending: false })
    .limit(50);
  if (error) return null;
  return (data ?? []).map(mapSeasonRowToLeader);
}

async function renderLeaderboard() {
  const dateKey = nowIsoDate();
  const seasonKey = seasonKeyFromDate(dateKey);
  const seasonPill = $("#season-pill");
  if (seasonPill) seasonPill.textContent = `Periode: ${seasonKey}`;

  const seasonStats = calcSeasonStats(state, seasonKey);
  const seasonDistanceEl = $("#season-distance");
  if (seasonDistanceEl) seasonDistanceEl.textContent = `${(seasonStats.activeMeters / 1000).toFixed(2)} km`;
  const seasonPointsEl = $("#season-points");
  if (seasonPointsEl) seasonPointsEl.textContent = String(seasonStats.points);
  const seasonRangeEl = $("#season-range");
  if (seasonRangeEl) {
    seasonRangeEl.textContent = seasonStats.range ? `${seasonStats.range.startIso} → ${seasonStats.range.endIso}` : "—";
  }

  const userKommune = state.profile?.kommune?.trim() ?? "";
  const myKey = normalizeKommuneKey(userKommune);
  const scope = leaderboardScope;
  const online = ensureSupabase();

  const winnerHeading = $("#winner-heading");
  const panelTitle = $("#leaderboard-panel-title");
  const myRankEl = $("#lb-my-rank");

  let myUid = null;
  if (online) {
    const c = ensureSupabase();
    if (c) {
      const { data } = await c.auth.getSession();
      myUid = data?.session?.user?.id ?? null;
    }
  }

  let rows = [];
  if (online) {
    if (scope === "kommune") {
      rows = userKommune ? (await fetchKommuneLeaderboardFromSupabase(seasonKey, userKommune)) ?? [] : [];
    } else {
      rows = (await fetchAllLeaderboardFromSupabase(seasonKey)) ?? [];
    }
  } else {
    const all = state.school?.publishedScores ?? [];
    const forSeason = all.filter((r) => r.seasonKey === seasonKey);
    const filtered =
      scope === "kommune"
        ? forSeason.filter((r) => (myKey ? normalizeKommuneKey(r.kommune) === myKey : false))
        : forSeason;
    rows = [...filtered].sort((a, b) => b.points - a.points).slice(0, 50);
  }

  if (myRankEl) {
    myRankEl.textContent = "";
    myRankEl.classList.remove("is-good", "is-warn");
    if (scope === "kommune" && !userKommune) {
      myRankEl.textContent = "Lagre kommune i Profil for å se din lokale plass.";
      myRankEl.classList.add("is-warn");
    } else if (online && myUid) {
      const info = await fetchMySupabaseRank(seasonKey, scope, userKommune);
      if (!info) {
        // ignore
      } else if (info.kind === "guest") {
        myRankEl.textContent = "💡 Logg inn (Profil → voksne) for å se nøyaktig plassering.";
        myRankEl.classList.add("is-warn");
      } else if (info.kind === "none") {
        myRankEl.textContent = "💡 Send inn poeng til topplista for å bli med.";
        myRankEl.classList.add("is-warn");
      } else {
        const where = scope === "kommune" ? userKommune || "kommunen din" : "hele landet";
        myRankEl.textContent = `📍 Din plass: #${info.rank} i ${where} (${info.points} poeng).`;
        myRankEl.classList.add("is-good");
      }
    } else if (!online) {
      const nm = String(state.profile?.navn ?? "").trim().toLowerCase();
      const ep = String(state.profile?.epost ?? "");
      const alias = ep.includes("@") ? ep.split("@")[0].toLowerCase() : "";
      const idx = rows.findIndex((r) => {
        const rn = String(r.name ?? "").toLowerCase();
        return (nm && rn === nm) || (alias && rn === alias);
      });
      if (idx >= 0) {
        myRankEl.textContent = `📍 Du er nr. ${idx + 1} på lista akkurat nå!`;
        myRankEl.classList.add("is-good");
      } else if (rows.length) {
        myRankEl.textContent =
          "💡 I demoen: send inn poeng, eller bruk samme navn som i lista for å se din rad uthevet.";
        myRankEl.classList.add("is-warn");
      }
    } else {
      myRankEl.textContent = "💡 Logg inn for å se din plass på online topplista.";
      myRankEl.classList.add("is-warn");
    }
  }

  if (winnerHeading) {
    winnerHeading.textContent =
      scope === "kommune" ? `Leder i ${userKommune || "kommunen din"}` : "Leder på landstoppen";
  }
  if (panelTitle) {
    panelTitle.textContent =
      scope === "kommune"
        ? userKommune
          ? `Rangering — ${userKommune}`
          : "Rangering (sett kommune i Profil)"
        : "Rangering — hele landet";
  }

  const winnerBox = $("#winner-box");
  if (winnerBox) {
    if (scope === "kommune" && !userKommune) {
      setNotice(
        winnerBox,
        "Registrer kommune under Profil (eller fullfør registrering) for å se hvem som leder lokalt.",
        "is-warn",
      );
    } else if (rows.length === 0) {
      setNotice(
        winnerBox,
        scope === "kommune"
          ? "Ingen har publisert poeng i kommunen din ennå. Trykk «Publiser poeng til topplista»."
          : "Ingen har publisert poeng ennå denne sesongen.",
        "is-warn",
      );
    } else {
      const w = rows[0];
      const km = ((w.activeMeters ?? 0) / 1000).toFixed(2);
      const line =
        scope === "kommune"
          ? `🏆 ${w.name} leder med ${w.points} poeng og ${km} km.`
          : `🏆 ${w.name} leder med ${w.points} poeng • ${km} km • ${w.kommune || "—"}`;
      setNotice(winnerBox, line, "is-good");
    }
  }

  const lb = $("#leaderboard");
  if (lb) {
    lb.innerHTML = "";
    if (scope === "kommune" && !userKommune) {
      const hint = document.createElement("div");
      hint.className = "muted";
      hint.style.padding = "8px 0";
      hint.textContent = "Når du har lagret kommune i profilen, vises lokale spillere her.";
      lb.appendChild(hint);
    } else {
      rows.forEach((r, i) => {
        const el = document.createElement("div");
        const nm = String(state.profile?.navn ?? "").trim().toLowerCase();
        const ep = String(state.profile?.epost ?? "");
        const alias = ep.includes("@") ? ep.split("@")[0].toLowerCase() : "";
        const rn = String(r.name ?? "").toLowerCase();
        const isMe =
          (myUid && r.userId && r.userId === myUid) || (nm && rn === nm) || (alias && rn === alias);
        el.className =
          "leaderboard__row" +
          (i === 0 ? " leaderboard__row--top" : "") +
          (isMe ? " leaderboard__row--me" : "");
        const km = ((r.activeMeters ?? 0) / 1000).toFixed(1);
        const meta = scope === "all" ? `${escapeHtml(r.kommune || "—")} • ${km} km` : `${km} km sesong`;
        el.innerHTML = `
        <div class="row" style="gap:10px">
          <div class="leaderboard__pos">${i + 1}</div>
          <div>
            <div class="leaderboard__name">${escapeHtml(r.name)}</div>
            <div class="leaderboard__meta">${meta}</div>
          </div>
        </div>
        <div class="leaderboard__score">${r.points} <span class="leaderboard__pts">p</span></div>
      `;
        lb.appendChild(el);
      });
    }
  }
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
  initOnboarding();
  initNav();
  initProfile();
  initPlayControls();

  // Initial route
  if (!state.profile) {
    setView("splash");
    // Show intro only before first registration.
    // After the animation, go to onboarding form.
    setTimeout(() => {
      // If user still hasn't registered, show onboarding.
      if (!state.profile) setView("onboarding");
    }, 2450);
  } else {
    enterPlayView();
  }

  updateHeaderSubtitle();
  updateProfileForm();
  updateStatsUi();
  updateSessionUi();

  // Ensure Supabase session persists across app restarts (PWA).
  // If you are already logged in, this will restore it from localStorage.
  ensureSupabase();
  updateAuthUi();

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
      map3dCustomBuildingsAdded = false;
    }
    mapMode = "3d";
    ensureMap3D();
    const ll = session.lastPos?.latlng;
    if (ll) map3dMarker?.setLngLat([ll.lng, ll.lat]);
    setTimeout(() => map3d && map3d.resize(), 80);
    setNotice($("#motivation"), "3D-kart aktivert (stilisert vektor).", "is-good");
  });

  $("#btn-try-3d")?.addEventListener("click", () => {
    // Re-try 3D without needing to re-save key
    if (map3d) {
      try {
        map3d.remove();
      } catch {
        // ignore
      }
      map3d = null;
      map3dMarker = null;
      map3dCustomBuildingsAdded = false;
      map3dTrailSourceReady = false;
    }
    mapMode = "3d";
    ensureMap3D();
    setTimeout(() => map3d && map3d.resize(), 80);
  });

  $("#btn-share-trophies")?.addEventListener("click", async () => {
    try {
      await shareTrophiesImage();
    } catch {
      setNotice($("#share-note"), "Kunne ikke dele akkurat nå.", "is-warn");
    }
  });

  const syncLeaderboardTabs = () => {
    for (const b of document.querySelectorAll("[data-lb-scope]")) {
      b.classList.toggle("is-active", (b.getAttribute("data-lb-scope") || "") === leaderboardScope);
    }
  };
  syncLeaderboardTabs();
  document.querySelectorAll("[data-lb-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-lb-scope") === "all" ? "all" : "kommune";
      leaderboardScope = next;
      syncLeaderboardTabs();
      renderLeaderboard();
    });
  });

  // Motion setup
  // Start listening immediately where allowed; iOS will need permission after first click.
  startMotion();

  // Snap Map-like tracking while app is open (offline/local only).
  // This updates your position on the map even when the session is not active.
  startSnapMapTracking();
  updateLocationStatusUi();

  // Best-effort “keep it similar”: when the app returns from lock/background,
  // refresh position immediately and continue smoothly.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshLocationAfterResume();
      if (session.active) void acquireScreenWakeLock();
    }
  });
  window.addEventListener("pageshow", () => {
    refreshLocationAfterResume();
  });

  // Leaderboard actions
  $("#btn-publish-score")?.addEventListener("click", async () => {
    if (!state.profile) return;
    const ok = await requestMotionPermissionIfNeeded();
    if (ok) startMotion();

    const dateKey = nowIsoDate();
    const seasonKey = seasonKeyFromDate(dateKey);
    const school = state.profile.navn ?? state.profile.lag ?? state.profile.skole ?? "";
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
      setView("leaderboard");
      await renderLeaderboard();
    } else {
      const name =
        String(state.profile.navn || "").trim() ||
        (state.profile.epost ? String(state.profile.epost).split("@")[0] : "") ||
        "spiller";
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
      setView("leaderboard");
      await renderLeaderboard();
    }
  });

  $("#btn-tv")?.addEventListener("click", async () => {
    document.body.classList.toggle("is-tv", true);
    setView("leaderboard");
    renderLeaderboard();
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

  window.__GA_APP_READY = true;
}

boot();
