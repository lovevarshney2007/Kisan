import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import fs from 'node:fs/promises';

const app = express();
const PORT = process.env.PORT || 3000;
const MANDI_API_BASE = 'https://mandi-api.onrender.com/v1';
const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';

// API Keys (Use environment variables in production)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

app.use(cors());
app.use(express.json());

// ==========================================
// 1. POSTGRES CONNECTION
// ==========================================
// Set DATABASE_URL, POSTGRES_URL, or use default PG env vars
const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const poolConfig = {};
if (dbUrl) {
  poolConfig.connectionString = dbUrl;
  if (!dbUrl.includes('localhost')) {
    poolConfig.ssl = { rejectUnauthorized: false };
  }
} else if (process.env.PGHOST) {
  if (process.env.PGHOST !== 'localhost') {
    poolConfig.ssl = { rejectUnauthorized: false };
  }
}

const { Pool } = pg;
const pool = new Pool(poolConfig);

const GOV_PRICE_TTL_MS = 3600000; // 1 hour, same as before

const REQUIRED_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS mandi_coordinates (
    id SERIAL PRIMARY KEY,
    market TEXT NOT NULL,
    district TEXT NOT NULL,
    state TEXT NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (market, district, state)
  );

  CREATE TABLE IF NOT EXISTS gov_prices (
    id SERIAL PRIMARY KEY,
    crop TEXT NOT NULL,
    state TEXT NOT NULL,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (crop, state)
  );

  CREATE TABLE IF NOT EXISTS distances (
    id SERIAL PRIMARY KEY,
    farmer_lat DOUBLE PRECISION NOT NULL,
    farmer_lon DOUBLE PRECISION NOT NULL,
    mandi_lat DOUBLE PRECISION NOT NULL,
    mandi_lon DOUBLE PRECISION NOT NULL,
    distance_km DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (farmer_lat, farmer_lon, mandi_lat, mandi_lon)
  );

  CREATE INDEX IF NOT EXISTS idx_distances_lookup
    ON distances (farmer_lat, farmer_lon, mandi_lat, mandi_lon);
`;

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;

  try {
    await pool.query(REQUIRED_SCHEMA_SQL);
    schemaEnsured = true;
  } catch (error) {
    console.error(`Schema bootstrap failed: ${error.message}`);
  }
}

async function fetchMandiApi(path, params = {}) {
  const url = new URL(`${MANDI_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const result = await response.json();
  if (!response.ok || result.success === false) {
    throw new Error(result.message || `Mandi price API returned HTTP ${response.status}`);
  }
  return result.data;
}

// ==========================================
// 2. EXTERNAL API & DB-BACKED CACHE FUNCTIONS
// ==========================================

function calculateHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

