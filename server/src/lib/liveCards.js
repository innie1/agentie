import axios from "axios";

const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

function cached(key) {
  const hit = cache.get(key);
  return hit && hit.expires > Date.now() ? hit.value : null;
}
function remember(key, value) { cache.set(key, { value, expires: Date.now() + CACHE_MS }); return value; }

const WEATHER_CODES = {
  0: ["Clear", "sunny"], 1: ["Mostly clear", "partly_cloudy_day"], 2: ["Partly cloudy", "partly_cloudy_day"], 3: ["Overcast", "cloud"],
  45: ["Foggy", "foggy"], 48: ["Foggy", "foggy"], 51: ["Light drizzle", "rainy_light"], 53: ["Drizzle", "rainy"], 55: ["Heavy drizzle", "rainy"],
  61: ["Light rain", "rainy_light"], 63: ["Rain", "rainy"], 65: ["Heavy rain", "rainy_heavy"], 71: ["Light snow", "weather_snowy"],
  73: ["Snow", "weather_snowy"], 75: ["Heavy snow", "snowing_heavy"], 80: ["Rain showers", "rainy"], 81: ["Rain showers", "rainy"],
  82: ["Heavy showers", "rainy_heavy"], 95: ["Thunderstorm", "thunderstorm"], 96: ["Thunderstorm", "thunderstorm"], 99: ["Thunderstorm", "thunderstorm"],
};

