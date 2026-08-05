import { NextRequest, NextResponse } from 'next/server';

/**
 * OSIRIS — ALPR / Flock Safety Camera Locations API
 * Queries OpenStreetMap (via the Overpass API) for automated license-plate-reader
 * cameras tagged by the DeFlock community project (man_made=surveillance,
 * surveillance:type=ALPR/ANPR). Locations only — these are not live feeds like
 * the CCTV layer, since ALPR operators (Flock Safety, Motorola/Vigilant, etc.)
 * do not expose public video. FREE — no API key, crowdsourced OSM data.
 *
 * Scoped to a lat/lng + radius (km) rather than a global query: Overpass's free
 * public instances rate-limit unbounded worldwide queries.
 */

// Public Overpass mirrors, tried in order until one responds.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

function buildBbox(lat: number, lng: number, radiusKm: number) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.15, Math.cos((lat * Math.PI) / 180)));
  return {
    south: lat - dLat,
    west: lng - dLng,
    north: lat + dLat,
    east: lng + dLng,
  };
}

async function queryOverpass(ql: string): Promise<any> {
  let lastErr: unknown = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: new URLSearchParams({ data: ql }),
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': 'OSIRIS/4.2 (self-hosted OSINT dashboard)' },
      });
      if (res.ok) return await res.json();
      lastErr = new Error(`Overpass ${endpoint} returned ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('All Overpass endpoints failed');
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const lat = parseFloat(searchParams.get('lat') || '');
    const lng = parseFloat(searchParams.get('lng') || '');
    const radiusKm = Math.min(parseFloat(searchParams.get('radius') || '80'), 200);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      // No location yet (e.g. geolocation hasn't resolved) — nothing to query.
      return NextResponse.json({ alprCameras: [], total: 0 });
    }

    const { south, west, north, east } = buildBbox(lat, lng, radiusKm);
    const bboxStr = `${south},${west},${north},${east}`;

    const ql = `[out:json][timeout:25];
(
  node["man_made"="surveillance"]["surveillance:type"="ALPR"](${bboxStr});
  node["man_made"="surveillance"]["surveillance:type"="ANPR"](${bboxStr});
);
out body;`;

    const data = await queryOverpass(ql);
    const cameras = (data?.elements || []).map((el: any) => {
      const t = el.tags || {};
      const brand = t.brand || t.manufacturer || t.operator || 'Unknown make';
      return {
        id: `alpr-${el.id}`,
        lat: el.lat,
        lng: el.lon,
        name: brand,
        brand,
        direction: t['camera:direction'] || t.direction || null,
        mount: t['camera:mount'] || null,
        zone: t['surveillance:zone'] || null,
        note: t.note || null,
        image: t.image || null,
        source: 'OpenStreetMap / DeFlock',
      };
    }).filter((c: any) => Number.isFinite(c.lat) && Number.isFinite(c.lng));

    return NextResponse.json(
      { alprCameras: cameras, total: cameras.length, center: { lat, lng }, radiusKm },
      { headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600' } },
    );
  } catch (error) {
    console.error('ALPR fetch error:', error);
    return NextResponse.json({ alprCameras: [], total: 0, error: 'Failed' }, { status: 500 });
  }
}
