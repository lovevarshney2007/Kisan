-- Run this once against your Postgres database to set up the cache tables.

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

-- Speeds up the rounded-coordinate distance lookups
CREATE INDEX IF NOT EXISTS idx_distances_lookup
  ON distances (farmer_lat, farmer_lon, mandi_lat, mandi_lon);