export function weatherLocationFrom(text) {
  const input = String(text || "").trim();
  const match = input.match(/(?:\bin|\bfor|\bat)\s+([\p{L} .,'-]+?)(?:\?|$)/iu)
    || input.match(/(?:weather|forecast|temperature)(?:\s+(?:in|for|at))?\s+([\p{L} .,'-]+?)(?:\?|$)/iu)
    || input.match(/([\p{L} .,'-]+?)\s+(?:weather|forecast|temperature)(?:\?|$)/iu);
  const location = String(match?.[1] || "").replace(/\b(today|tonight|now|please|right now)\b/gi, "").trim();
  return location && !/^(?:the|current|local|my|this area|what(?:'s|s| is)?(?: the)?|show me(?: the)?|tell me(?: the)?|give me(?: the)?)$/i.test(location) ? location : "Lagos";
}

export async function liveWeatherCard(location) {
  const key = `weather:${String(location).toLowerCase()}`;
  if (cached(key)) return cached(key);
  const geo = await axios.get("https://geocoding-api.open-meteo.com/v1/search", { params: { name: location, count: 1, language: "en", format: "json" }, timeout: 7000 });
  const place = geo.data?.results?.[0];
  if (!place) throw new Error(`I couldn't find weather data for ${location}.`);
  const forecast = await axios.get("https://api.open-meteo.com/v1/forecast", {
    params: {
      latitude: place.latitude, longitude: place.longitude, timezone: "auto", forecast_days: 4,
      current: "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max",
    }, timeout: 7000,
  });
  const current = forecast.data.current || {}; const daily = forecast.data.daily || {};
  const [condition, icon] = WEATHER_CODES[current.weather_code] || ["Current conditions", "partly_cloudy_day"];
  const days = (daily.time || []).slice(0, 4).map((date, index) => ({
    day: new Date(`${date}T12:00:00`).toLocaleDateString("en", { weekday: "short" }),
    tempC: Math.round(daily.temperature_2m_max?.[index] ?? current.temperature_2m ?? 0),
    icon: (WEATHER_CODES[daily.weather_code?.[index]] || [null, "partly_cloudy_day"])[1],
  }));
  return remember(key, {
    result_type: "weather_card",
    result_payload: { weather: { location: [place.name, place.country].filter(Boolean).join(", "), tempC: Math.round(current.temperature_2m ?? 0), highC: Math.round(daily.temperature_2m_max?.[0] ?? current.temperature_2m ?? 0), lowC: Math.round(daily.temperature_2m_min?.[0] ?? current.temperature_2m ?? 0), condition, icon, humidity: current.relative_humidity_2m ?? 0, wind: Math.round(current.wind_speed_10m ?? 0), precipitation: daily.precipitation_probability_max?.[0] ?? 0, uv: Math.round(daily.uv_index_max?.[0] ?? 0), forecast: days, updated_at: current.time } },
    text: `Current weather for ${place.name}.`,
  });
}

const TEAM_ALIASES = { "man u": "Manchester United", "man utd": "Manchester United", "man united": "Manchester United", "mayu": "Manchester United", "chelsea fc": "Chelsea" };
function cleanTeam(value) {
  const cleaned = String(value || "").toLowerCase().replace(/\b(what|when|time|does|do|is|are|there|have|has|a|the|football|soccer|match|game|fixture|kickoff|playing|play|today|tonight|tomorrow|please|show|me)\b/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return TEAM_ALIASES[cleaned] || cleaned.replace(/\b\w/g, letter => letter.toUpperCase());
}
export function footballTeamsFrom(text) {
  const input = String(text || "").toLowerCase().replace(/[?.!]+$/, "").trim();
  if (!/\b(soccer|football|match|game|fixture|kick\s*off|score|playing|play)\b/.test(input)) return null;
  const known = [
    ["manchester united", "Manchester United"], ["man united", "Manchester United"], ["man utd", "Manchester United"], ["man u", "Manchester United"], ["mayu", "Manchester United"],
    ["manchester city", "Manchester City"], ["man city", "Manchester City"], ["chelsea", "Chelsea"], ["arsenal", "Arsenal"], ["liverpool", "Liverpool"],
    ["tottenham", "Tottenham Hotspur"], ["spurs", "Tottenham Hotspur"], ["real madrid", "Real Madrid"], ["barcelona", "Barcelona"], ["bayern munich", "Bayern Munich"], ["psg", "Paris Saint-Germain"],
  ];
  const mentions = [];
  for (const [needle, team] of known) {
    if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(input) && !mentions.includes(team)) mentions.push(team);
  }
  if (mentions.length) return mentions.slice(0, 2);
  const match = input.match(/(.+?)\s+(?:vs?\.?|versus|against|and)\s+(.+)/i);
  if (match) {
    const teams = [cleanTeam(match[1]), cleanTeam(match[2])];
    if (teams.every(Boolean)) return teams;
  }
  const single = cleanTeam(input);
  return single ? [single] : null;
}
async function sportsTeam(name, apiKey) {
  const response = await axios.get(`https://www.thesportsdb.com/api/v1/json/${apiKey}/searchteams.php`, { params: { t: name }, timeout: 7000 });
  return (response.data?.teams || []).find(team => team.strSport === "Soccer") || response.data?.teams?.[0] || null;
}
export async function footballFixtureCard(teamNames, todayOnly = false) {
  const key = `fixture:${teamNames.join(":").toLowerCase()}:${todayOnly}`;
  if (cached(key)) return cached(key);
  const apiKey = process.env.THESPORTSDB_API_KEY || "123";
  const teams = await Promise.all(teamNames.map(name => sportsTeam(name, apiKey)));
  if (teams.some(team => !team)) throw new Error(`I couldn't identify the football team: ${teamNames.join(" and ")}.`);
  const eventLists = await Promise.all(teams.map(team => axios.get(`https://www.thesportsdb.com/api/v1/json/${apiKey}/eventsnext.php`, { params: { id: team.idTeam }, timeout: 7000 }).then(r => r.data?.events || []).catch(() => [])));
  const allEvents = eventLists.flat();
  const event = teams.length > 1 ? (allEvents.find(item => {
    const ids = [String(item.idHomeTeam), String(item.idAwayTeam)];
    return ids.includes(String(teams[0].idTeam)) && ids.includes(String(teams[1].idTeam));
  }) || null) : (eventLists[0]?.[0] || null);
  const todayParts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
  const isToday = event?.dateEvent === today;
  const shownEvent = todayOnly && !isToday ? null : event;
  const homeTeam = shownEvent ? teams.find(team => String(team.idTeam) === String(shownEvent.idHomeTeam)) : teams[0];
  const awayTeam = shownEvent ? teams.find(team => String(team.idTeam) === String(shownEvent.idAwayTeam)) : teams[1];
  const rawKickoff = shownEvent?.strTimestamp || null;
  const kickoff = rawKickoff
    ? (/Z$|[+-]\d{2}:?\d{2}$/i.test(rawKickoff) ? rawKickoff : `${rawKickoff}Z`)
    : (shownEvent?.dateEvent ? `${shownEvent.dateEvent}T${String(shownEvent.strTime || "00:00:00").replace(/Z$/i, "")}Z` : null);
  const rawStatus = String(shownEvent?.strStatus || "").toUpperCase();
  const readableStatus = ({ NS: "Scheduled", FT: "Full time", AET: "After extra time", PEN: "Penalties", HT: "Half time", LIVE: "Live" })[rawStatus] || shownEvent?.strStatus || null;
  const payload = {
    home: { name: shownEvent?.strHomeTeam || homeTeam?.strTeam || teams[0].strTeam, logo: shownEvent?.strHomeTeamBadge || homeTeam?.strBadge || teams[0].strBadge },
    away: { name: shownEvent?.strAwayTeam || awayTeam?.strTeam || (todayOnly ? "No match" : "Opponent unavailable"), logo: shownEvent?.strAwayTeamBadge || awayTeam?.strBadge || null },
    competition: shownEvent?.strLeague || teams[0].strLeague || "Football",
    kickoff: shownEvent ? kickoff : null,
    venue: shownEvent?.strVenue || null,
    status: shownEvent ? (isToday && (!readableStatus || readableStatus === "Scheduled") ? "Today" : (readableStatus || "Scheduled")) : (todayOnly ? "No match today" : "Fixture unavailable"),
    message: shownEvent ? null : `No ${todayOnly ? "match today" : "upcoming fixture"} was found between these teams.`,
  };
  return remember(key, { result_type: "sports_fixture_card", result_payload: payload, text: payload.message || `${payload.home.name} vs ${payload.away.name}` });
}
