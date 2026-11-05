/* МАЯК · самостоятельный интерфейс карты опубликованных региональных сводок.
 * Источник данных (без копирования исходного приложения): sv-cpu/uavfront-map.
 * Карта НЕ показывает траектории или реальное положение БПЛА.
 */
(() => {
  "use strict";
  const SOURCE = "https://sv-cpu.github.io/uavfront-map/";
  const RAW = "https://raw.githubusercontent.com/sv-cpu/uavfront-map/main/";
  const WINDOWS = ["1h", "3h", "24h"];
  const SELECTORS = {
    updated: document.getElementById("updated"),
    regions: document.getElementById("countRegions"),
    alerts: document.getElementById("countAlerts"),
    mod: document.getElementById("countMod"),
    picker: document.getElementById("regionPicker"),
    details: document.getElementById("details"),
    overlay: document.getElementById("mapOverlay"),
    refresh: document.getElementById("refresh"),
  };
  const state = { period: "24h", data: null, geo: null, selected: "", map: null,
                  geoLayer: null, pointsLayer: null, regionsByKey: {}, loading: false };
  const $ = (tag, cls, text) => {
    const out = document.createElement(tag);
    if (cls) out.className = cls;
    if (text !== undefined) out.textContent = String(text);
    return out;
  };
  function positive(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }
  function counts(d, key, period = state.period) {
    const w = d && d.regions && d.regions[key] && d.regions[key].w;
    const x = w && w[period] || {};
    return { a: positive(x.a), m: positive(x.m),
      i: Array.isArray(x.i) ? x.i.length : positive(x.i), ms: positive(x.ms) };
  }
  function score(c) { return c.a + c.m + c.i * 2; }
  function periodName() { return ({ "1h": "1 час", "3h": "3 часа", "24h": "24 часа" })[state.period]; }
  function formatDataTime(d) {
    const label = d.generated_at || d.now || "неизвестно";
    const raw = String(d.now || "").trim();
    if (!raw) return { label: String(label), stale: true };
    const withZone = /(?:Z|[+-]\d\d:?\d\d)$/i.test(raw) ? raw : raw + "+03:00";
    const ts = Date.parse(withZone);
    const diff = Date.now() - ts;
    return { label: String(label), stale: !Number.isFinite(ts) || diff > 6*3600000 || diff < -15*60000 };
  }
  function setOverlay(message) {
    SELECTORS.overlay.textContent = message || "";
    SELECTORS.overlay.hidden = !message;
  }
  function color(c) {
    const s = score(c);
    if (s === 0) return "#193048";
    if (s < 2) return "#235066";
    if (s < 5) return "#2c6a7b";
    if (s < 12) return "#368b90";
    return "#52ad9d";
  }
  function regionName(key) { return state.regionsByKey[key] || key; }
  function setPeriod(p) {
    if (!WINDOWS.includes(p)) return;
    state.period = p;
    document.querySelectorAll("[data-period]").forEach(b => {
      const isActive = b.dataset.period === p;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-pressed", String(isActive));
    });
    if (state.data) renderData();
  }
  function renderSummary() {
    const d = state.data;
    if (!d) return;
    const regs = Object.keys(d.regions);
    let active = 0, alerts = 0;
    for (const key of regs) {
      const c = counts(d, key);
      if (c.a || c.m) active++;
      alerts += c.a;
    }
    SELECTORS.regions.textContent = String(active);
    SELECTORS.alerts.textContent = String(alerts);
    const modTotal = d.mod && d.mod.total;
    SELECTORS.mod.textContent = modTotal === null || modTotal === undefined ? "—" : String(positive(modTotal));
    SELECTORS.mod.title = d.mod && d.mod.period ? "Последняя сводка МО: " + d.mod.period : "Последняя сводка МО";
    const dt = formatDataTime(d);
    SELECTORS.updated.textContent = (dt.stale ? "⚠️ Данные могут быть устаревшими · " : "Обновлено · ") + dt.label;
    SELECTORS.updated.classList.toggle("stale", dt.stale);
  }
  function fillPicker() {
    const previous = state.selected;
    SELECTORS.picker.replaceChildren($("option", "", "Все регионы"));
    SELECTORS.picker.firstChild.value = "";
    const keys = Object.keys(state.data.regions).sort((a, b) =>
      regionName(a).localeCompare(regionName(b), "ru"));
    for (const key of keys) {
      const option = $("option", "", regionName(key));
      option.value = key;
      SELECTORS.picker.append(option);
    }
    SELECTORS.picker.value = state.data.regions[previous] ? previous : "";
    if (!SELECTORS.picker.value) state.selected = "";
  }
  // Источник содержит не только агрегаты regions[key].w, но и опубликованные
  // сообщения regions[key].ev. Показываем региональные предупреждения и инциденты,
  // но не сообщения о предполагаемых маршрутах или текущих позициях БПЛА.
  const DISPLAY_EVENT_TYPES = { alert: "Предупреждение", incident: "Сообщение об инциденте" };
  function parseMoscowTime(value) {
    if (!value) return NaN;
    const raw = String(value).trim();
    const ts = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/i.test(raw) ? raw : raw + "+03:00");
    return Number.isFinite(ts) ? ts : NaN;
  }
  function displayedEvents() {
    if (!state.data) return [];
    const now = parseMoscowTime(state.data.now);
    const hours = { "1h": 1, "3h": 3, "24h": 24 }[state.period] || 24;
    const windowValue = state.data.windows && state.data.windows[state.period];
    const cutoff = parseMoscowTime(windowValue) || (Number.isFinite(now) ? now - hours*3600000 : Date.now() - hours*3600000);
    const maxTime = Number.isFinite(now) ? now + 15*60000 : Date.now() + 15*60000;
    const keys = state.selected ? [state.selected] : Object.keys(state.data.regions);
    const result = [];
    for (const key of keys) {
      const region = state.data.regions[key];
      if (!region || !Array.isArray(region.ev)) continue;
      for (const ev of region.ev) {
        const timestamp = parseMoscowTime(ev && ev.t);
        if (!ev || !Object.hasOwn(DISPLAY_EVENT_TYPES, ev.k) ||
            !Number.isFinite(timestamp) || timestamp < cutoff || timestamp > maxTime) continue;
        result.push({ ...ev, key, timestamp });
      }
    }
    return result.sort((a, b) => b.timestamp - a.timestamp);
  }
  function formatEventTime(raw) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(raw || ""));
    return m ? `${m[3]}.${m[2]} ${m[4]}:${m[5]} МСК` : "Время не указано";
  }
  function appendEvents(parent, events, maxItems) {
    const heading = $("h3", "event-heading", "Последние опубликованные сообщения · " + periodName());
    parent.append(heading);
    if (!events.length) {
      parent.append($("p", "secondary", "За выбранный период нет сообщений этих категорий. Это не означает отсутствия угрозы."));
      return;
    }
    const list = $("div", "events-list");
    for (const ev of events.slice(0, maxItems)) {
      const card = $("div", "event-card");
      const meta = $("div", "event-meta");
      meta.append($("span", "event-date", formatEventTime(ev.t)),
        $("span", "event-category", DISPLAY_EVENT_TYPES[ev.k]));
      if (ev.c === "o") meta.append($("span", "event-source-status", "Указан официальный источник"));
      else meta.append($("span", "event-source-status", "Требует проверки"));
      card.append(meta);
      if (!state.selected) card.append($("strong", "event-region", regionName(ev.key)));
      card.append($("p", "event-content", String(ev.tx || "Текст не указан").slice(0, 320)));
      const src = Array.isArray(ev.u) ? ev.u.find(u => {
        try { const x = new URL(u); return x.protocol === "https:"; } catch { return false; }
      }) : null;
      if (src) {
        const link = $("a", "event-source", "Открыть источник ↗");
        link.href = src;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        card.append(link);
      }
      list.append(card);
    }
    parent.append(list);
    if (events.length > maxItems) parent.append($("p", "smallnote", `Показано ${maxItems} из ${events.length} сообщений.`));
    parent.append($("p", "smallnote", "Подборка из открытого источника БПЛА Фронт. Сообщения могут быть неполными или непроверенными; для предупреждений об опасности используйте официальные каналы."));
  }
  function renderDetails() {
    SELECTORS.details.replaceChildren();
    if (!state.data) {
      SELECTORS.details.append($("p", "secondary", "Получаем опубликованные данные…"));
      return;
    }
    if (!state.selected || !state.data.regions[state.selected]) {
      SELECTORS.details.append($("h2", "", "Все регионы России"),
        $("p", "secondary", "Выбери регион для его статистики или посмотри последние опубликованные сообщения ниже."));
      appendEvents(SELECTORS.details, displayedEvents(), 15);
      return;
    }
    const name = regionName(state.selected), c = counts(state.data, state.selected);
    SELECTORS.details.append($("h2", "", name),
      $("p", "secondary", "Опубликованные сообщения за последние " + periodName()));
    const grid = $("div", "region-kpis");
    for (const [n, label] of [[c.a, "тревог"], [c.m, "пролётов"], [c.i, "инцидентов"], [c.ms, "ракетных предупреждений"]]) {
      const card = $("div");
      card.append($("strong", "", n), $("span", "", label));
      grid.append(card);
    }
    SELECTORS.details.append(grid, $("p", "smallnote", "Показатели — число опубликованных сообщений, не число отдельных БПЛА и не уровень опасности прямо сейчас."));
    appendEvents(SELECTORS.details, displayedEvents(), 20);
  }
  function renderMap() {
    if (!state.map || !state.data || !window.L) return;
    if (state.geoLayer) {
      state.geoLayer.setStyle(f => {
        const key = f.properties && f.properties.key;
        const selected = key === state.selected;
        return { color: selected ? "#b0f4f1" : "#35536d", weight: selected ? 2.3 : .75,
          fillColor: color(counts(state.data, key)), fillOpacity: .8, opacity: 1 };
      });
    }
    if (state.pointsLayer) {
      state.pointsLayer.eachLayer(layer => {
        const key = layer._mayakRegion;
        const s = score(counts(state.data, key));
        layer.setStyle({ color: key === state.selected ? "#ddfff6" : "#b9d4e3",
          fillColor: color(counts(state.data, key)), fillOpacity: s ? .86 : .35,
          radius: key === state.selected ? 10 : s ? 7 : 4 });
      });
    }
  }
  function renderData() { renderSummary(); renderMap(); renderDetails(); }
  function selectRegion(key, zoom = false) {
    if (!state.data || !state.data.regions[key]) return;
    state.selected = key;
    SELECTORS.picker.value = key;
    renderData();
    if (!zoom || !state.map) return;
    let found = false;
    if (state.geoLayer) state.geoLayer.eachLayer(layer => {
      if (!found && layer.feature && layer.feature.properties.key === key) {
        state.map.fitBounds(layer.getBounds(), { padding: [20, 20], maxZoom: 7 });
        found = true;
      }
    });
    if (!found && state.data.regions[key].ll) {
      const loc = state.data.regions[key].ll;
      if (Array.isArray(loc) && loc.length >= 2) state.map.setView(loc, 6);
    }
  }
  function popFor(key) {
    const node = $("div");
    node.append($("strong", "", regionName(key)));
    const c = counts(state.data, key);
    node.append($("div", "", `Сообщения за ${periodName()}: тревоги ${c.a}, пролёты ${c.m}, инциденты ${c.i}.`));
    return node;
  }
  function initMap() {
    if (!window.L) { setOverlay("Не загрузилась библиотека карты. Проверь интернет и перезагрузи страницу."); return; }
    state.map = L.map("map", { zoomControl: false, minZoom: 2, maxZoom: 12, worldCopyJump: true }).setView([53, 57], 4);
    L.control.zoom({ position: "topright" }).addTo(state.map);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: "© <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> · © <a href=\"https://carto.com/attributions\">CARTO</a>",
      maxZoom: 12, subdomains: "abcd"
    }).addTo(state.map);
    state.pointsLayer = L.layerGroup().addTo(state.map);
    setTimeout(() => state.map && state.map.invalidateSize(), 250);
  }
  function makePointMarkers() {
    if (!state.map || !state.pointsLayer || !state.data) return;
    state.pointsLayer.clearLayers();
    for (const [key, region] of Object.entries(state.data.regions)) {
      const ll = region && region.ll;
      if (!Array.isArray(ll) || ll.length < 2 || !ll.every(Number.isFinite)) continue;
      const marker = L.circleMarker(ll, { radius: 6, color: "#9fbacb", weight: 1,
        fillColor: color(counts(state.data, key)), fillOpacity: .8 });
      marker._mayakRegion = key;
      marker.on("click", () => { selectRegion(key); marker.bindPopup(popFor(key)).openPopup(); });
      marker.bindTooltip(regionName(key) + " · центр региона", { direction: "top" });
      marker.addTo(state.pointsLayer);
    }
    renderMap();
  }
  function drawGeography(geo) {
    if (!state.map || !window.L || !geo || !Array.isArray(geo.features)) return;
    state.geo = geo;
    state.regionsByKey = {};
    for (const feature of geo.features) {
      if (feature.properties && feature.properties.key && feature.properties.name)
        state.regionsByKey[feature.properties.key] = feature.properties.name;
    }
    if (state.geoLayer) state.map.removeLayer(state.geoLayer);
    state.geoLayer = L.geoJSON(geo, {
      filter: f => !!(f && f.properties && f.properties.key),
      style: () => ({ color: "#35536d", weight: .75, fillColor: "#193048", fillOpacity: .8 }),
      onEachFeature: (f, layer) => {
        const key = f.properties.key;
        layer.on("click", () => { selectRegion(key); layer.bindPopup(popFor(key)).openPopup(); });
        layer.bindTooltip(regionName(key));
      }
    }).addTo(state.map);
    // Полигоны предпочтительнее условных региональных маркеров.
    if (state.pointsLayer) state.pointsLayer.clearLayers();
    if (state.data) { fillPicker(); renderMap(); }
  }
  async function getJson(url, timeoutMs = 16000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return await resp.json();
    } finally { clearTimeout(timer); }
  }
  async function getWithFallback(file) {
    const bust = "?r=" + Math.floor(Date.now() / 300000);
    let lastError;
    for (const u of [SOURCE + file + bust, RAW + file + bust]) {
      try { return await getJson(u); } catch (error) { lastError = error; }
    }
    throw lastError || new Error("Данные недоступны");
  }
  async function loadData() {
    if (state.loading) return;
    state.loading = true;
    SELECTORS.refresh.disabled = true;
    setOverlay("Обновляем данные…");
    try {
      const data = await getWithFallback("data.json");
      if (!data || typeof data.regions !== "object" || !data.regions || Array.isArray(data.regions))
        throw new Error("Неизвестный формат данных");
      state.data = data;
      fillPicker();
      renderData();
      if (!state.geo) makePointMarkers();
      setOverlay(null);
    } catch (e) {
      console.warn("МАЯК: источник данных недоступен", e);
      setOverlay("Не удалось обновить данные источника. Попробуй позже.");
      SELECTORS.updated.textContent = state.data ? "⚠️ Не удалось обновить · данные могут устареть" : "⚠️ Источник недоступен";
      SELECTORS.updated.classList.add("stale");
    } finally {
      state.loading = false;
      SELECTORS.refresh.disabled = false;
    }
  }
  async function loadGeography() {
    try {
      const geo = await getWithFallback("regions.geojson");
      drawGeography(geo);
    } catch (e) {
      console.warn("МАЯК: границы регионов недоступны, оставляем условные маркеры центров регионов", e);
      if (state.data) makePointMarkers();
      // Даже при недоступности полигонов карта продолжит показывать агрегированные данные по регионам.
    }
  }
  function launch() {
    try {
      const webApp = window.Telegram && window.Telegram.WebApp;
      if (webApp) { webApp.ready(); webApp.expand(); }
    } catch (e) { console.warn("Telegram Mini App недоступен", e); }
    initMap();
    document.querySelectorAll("[data-period]").forEach(b =>
      b.addEventListener("click", () => setPeriod(b.dataset.period)));
    SELECTORS.refresh.addEventListener("click", loadData);
    SELECTORS.picker.addEventListener("change", e => {
      if (!e.target.value) { state.selected = ""; renderData(); return; }
      selectRegion(e.target.value, true);
    });
    loadData();
    loadGeography();
    setInterval(() => { if (!document.hidden) loadData(); }, 300000);
  }
  launch();
})();
