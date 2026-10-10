// Service areas and the cities in each. Shared by listing sync, search and matching.
export const AREAS = ["GTA", "Waterloo", "Cambridge"];

const CITIES = {
  GTA: [
    "Toronto", "North York", "Scarborough", "Etobicoke", "East York", "York",
    "Mississauga", "Brampton", "Caledon",
    "Markham", "Vaughan", "Richmond Hill", "Aurora", "Newmarket", "King", "Whitchurch-Stouffville",
    "Stouffville", "East Gwillimbury", "Georgina",
    "Pickering", "Ajax", "Whitby", "Oshawa", "Clarington", "Uxbridge", "Scugog", "Brock",
    "Oakville", "Milton", "Burlington", "Halton Hills",
  ],
  Waterloo: ["Waterloo", "Kitchener", "Woolwich", "Wilmot", "Wellesley", "North Dumfries", "Elmira", "New Hamburg"],
  Cambridge: ["Cambridge"],
};

const lookup = new Map();
for (const [area, cities] of Object.entries(CITIES)) for (const c of cities) lookup.set(c.toLowerCase(), area);

export function citiesIn(area) {
  return CITIES[area] ? [...CITIES[area]] : [];
}

export function allCities() {
  return Object.values(CITIES).flat();
}

// Maps a city name to its area, or null when it's outside the service areas.
export function areaForCity(city) {
  if (!city) return null;
  return lookup.get(String(city).trim().toLowerCase()) ?? null;
}

// Best-effort area from free text a searcher typed ("condo in Kitchener", "Toronto, ON", "GTA").
export function areaFromText(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  for (const area of AREAS) if (t.includes(area.toLowerCase())) return area === "Waterloo" && t.includes("cambridge") ? "Cambridge" : area;
  let best = null;
  for (const [city, area] of lookup) {
    if (new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t) && (!best || city.length > best.city.length)) best = { city, area };
  }
  return best?.area ?? null;
}
