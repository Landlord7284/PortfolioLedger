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

async function requestBlob(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, options);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }

  const disposition = res.headers.get('Content-Disposition') || '';
  const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
  return {
    blob: await res.blob(),
    filename: filenameMatch?.[1] || 'relatorio.xlsx',
  };
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
  list: (assetClass, includeMerged = false) => {
    const params = new URLSearchParams();
    if (assetClass) params.set('asset_class', assetClass);
    if (includeMerged) params.set('include_merged', 'true');
    const qs = params.toString();
    return request(`/assets${qs ? '?' + qs : ''}`);
  },
  get: (id) => request(`/assets/${id}`),
  search: (q) => request(`/assets/search?q=${encodeURIComponent(q)}`),
  create: (data) => request('/assets', { method: 'POST', body: JSON.stringify(data) }),
  changeTicker: (id, data) =>
    request(`/assets/${id}/tickers`, { method: 'POST', body: JSON.stringify(data) }),
  updateMetadata: (id, data) =>
    request(`/assets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  tickers: (id) => request(`/assets/${id}/tickers`),
  reviews: () => request('/assets/reviews'),
  resolveReview: (id) => request(`/assets/reviews/${id}/resolve`, { method: 'POST' }),
  createFromReview: (id) => request(`/assets/reviews/${id}/create-asset`, { method: 'POST' }),
  merge: (data) => request('/assets/merge', { method: 'POST', body: JSON.stringify(data) }),
  delete: (id) =>
    request(`/assets/${id}`, { method: 'DELETE' }),
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
  resolveDuplicate: (id) =>
    request(`/events/${id}/resolve-duplicate`, { method: 'POST' }),
};

// ── Positions ───────────────────────────────────────────────

export const positions = {
  list: (portfolioId) => {
    const params = portfolioId ? `?portfolio_id=${portfolioId}` : '';
    return request(`/positions${params}`);
  },
  get: (portfolioId, assetId) => request(`/positions/${portfolioId}/${assetId}`),
};

export const reports = {
  assetsAndRights: ({ portfolioId, year }) => {
    const params = new URLSearchParams({ portfolio_id: portfolioId, year });
    return request(`/reports/assets-and-rights?${params.toString()}`);
  },
  assetsAndRightsXlsx: ({ portfolioId, year }) => {
    const params = new URLSearchParams({ portfolio_id: portfolioId, year });
    return requestBlob(`/reports/assets-and-rights.xlsx?${params.toString()}`);
  },
};

export const b3 = {
  monthlyImport: ({ portfolioId, files }) => {
    const formData = new FormData();
    Array.from(files || []).forEach((file) => {
      formData.append('files', file);
    });
    return request(`/b3/monthly-import?portfolio_id=${portfolioId}`, {
      method: 'POST',
      body: formData,
    });
  },
  sanitizeMonthlyImport: ({ portfolioId, referenceMonth }) =>
    request(`/b3/monthly-import?portfolio_id=${portfolioId}&reference_month=${encodeURIComponent(referenceMonth)}`, {
      method: 'DELETE',
    }),
  incomes: ({ portfolioId, period, assetId, assetClass, eventType, chartGroupBy, tableYear, tableMonth }) => {
    const params = new URLSearchParams({ portfolio_id: portfolioId, period });
    if (assetId) params.set('asset_id', assetId);
    if (assetClass) params.set('asset_class', assetClass);
    if (eventType) params.set('event_type', eventType);
    if (chartGroupBy) params.set('chart_group_by', chartGroupBy);
    if (tableYear) params.set('table_year', tableYear);
    if (tableMonth) params.set('table_month', tableMonth);
    return request(`/b3/incomes?${params.toString()}`);
  },
};

export const tax = {
  ptax: ({ date }) => {
    const params = new URLSearchParams({ date });
    return request(`/tax/ptax?${params.toString()}`);
  },
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

export const brokerageNotes = {
  calculate: (data) =>
    request('/brokerage-notes/calculate', { method: 'POST', body: JSON.stringify(data) }),
  save: (data) =>
    request('/brokerage-notes/save', { method: 'POST', body: JSON.stringify(data) }),
};

// ── Health ──────────────────────────────────────────────────

export const health = () => request('/health');
