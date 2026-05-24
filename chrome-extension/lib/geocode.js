// City geocoding via the free, keyless Open-Meteo geocoding API.
// Resolves a typed city to real places with region (admin1) + country + coords,
// so the picker can validate locations and auto-fill the province for any country.

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// Map the API payload to flat place objects. Pure — unit-testable.
export function parseGeoResults(json) {
  const results = (json && json.results) || [];
  return results.map((r) => {
    const city = r.name || '';
    const state = r.admin1 || '';
    const country = r.country || '';
    return {
      city,
      state,
      country,
      countryCode: r.country_code || '',
      lat: r.latitude,
      lon: r.longitude,
      label: [city, state, country].filter(Boolean).join(', '),
    };
  });
}

export async function searchPlaces(query, { count = 8, signal } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const url = `${GEO_URL}?name=${encodeURIComponent(q)}&count=${count}&language=en&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  return parseGeoResults(await res.json());
}
