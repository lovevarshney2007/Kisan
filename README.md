# KisanKalyan Advisory

An Express app that compares mandi prices, estimates transport costs and weather risk, and recommends a market. PostgreSQL stores cached mandi coordinates, mandi prices, and route distances. The dashboard is served by the same Node.js process.

## Requirements

- Node.js 18 or newer and npm
- PostgreSQL

## Setup on Windows PowerShell

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Create a local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Edit `.env` and set `DATABASE_URL`. Mandi prices come from the public `mandi-api.onrender.com` endpoint, district coordinates use Open-Meteo geocoding, and driving distances use OSRM. These services do not require API keys. Gemini advice is optional; keep `.env` private and do not commit it.

4. Create the database named in `DATABASE_URL` (the example uses `mandidb`), then apply the schema. With PostgreSQL's `psql` available in PowerShell:

   ```powershell
   psql "$env:DATABASE_URL" -f .\schema.sql
   ```

5. Start the server:

   ```powershell
   npm run dev
   ```

   Open `http://localhost:3000`. For a normal run without file watching, use `npm start`.

The API endpoint is `POST /api/advisory/calculate`. Its request body can include `crop`, `quantity`, `ratePerKm`, `farmerLat`, `farmerLon`, `state`, `market`, `variety`, and `date`. Keyless Mandi API proxies are available at `GET /api/mandi/states`, `/api/mandi/commodities`, `/api/mandi/markets`, `/api/mandi/prices`, and `/api/mandi/history`. The dashboard loads supported states, market choices, crop metadata, and daily price history from these routes.

## Deploy to Netlify

1. Create a hosted PostgreSQL database (for example, on Neon or Supabase) and run `schema.sql` against it.
2. Push this repository to GitHub and import it into Netlify.
3. Keep the build command empty. `netlify.toml` configures `public` as the publish folder and `netlify/functions` as the serverless function folder.
4. In Netlify site settings, add `DATABASE_URL` with the hosted database connection string. Add `GEMINI_API_KEY` only if AI-written recommendations are wanted.
5. Trigger a deploy, then verify `/`, `/api/mandi/states`, and `/api/advisory/calculate` on the Netlify site.

Do not deploy the local `.env` file. Set production secrets through Netlify's environment variable settings.
