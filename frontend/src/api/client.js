/**
 * API client for communicating with the FastAPI backend.
 */

const BASE_URL = 'http://localhost:8000/api';

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const config = {
    headers: { ...options.headers },
    ...options,
  };

  // Only add Content-Type JSON if not sending FormData
  if (!(config.body instanceof FormData) && !config.headers['Content-Type']) {
    config.headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, config);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }

  return res.json();
}

// ── Portfolios ──────────────────────────────────────────────

export const portfolios = {
  list: () => request('/portfolios'),
  get: (id) => request(`/portfolios/${id}`),
  create: (data) => request('/portfolios', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => request(`/portfolios/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id) => request(`/portfolios/${id}`, { method: 'DELETE' }),
};

// ── Assets ──────────────────────────────────────────────────

export const assets = {
  list: (assetClass) => {
    const params = assetClass ? `?asset_class=${encodeURIComponent(assetClass)}` : '';
    return request(`/assets${params}`);
  },
  get: (id) => request(`/assets/${id}`),
  search: (q) => request(`/assets/search?q=${encodeURIComponent(q)}`),
  create: (data) => request('/assets', { method: 'POST', body: JSON.stringify(data) }),
  changeTicker: (id, data) =>
    request(`/assets/${id}/tickers`, { method: 'POST', body: JSON.stringify(data) }),
  updateMetadata: (id, data) =>
    request(`/assets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
};

// ── Events ──────────────────────────────────────────────────

export const events = {
  list: ({ assetId, portfolioId } = {}) => {
    const params = new URLSearchParams();
    if (assetId) params.set('asset_id', assetId);
    if (portfolioId) params.set('portfolio_id', portfolioId);
    const qs = params.toString();
    return request(`/events${qs ? '?' + qs : ''}`);
  },
  get: (id) => request(`/events/${id}`),
  create: (data) => request('/events', { method: 'POST', body: JSON.stringify(data) }),
  storno: (id, data = {}) =>
    request(`/events/${id}/storno`, { method: 'POST', body: JSON.stringify(data) }),
  correct: (id, data) =>
    request(`/events/${id}/correct`, { method: 'POST', body: JSON.stringify(data) }),
  bulkCreate: (data) =>
    request('/events/bulk', { method: 'POST', body: JSON.stringify(data) }),
  delete: (id) =>
    request(`/events/${id}`, { method: 'DELETE' }),
  bulkDelete: (eventIds) =>
    request('/events/bulk-delete', { method: 'POST', body: JSON.stringify({ event_ids: eventIds }) }),
};

// ── Positions ───────────────────────────────────────────────

export const positions = {
  list: (portfolioId) => {
    const params = portfolioId ? `?portfolio_id=${portfolioId}` : '';
    return request(`/positions${params}`);
  },
  get: (portfolioId, assetId) => request(`/positions/${portfolioId}/${assetId}`),
};

// ── Import ──────────────────────────────────────────────────

export const importXlsx = (portfolioId, file) => {
  const formData = new FormData();
  formData.append('file', file);
  return request(`/import/xlsx?portfolio_id=${portfolioId}`, {
    method: 'POST',
    body: formData,
  });
};

// ── Health ──────────────────────────────────────────────────

export const health = () => request('/health');