// Mandi coordinates: check DB first, then Open-Meteo's free geocoder, then save.
async function getMandiCoordinates(market, district, state) {
  await ensureSchema();

  const existing = await pool.query(
    'SELECT lat, lon FROM mandi_coordinates WHERE market=$1 AND district=$2 AND state=$3',
    [market, district, state]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  let coords;
  try {
    const query = encodeURIComponent(`${district}, ${state}, India`);
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${query}&count=5&language=en&format=json`;
    const response = await fetch(url);
    const data = await response.json();
    const location = data.results?.find((result) =>
      result.country_code === 'IN' && result.admin1?.toLowerCase() === state.toLowerCase()
    ) || data.results?.find((result) => result.country_code === 'IN');
    if (location) coords = { lat: location.latitude, lon: location.longitude };
  } catch (error) {
    return null;
  }

  if (!coords) return null;

  await pool.query(
    `INSERT INTO mandi_coordinates (market, district, state, lat, lon)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (market, district, state) DO NOTHING`,
    [market, district, state, coords.lat, coords.lon]
  );
  return coords;
}

// Road distance: check cache, then OSRM driving route, then straight-line fallback.
async function getRoadDistance(fLat, fLon, mLat, mLon) {
  await ensureSchema();

  const roundedFLat = parseFloat(fLat.toFixed(2));
  const roundedFLon = parseFloat(fLon.toFixed(2));
  const roundedMLat = parseFloat(mLat.toFixed(4));
  const roundedMLon = parseFloat(mLon.toFixed(4));

  const existing = await pool.query(
    'SELECT distance_km FROM distances WHERE farmer_lat=$1 AND farmer_lon=$2 AND mandi_lat=$3 AND mandi_lon=$4',
    [roundedFLat, roundedFLon, roundedMLat, roundedMLon]
  );
  if (existing.rows.length > 0) return existing.rows[0].distance_km;

  try {
    const url = `${OSRM_BASE_URL}/${fLon},${fLat};${mLon},${mLat}?overview=false`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json();

    if (response.ok && data.code === 'Ok' && Number.isFinite(data.routes?.[0]?.distance)) {
      const distance = Math.round(data.routes[0].distance / 100) / 10;
      await pool.query(
        `INSERT INTO distances (farmer_lat, farmer_lon, mandi_lat, mandi_lon, distance_km)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (farmer_lat, farmer_lon, mandi_lat, mandi_lon)
         DO UPDATE SET distance_km = EXCLUDED.distance_km`,
        [roundedFLat, roundedFLon, roundedMLat, roundedMLon, distance]
      );
      return distance;
    }
    return calculateHaversine(fLat, fLon, mLat, mLon);
  } catch (error) {
    return calculateHaversine(fLat, fLon, mLat, mLon);
  }
}

function normalizeMandiRecords(result, crop) {
  const records = Array.isArray(result)
    ? result
    : result.records || result.data?.records || result.data || result.results || result.prices || [];
  if (!Array.isArray(records)) return [];

  return records
    .map((record) => ({
      market: record.market || record.mandi || record.market_name || record.marketName,
      district: record.district || record.district_name || record.districtName || record.market || record.mandi,
      state: record.state || record.state_name || record.stateName,
      commodity: record.commodity || record.crop || record.commodity_name,
      modal_price: record.modal_price ?? record.modalPrice ?? record.modal_price_per_quintal ?? record.modal_price_per_qtl,
      variety: record.variety,
      arrival_date: record.arrival_date
    }))
    .filter((record) => record.market && record.state && record.modal_price != null)
    .filter((record) => !record.commodity || record.commodity.toLowerCase() === crop.toLowerCase());
}

// RapidAPI mandi prices: check DB (with 1hr TTL), then the crop endpoint, then save.
async function fetchLiveMandiPrices(crop, state, { market, variety, date } = {}) {
  await ensureSchema();

  const existing = await pool.query(
    'SELECT data, updated_at FROM gov_prices WHERE crop=$1 AND state=$2',
    [crop, state]
  );
  const canUseSharedCache = !market && !variety && !date;
  if (canUseSharedCache && existing.rows.length > 0) {
    const age = Date.now() - new Date(existing.rows[0].updated_at).getTime();
    if (age < GOV_PRICE_TTL_MS) return existing.rows[0].data;
  }

  try {
    const result = await fetchMandiApi('prices', { state, commodity: crop, market, variety, date });
    const records = normalizeMandiRecords(result, crop)
      .filter((record) => record.state.toLowerCase() === state.toLowerCase())
      .filter((record) => !market || record.market.toLowerCase() === market.toLowerCase())
      .filter((record) => !variety || record.variety?.toLowerCase() === variety.toLowerCase())
      .filter((record) => !date || record.arrival_date === date);
    if (records.length === 0) throw new Error(`No ${crop} records returned for ${state}`);

    if (canUseSharedCache) {
      await pool.query(
        `INSERT INTO gov_prices (crop, state, data, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (crop, state) DO UPDATE SET data = $3, updated_at = now()`,
        [crop, state, JSON.stringify(records)]
      );
    }
    return records;
  } catch (error) {
    console.error(`Mandi price lookup failed: ${error.message}`);
    // Fall back to stale DB data if we have it, rather than nothing
    if (canUseSharedCache && existing.rows.length > 0) return existing.rows[0].data;
    throw error;
  }
}

app.get('/api/mandi/states', async (req, res) => {
  try {
    res.json({ success: true, data: await fetchMandiApi('states') });
  } catch (error) {
    res.status(502).json({ success: false, error: error.message });
  }
});

app.get('/api/mandi/commodities', async (req, res) => {
  try {
    const { state, market } = req.query;
    res.json({ success: true, data: await fetchMandiApi('commodities', { state, market }) });
  } catch (error) {
    res.status(502).json({ success: false, error: error.message });
  }
});

app.get('/api/mandi/markets', async (req, res) => {
  try {
    if (!req.query.state) return res.status(400).json({ success: false, error: 'state is required' });
    res.json({ success: true, data: await fetchMandiApi('markets', { state: req.query.state }) });
  } catch (error) {
    res.status(502).json({ success: false, error: error.message });
  }
});

app.get('/api/mandi/prices', async (req, res) => {
  try {
    const { state, commodity, market, variety, date } = req.query;
    if (!state && !commodity) {
      return res.status(400).json({ success: false, error: 'state or commodity is required' });
    }
    res.json({
      success: true,
      data: await fetchMandiApi('prices', { state, commodity, market, variety, date })
    });
  } catch (error) {
    res.status(502).json({ success: false, error: error.message });
  }
});

app.get('/api/mandi/history', async (req, res) => {
  try {
    const { state, commodity, market, from, to } = req.query;
    if (!state || !commodity) {
      return res.status(400).json({ success: false, error: 'state and commodity are required' });
    }
    res.json({
      success: true,
      data: await fetchMandiApi('prices/history', { state, commodity, market, from, to })
    });
  } catch (error) {
    res.status(502).json({ success: false, error: error.message });
  }
});

async function fetchLiveWeather(lat, lon) {
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,weather_code&hourly=precipitation_probability&forecast_days=1`);
    const data = await res.json();
    const rainProb = data.hourly?.precipitation_probability?.[0] ?? 10;
    return { temp: `${data.current?.temperature_2m ?? 30}°C`, rainChance: rainProb, condition: rainProb > 40 ? 'Rain Alert' : 'Clear' };
  } catch (err) {
    return { temp: '30°C', rainChance: 15, condition: 'Clear' };
  }
}

async function generateAIAdvice(bestMandi, riskyMandi) {
  if (!GEMINI_API_KEY) {
    let note = `Routing to <strong>${bestMandi.name}</strong> generates the highest net profit (<strong>₹${bestMandi.netRevenue.toLocaleString('en-IN')}</strong>). `;
    if (riskyMandi && riskyMandi.name !== bestMandi.name) note += `Avoid ${riskyMandi.name} due to a ${riskyMandi.weather.rainChance}% storm risk. Sticking to ${bestMandi.name} is the safest choice.`;
    return note;
  }

  try {
    const prompt = `Act as an Agri-advisor. Best Mandi: ${bestMandi.name} (Net Profit: ₹${bestMandi.netRevenue}, Weather: ${bestMandi.weather.temp}). Risky Mandi: ${riskyMandi ? riskyMandi.name + ' (' + riskyMandi.weather.rainChance + '% rain)' : 'None'}. Write 2 short sentences advising the farmer where to sell. Do not use markdown headers.`;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  } catch (e) {
    return `Sell at ${bestMandi.name} to maximize your profit of ₹${bestMandi.netRevenue}.`;
  }
}

// ==========================================
// 3. MAIN ADVISORY ENDPOINT (unchanged logic, now DB-backed)
// ==========================================
app.post('/api/advisory/calculate', async (req, res) => {
  const { crop = 'Wheat', quantity = 40, ratePerKm = 25, farmerLat = 28.6139, farmerLon = 77.2090, state = 'Punjab', market, variety, date } = req.body;
  const trips = Math.ceil(quantity / 25);

  let rawMandis;
  try {
    rawMandis = await fetchLiveMandiPrices(crop, state, { market, variety, date });
  } catch (error) {
    return res.status(502).json({ error: `Mandi price lookup failed: ${error.message}` });
  }
  if (rawMandis === null) {
    return res.status(503).json({ error: 'Mandi price data is unavailable for this crop and state.' });
  }
  const evaluatedMandis = [];

  await Promise.all(rawMandis.slice(0, 8).map(async (record) => {
    const coords = await getMandiCoordinates(record.market, record.district, record.state);

    if (coords) {
      const roadDistance = await getRoadDistance(farmerLat, farmerLon, coords.lat, coords.lon);
      const grossRevenue = quantity * parseFloat(record.modal_price);
      const transportCost = trips * (500 + roadDistance * ratePerKm);
      const netRevenue = grossRevenue - transportCost;
      const weather = await fetchLiveWeather(coords.lat, coords.lon);

      evaluatedMandis.push({
        id: record.market,
        name: `${record.market} Mandi`,
        modalPrice: parseFloat(record.modal_price),
        distance: roadDistance,
        grossRevenue, transportCost, netRevenue, weather, trips
      });
    }
  }));

  if (evaluatedMandis.length === 0) {
    return res.status(404).json({ error: "No mapped Mandis found for this crop/state combination. Check API configurations." });
  }

  evaluatedMandis.sort((a, b) => b.netRevenue - a.netRevenue);
  const riskyMandi = evaluatedMandis.find(m => m.weather.rainChance > 40);
  const aiRecommendation = await generateAIAdvice(evaluatedMandis[0], riskyMandi);

  res.json({ bestMandi: evaluatedMandis[0], mandis: evaluatedMandis, aiRecommendation });
});

// ==========================================
// 4. EMBEDDED FRONTEND (UI) — unchanged from original
// ==========================================
app.get('/', (req, res) => {
  return fs.readFile(new URL('./public/index.html', import.meta.url), 'utf8')
    .then((html) => res.type('html').send(html))
    .catch(() => res.status(500).send('Frontend file could not be loaded.'));
});

app.get('/legacy-ui', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>KisanKalyan AI - Optimized GPS Advisor</title>
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@500;600;700;800&display=swap');
    :root { color-scheme: light; --ink: #1c3029; --muted: #687870; --line: #dce6df; --paper: #f3f7f3; --white: #fff; --green: #176b4a; --green-dark: #123d30; --lime: #d5e96a; --amber: #e8a83b; --red: #b8473e; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); background: var(--paper); font-family: 'DM Sans', sans-serif; }
    button, input, select { font: inherit; }
    button { cursor: pointer; }
    .w-3, .h-3 { width: 12px; height: 12px; }
    .w-4, .h-4 { width: 16px; height: 16px; }
    .w-6, .h-6 { width: 24px; height: 24px; }
    .inline { display: inline; vertical-align: -2px; }
    .animate-spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .topbar { background: var(--green-dark); color: #f4f6eb; border-bottom: 3px solid var(--lime); }
    .topbar-inner { width: min(1320px, calc(100% - 48px)); min-height: 76px; margin: auto; display: flex; align-items: center; justify-content: space-between; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-mark { width: 42px; height: 42px; display: grid; place-items: center; color: var(--green-dark); background: var(--lime); border-radius: 12px; }
    .brand-name { margin: 0; font: 800 19px/1 'Manrope', sans-serif; letter-spacing: 0; }
    .brand-caption { margin: 5px 0 0; color: #b6c9bd; font-size: 11px; font-weight: 600; letter-spacing: 0; }
    .topbar-status { display: inline-flex; align-items: center; gap: 9px; color: #d8e2da; font-size: 12px; font-weight: 600; }
    .status-light { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: var(--lime); box-shadow: 0 0 0 4px #ffffff14; }
    .workspace { width: min(1320px, calc(100% - 48px)); margin: 0 auto; padding: 38px 0 56px; }
    .page-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin: 0 0 26px; }
    .eyebrow { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; color: var(--green); font-size: 11px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
    .page-heading h1 { margin: 0; color: var(--ink); font: 800 34px/1.12 'Manrope', sans-serif; letter-spacing: 0; }
    .page-heading p { margin: 9px 0 0; color: var(--muted); font-size: 14px; }
    .heading-note { max-width: 220px; padding-left: 15px; border-left: 2px solid var(--amber); color: var(--muted); font-size: 12px; line-height: 1.55; }
    .workspace-grid { display: grid; grid-template-columns: minmax(280px, 350px) minmax(0, 1fr); align-items: start; gap: 22px; }
    .planner-panel, .results-panel { min-width: 0; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .panel-title { margin: 0; color: var(--ink); font: 800 17px/1.3 'Manrope', sans-serif; letter-spacing: 0; }
    .panel-kicker { color: #85918a; font-size: 10px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
    .form-surface { padding: 20px; background: var(--white); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 5px 20px #183c2810; }
    .form-section + .form-section { margin-top: 20px; padding-top: 18px; border-top: 1px solid #e9efea; }
    .section-label { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; color: #314b3e; font-size: 12px; font-weight: 700; }
    .section-label i { color: var(--green); }
    .field-label { display: block; margin: 0 0 6px; color: #758179; font-size: 11px; font-weight: 700; }
    .search-row { display: grid; grid-template-columns: minmax(0,1fr) 42px; gap: 7px; }
    .field-control { width: 100%; min-width: 0; min-height: 42px; padding: 0 12px; color: var(--ink); background: #f8faf8; border: 1px solid #dbe4dd; border-radius: 5px; outline: none; font-size: 13px; transition: border-color .16s, box-shadow .16s, background .16s; }
    .field-control:focus { background: #fff; border-color: #5b9b79; box-shadow: 0 0 0 3px #176b4a18; }
    .icon-button { display: grid; place-items: center; min-width: 42px; min-height: 42px; color: #fff; background: var(--green); border: 0; border-radius: 5px; transition: background .16s, transform .16s; }
    .icon-button:hover { background: #10573b; transform: translateY(-1px); }
    .gps-button { width: 100%; min-height: 39px; display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 8px; color: var(--green); background: #edf6ef; border: 1px solid #cce1d0; border-radius: 5px; font-size: 12px; font-weight: 700; transition: background .16s; }
    .gps-button:hover { background: #e3f0e6; }
    .location-chip { display: flex; align-items: start; gap: 8px; margin: 10px 0 0; padding: 9px 10px; color: #53685b; background: #f5f8f4; border: 1px solid #e8eee7; border-radius: 5px; font-size: 11px; line-height: 1.45; }
    .location-chip i { flex: 0 0 auto; margin-top: 1px; color: var(--green); }
    .cargo-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
    .field-unit { position: relative; }
    .field-unit .field-control { padding-right: 54px; }
    .unit-label { position: absolute; top: 50%; right: 10px; transform: translateY(-50%); color: #829087; font-size: 10px; font-weight: 700; pointer-events: none; }
    .advice-panel { position: relative; overflow: hidden; margin-top: 14px; padding: 18px; color: #f5f8ec; background: var(--green-dark); border-radius: 8px; }
    .advice-panel::after { position: absolute; right: -26px; bottom: -48px; width: 120px; height: 120px; border: 1px solid #ffffff1c; border-radius: 50%; content: ''; }
    .advice-heading { display: flex; align-items: center; gap: 8px; margin: 0 0 9px; color: var(--lime); font: 700 13px 'Manrope', sans-serif; letter-spacing: 0; }
    .advice-copy { position: relative; z-index: 1; margin: 0; color: #d5e0d6; font-size: 12px; line-height: 1.65; }
    .results-heading { min-height: 55px; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .results-heading h2 { margin: 0; font: 800 20px 'Manrope', sans-serif; letter-spacing: 0; }
    .results-heading p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
    .data-status { display: inline-flex; align-items: center; gap: 7px; padding: 7px 10px; color: #68766d; background: #e9eee9; border-radius: 4px; font-size: 10px; font-weight: 700; white-space: nowrap; }
    .data-status .status-light { width: 7px; height: 7px; flex-basis: 7px; background: #a8b4aa; box-shadow: none; }
    .result-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; }
    .empty-state, .error-state { grid-column: 1 / -1; min-height: 250px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 28px; text-align: center; background: #fff; border: 1px solid var(--line); border-radius: 8px; }
    .empty-icon { width: 46px; height: 46px; display: grid; place-items: center; margin-bottom: 14px; color: var(--green); background: #eaf3eb; border-radius: 50%; }
    .empty-state h3, .error-state h3 { margin: 0; color: var(--ink); font: 700 15px 'Manrope', sans-serif; letter-spacing: 0; }
    .empty-state p, .error-state p { max-width: 400px; margin: 7px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
    .error-state { align-items: flex-start; min-height: 130px; text-align: left; background: #fffaf7; border-color: #efd7c8; }
    .error-state h3 { color: #854c32; }
    .mandi-card { padding: 17px; background: #fff; border: 1px solid var(--line); border-radius: 7px; box-shadow: 0 4px 14px #183c280a; }
    .mandi-card.is-best { border-top: 3px solid var(--green); }
    .mandi-badge { display: inline-flex; margin: 0 0 9px; padding: 4px 7px; color: #356446; background: #eaf3eb; border-radius: 3px; font-size: 9px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; }
    .mandi-name { margin: 0 0 12px; color: var(--ink); font: 700 15px 'Manrope', sans-serif; letter-spacing: 0; }
    .mandi-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 13px; }
    .meta-tag { padding: 5px 7px; color: #596961; background: #f1f4f1; border-radius: 3px; font-size: 10px; font-weight: 700; }
    .finance-list { display: grid; gap: 9px; color: var(--muted); font-size: 11px; }
    .finance-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .finance-value { color: var(--ink); font-weight: 700; white-space: nowrap; }
    .finance-value.cost { color: var(--red); }
    .net-row { margin-top: 2px; padding-top: 10px; border-top: 1px solid #e8eee9; color: var(--ink); font-size: 12px; font-weight: 700; }
    .net-row .finance-value { color: var(--green); font: 800 17px 'Manrope', sans-serif; }
    .weather-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid #e8eee9; color: #66766d; font-size: 10px; font-weight: 700; }
    .weather-risk { color: var(--green); }
    .weather-risk.is-risky { color: var(--red); }
    .fade-in { animation: riseIn .32s ease-out both; }
    @keyframes riseIn { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }
    @media (max-width: 760px) { .topbar-inner, .workspace { width: min(100% - 32px, 600px); } .workspace { padding-top: 26px; } .workspace-grid { grid-template-columns: 1fr; gap: 25px; } .page-heading { align-items: start; } .heading-note { display: none; } .results-heading { align-items: start; } }
    @media (max-width: 480px) { .topbar-inner { min-height: 66px; } .topbar-status { font-size: 0; } .topbar-status .status-light { margin-right: 2px; } .workspace { width: calc(100% - 24px); } .page-heading h1 { max-width: 310px; font-size: 29px; } .form-surface { padding: 16px; } .result-grid { grid-template-columns: 1fr; } .data-status { padding: 6px 7px; font-size: 9px; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <div class="brand-mark"><i data-lucide="sprout" class="w-6 h-6"></i></div>
        <div>
          <p class="brand-name">KisanKalyan</p>
          <p class="brand-caption">HARVEST TO MARKET, WITH CLARITY</p>
        </div>
      </div>
      <div class="topbar-status"><span class="status-light"></span> FARMER ADVISORY</div>
    </div>
  </header>

  <main class="workspace">
    <section class="page-heading" aria-labelledby="page-title">
      <div>
        <p class="eyebrow"><i data-lucide="move-up-right" class="w-3 h-3"></i> MARKET INTELLIGENCE / 01</p>
        <h1 id="page-title">Make every trip count.</h1>
        <p>Compare mandi prices against the real cost of getting your harvest there.</p>
      </div>
      <div class="heading-note">A clearer view of price, distance and weather before you head to market.</div>
    </section>

    <div class="workspace-grid">
      <aside class="planner-panel" aria-label="Sale planning inputs">
        <div class="panel-head">
          <h2 class="panel-title">Plan your sale</h2>
          <span class="panel-kicker">YOUR DETAILS</span>
        </div>
        <div class="form-surface">
          <section class="form-section">
            <h3 class="section-label"><i data-lucide="map-pin" class="w-4 h-4"></i> Starting point</h3>
            <label class="field-label" for="manual-loc">Village or city</label>
            <div class="search-row">
              <input type="text" id="manual-loc" class="field-control" placeholder="e.g. Karnal, Haryana" onkeydown="if(event.key === 'Enter') geocodeLocation()" />
              <button type="button" onclick="geocodeLocation()" class="icon-button" aria-label="Search location" title="Search location"><i data-lucide="search" class="w-4 h-4"></i></button>
            </div>
            <button type="button" onclick="getGPSLocation()" class="gps-button"><i data-lucide="crosshair" class="w-4 h-4"></i> Use my current location</button>
            <p id="current-loc-display" class="location-chip"><i data-lucide="map-pin" class="w-3 h-3"></i><span>Delhi · Default location (28.61, 77.20)</span></p>
          </section>

          <section class="form-section">
            <h3 class="section-label"><i data-lucide="wheat" class="w-4 h-4"></i> Harvest details</h3>
            <label class="field-label" for="state-select">Market state</label>
            <select id="state-select" onchange="fetchAdvisory()" class="field-control">
              <option value="Haryana">Haryana</option>
              <option value="Punjab">Punjab</option>
              <option value="Uttar Pradesh">Uttar Pradesh</option>
              <option value="NCT of Delhi">Delhi</option>
            </select>
            <label class="field-label" for="crop-select" style="margin-top:12px">Crop</label>
            <select id="crop-select" onchange="fetchAdvisory()" class="field-control">
              <option value="Wheat">Wheat</option>
              <option value="Paddy(Dhan)(Basmati)">Paddy (Basmati)</option>
              <option value="Mustard">Mustard</option>
            </select>
            <div class="cargo-fields">
              <div>
                <label class="field-label" for="crop-qty">Quantity</label>
                <div class="field-unit"><input type="number" min="1" id="crop-qty" value="40" class="field-control" oninput="fetchAdvisory()" /><span class="unit-label">QUINTALS</span></div>
              </div>
              <div>
                <label class="field-label" for="transport-rate">Haul rate</label>
                <div class="field-unit"><input type="number" min="0" id="transport-rate" value="25" class="field-control" oninput="fetchAdvisory()" /><span class="unit-label">₹ / KM</span></div>
              </div>
            </div>
          </section>
        </div>

        <section class="advice-panel" aria-labelledby="advice-title">
          <h3 id="advice-title" class="advice-heading"><i data-lucide="sparkles" class="w-4 h-4"></i> Field recommendation</h3>
          <p id="ai-advice" class="advice-copy">Your recommendation will appear here once market data is available.</p>
        </section>
      </aside>

      <section class="results-panel" aria-labelledby="results-title">
        <div class="results-heading">
          <div>
            <h2 id="results-title">Mandi comparison</h2>
            <p>Estimated return after transport, ranked by net earnings.</p>
          </div>
          <div class="data-status"><span class="status-light"></span><span id="data-status-text">WAITING FOR DATA</span></div>
        </div>
        <div id="mandi-cards" class="result-grid" aria-live="polite">
          <div class="empty-state">
            <div class="empty-icon"><i data-lucide="map"></i></div>
            <h3>Your market comparison will appear here</h3>
            <p>Choose a crop and location to compare nearby mandis by estimated net return.</p>
          </div>
        </div>
      </section>
    </div>
  </main>

  <script>
    let farmerLat = 28.6139;
    let farmerLon = 77.2090;

    function updateLocationDisplay(message) {
      const label = document.querySelector('#current-loc-display span');
      if (label) label.textContent = message;
    }

    async function geocodeLocation() {
      const query = document.getElementById('manual-loc').value;
      if(!query) return;
      updateLocationDisplay('Finding location...');
      
      try {
        const res = await fetch(\`https://nominatim.openstreetmap.org/search?q=\${encodeURIComponent(query)}&format=json&limit=1\`);
        const data = await res.json();
        if(data && data.length > 0) {
          farmerLat = parseFloat(data[0].lat);
          farmerLon = parseFloat(data[0].lon);
          updateLocationDisplay(\`Location: \${data[0].display_name.split(',')[0]} - \${farmerLat.toFixed(2)}, \${farmerLon.toFixed(2)}\`);
          fetchAdvisory();
        } else {
          updateLocationDisplay('Location not found. Try another village or city.');
        }
      } catch(e) { updateLocationDisplay('Location lookup failed. Check your connection.'); }
    }

    function getGPSLocation() {
      if (navigator.geolocation) {
        updateLocationDisplay('Acquiring device location...');
        navigator.geolocation.getCurrentPosition((pos) => {
          farmerLat = pos.coords.latitude;
          farmerLon = pos.coords.longitude;
          updateLocationDisplay(\`Device location - \${farmerLat.toFixed(2)}, \${farmerLon.toFixed(2)}\`);
          fetchAdvisory();
        }, () => updateLocationDisplay('Location permission unavailable. Enter your village or city instead.'));
      } else updateLocationDisplay('Device location is not supported. Enter your village or city instead.');
    }

    async function fetchAdvisory() {
      const crop = document.getElementById('crop-select').value;
      const state = document.getElementById('state-select').value;
      const quantity = parseFloat(document.getElementById('crop-qty').value) || 40;
      const ratePerKm = parseFloat(document.getElementById('transport-rate').value) || 25;

      const btnAdvice = document.getElementById('ai-advice');
      const container = document.getElementById('mandi-cards');
      document.getElementById('data-status-text').textContent = 'UPDATING ESTIMATE';
      btnAdvice.textContent = 'Checking available mandi prices and estimating your net return...';
      container.innerHTML = '<div class="empty-state"><div class="empty-icon"><i data-lucide="loader-circle" class="animate-spin"></i></div><h3>Preparing your comparison</h3><p>Checking mandi prices, travel distance and local weather.</p></div>';
      lucide.createIcons();

      try {
        const res = await fetch('/api/advisory/calculate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ crop, quantity, ratePerKm, farmerLat, farmerLon, state })
        });
        
        const data = await res.json();

        if (!res.ok || data.error) {
          document.getElementById('data-status-text').textContent = 'DATA SOURCE ISSUE';
          const errorMessage = document.createElement('div');
          errorMessage.className = 'error-state';
          const title = document.createElement('h3');
          title.textContent = 'Market data is temporarily unavailable';
          const detail = document.createElement('p');
          detail.textContent = data.error || 'Unable to fetch advisory data.';
          errorMessage.append(title, detail);
          container.replaceChildren(errorMessage);
          btnAdvice.textContent = 'A recommendation needs market prices. Your inputs are saved; try again shortly.';
          return;
        }

        document.getElementById('data-status-text').textContent = data.mandis.length + ' MANDIS COMPARED';
        btnAdvice.textContent = data.aiRecommendation.replace(/\\*\\*(.*?)\\*\\*/g, '$1');
        container.innerHTML = '';
        
        data.mandis.forEach((m, idx) => {
          const isBest = idx === 0;
          container.innerHTML += \`
            <article class="mandi-card \${isBest ? 'is-best' : ''} fade-in">
              \${isBest ? '<span class="mandi-badge">Best net return</span>' : ''}
              <h3 class="mandi-name">\${m.name}</h3>
              <div class="mandi-meta">
                <span class="meta-tag"><i data-lucide="map" class="w-3 h-3 inline"></i> \${m.distance} km</span>
                <span class="meta-tag">Market rate ₹\${m.modalPrice}/Q</span>
              </div>
              <div class="finance-list">
                <div class="finance-row"><span>Gross revenue</span><span class="finance-value">₹\${Math.round(m.grossRevenue).toLocaleString('en-IN')}</span></div>
                <div class="finance-row"><span>Transport · \${m.trips} trips</span><span class="finance-value cost">−₹\${Math.round(m.transportCost).toLocaleString('en-IN')}</span></div>
                <div class="finance-row net-row"><span>Estimated net return</span><span class="finance-value">₹\${Math.round(m.netRevenue).toLocaleString('en-IN')}</span></div>
              </div>
              <div class="weather-row">
                <span>\${m.weather.temp}, \${m.weather.condition}</span>
                <span class="weather-risk \${m.weather.rainChance > 40 ? 'is-risky' : ''}">\${m.weather.rainChance}% rain risk</span>
              </div>
            </article>
          \`;
        });
        lucide.createIcons();
      } catch (err) {
        document.getElementById('data-status-text').textContent = 'CONNECTION ISSUE';
        const errorMessage = document.createElement('div');
        errorMessage.className = 'error-state';
        errorMessage.innerHTML = '<h3>Could not reach the advisory service</h3><p>Check your connection and try changing a field to request a fresh estimate.</p>';
        container.replaceChildren(errorMessage);
        btnAdvice.textContent = 'The advisory service could not be reached. Please try again.';
      }
    }

    window.onload = () => {
      lucide.createIcons();
      fetchAdvisory();
    };
  </script>
</body>
</html>
  `);
});

if (process.env.NETLIFY !== 'true' && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, async () => {
    try {
      await pool.query('SELECT 1');
      console.log('Postgres connection OK');
    } catch (err) {
      console.error('Postgres connection FAILED — check DATABASE_URL:', err.message);
    }
    console.log(`=======================================================`);
    console.log(` KisanKalyan API Server Active!`);
    console.log(` DB Cache: ENABLED (PostgreSQL)`);
    console.log(` Dashboard: http://localhost:${PORT}`);
    console.log(`=======================================================`);
  });
}

export default app;
