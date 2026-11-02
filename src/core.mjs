export const MARKETS = {
  se: { name: 'Sweden', id: '37i9dQZEVXbLoATJ81JYXz' },
  no: { name: 'Norway', id: '37i9dQZEVXbJvfa0Yxg7E7' },
  dk: { name: 'Denmark', id: '37i9dQZEVXbL3J0k32lWnN' },
  fi: { name: 'Finland', id: '37i9dQZEVXbMxcczTSoGwZ' },
};
export const DATE_PATTERN = /^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec) (\d{4})$/i;
export function parseDate(text) {
  const match = text.trim().match(DATE_PATTERN);
  if (!match) throw new Error('CHART_DATE_INVALID');
  const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[2].toLowerCase().slice(0,3)) + 1;
  const iso = `${match[3]}-${String(month).padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  const value = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(+value) || value.toISOString().slice(0,10) !== iso) throw new Error('CHART_DATE_INVALID');
  return iso;
}

// Store dates and an email outbox only; no Spotify credentials or track data.
export function updateState(previous, observations, now) {
  const state = structuredClone(previous);
  state.markets ??= {};
  state.pending ??= [];
  for (const item of observations) {
    const market = MARKETS[item.code];
    if (!market) throw new Error('UNKNOWN_MARKET');
    const saved = state.markets[item.code] ?? {};
    const error = item.error || (saved.date && item.date < saved.date ? 'CHART_DATE_MOVED_BACKWARDS' : null);
    const enqueue = (kind, subject, text) => state.pending.push({
      id: `${item.code}-${kind}-${now}`, createdAt: now, subject, text,
    });
    if (error) {
      if (!saved.error) enqueue('error', `Chart monitor needs attention: ${market.name}`,
        `${market.name}: ${error}. No chart update was inferred. Check the monitor's GitHub Actions run.`);
      state.markets[item.code] = { ...saved, error };
      continue;
    }
    if (!item.date || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) throw new Error('MISSING_OBSERVATION_DATE');
    if (saved.date && item.date > saved.date) enqueue('update', `Spotify Top 50 ${market.name} updated`,
      `Spotify Top 50 ${market.name} now shows chart date ${item.date} (previously ${saved.date}).\nDetected at ${now}.\nhttps://open.spotify.com/playlist/${market.id}`);
    else if (saved.error) enqueue('recovery', `Chart monitor recovered: ${market.name}`,
      `${market.name}'s playlist date is readable again: ${item.date}.\nhttps://open.spotify.com/playlist/${market.id}`);
    state.markets[item.code] = { date: item.date };
  }
  return state;
}
