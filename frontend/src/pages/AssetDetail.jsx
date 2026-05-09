import { useState, useEffect, useContext } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AppContext } from '../App';
import { assets as assetsApi, events as eventsApi, positions as posApi } from '../api/client';
import EventForm from '../components/EventForm';

function formatMoney(value) {
  const num = parseFloat(value);
  if (isNaN(num)) return '—';
  return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatQuantity(value) {
  const num = parseFloat(value);
  if (isNaN(num)) return '—';
  return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

export default function AssetDetail() {
  const { assetId } = useParams();
  const { activePortfolioId } = useContext(AppContext);
  const navigate = useNavigate();

  const [asset, setAsset] = useState(null);
  const [position, setPosition] = useState(null);
  const [eventList, setEventList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showEventForm, setShowEventForm] = useState(false);
  const [stornoTarget, setStornoTarget] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [a, evts] = await Promise.all([
        assetsApi.get(assetId),
        eventsApi.list({ assetId, portfolioId: activePortfolioId }),
      ]);
      setAsset(a);
      setEventList(evts);

      try {
        const pos = await posApi.get(activePortfolioId, assetId);
        setPosition(pos);
      } catch {
        setPosition(null);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activePortfolioId) load();
  }, [assetId, activePortfolioId]);

  const handleStorno = async (eventId) => {
    if (!confirm('Confirma o estorno deste evento?')) return;
    setError('');
    try {
      await eventsApi.storno(eventId);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="loading-container">
        <div className="spinner" />
        <span>Carregando ativo...</span>
      </div>
    );
  }

  if (!asset) {
    return (
      <div className="empty-state">
        <div className="icon">❓</div>
        <h3>Ativo não encontrado</h3>
        <button className="btn btn-secondary mt-16" onClick={() => navigate('/')}>
          ← Voltar ao Dashboard
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Back button + Header */}
      <button
        className="btn btn-secondary btn-sm mb-24"
        onClick={() => navigate('/')}
      >
        ← Voltar
      </button>

      <div className="flex items-center justify-between mb-24">
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            <span style={{ color: 'var(--text-accent)' }}>
              {asset.current_ticker || `Ativo #${asset.id}`}
            </span>
          </h2>
          <div className="flex items-center gap-8 mt-8">
            <span className="badge badge-class">{asset.asset_class}</span>
            <span className="text-muted">{asset.currency}</span>
            {asset.maturity_date && (
              <span className="text-muted">Venc: {asset.maturity_date}</span>
            )}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowEventForm(true)}>
          + Novo Evento
        </button>
      </div>

      {error && <div className="alert alert-error mb-16">{error}</div>}

      {/* Position cards */}
      {position && (
        <div className="summary-grid">
          <div className="summary-card">
            <div className="label">Quantidade</div>
            <div className="value">{formatQuantity(position.quantity)}</div>
          </div>
          <div className="summary-card">
            <div className="label">Custo Total</div>
            <div className="value">R$ {formatMoney(position.total_cost)}</div>
          </div>
          <div className="summary-card">
            <div className="label">Preço Médio</div>
            <div className="value">R$ {formatMoney(position.average_price)}</div>
          </div>
          <div className="summary-card">
            <div className="label">Resultado Realizado</div>
            <div className={`value ${parseFloat(position.realized_result) >= 0 ? 'positive' : 'negative'}`}>
              R$ {formatMoney(position.realized_result)}
            </div>
          </div>
        </div>
      )}

      {/* Event history */}
      <div className="card" style={{ marginTop: '24px' }}>
        <div className="card-header">
          <div>
            <div className="card-title">Histórico de Eventos (Ledger)</div>
            <div className="card-subtitle">{eventList.length} evento(s) registrado(s)</div>
          </div>
        </div>

        {eventList.length === 0 ? (
          <div className="empty-state" style={{ padding: '40px' }}>
            <p className="text-muted">Nenhum evento registrado para este ativo nesta carteira.</p>
          </div>
        ) : (
          <div className="table-container" style={{ border: 'none' }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Data</th>
                  <th>Evento</th>
                  <th className="right">Quantidade</th>
                  <th className="right">Valor</th>
                  <th>Status</th>
                  <th>Notas</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {eventList.map((ev) => {
                  const isCancelled = ev.is_cancelled;
                  const isStorno = ev.is_storno;
                  return (
                    <tr key={ev.id} style={isCancelled || isStorno ? { opacity: 0.5 } : {}}>
                      <td className="text-muted mono">{ev.id}</td>
                      <td className="mono">{ev.event_date}</td>
                      <td>
                        {isCancelled ? (
                          <span className="badge badge-cancelled">{ev.event_type}</span>
                        ) : isStorno ? (
                          <span className="badge badge-storno">⤺ Estorno</span>
                        ) : (
                          <span className="badge badge-event">{ev.event_type}</span>
                        )}
                      </td>
                      <td className="right mono">{formatQuantity(ev.quantity)}</td>
                      <td className="right mono">{formatMoney(ev.event_value)}</td>
                      <td>
                        {isCancelled && <span className="text-negative" style={{ fontSize: '0.75rem' }}>Cancelado</span>}
                        {isStorno && <span className="text-muted" style={{ fontSize: '0.75rem' }}>Ref: #{ev.storno_of}</span>}
                        {ev.correction_of && <span className="text-muted" style={{ fontSize: '0.75rem' }}>Corr: #{ev.correction_of}</span>}
                        {!isCancelled && !isStorno && !ev.correction_of && <span className="text-positive" style={{ fontSize: '0.75rem' }}>Ativo</span>}
                      </td>
                      <td className="text-muted" style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {ev.notes || '—'}
                      </td>
                      <td>
                        {!isCancelled && !isStorno && (
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => handleStorno(ev.id)}
                            title="Estornar evento"
                          >
                            ⤺
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Event form modal */}
      {showEventForm && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowEventForm(false)}>
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">Novo Evento — {asset.current_ticker}</h2>
              <button className="modal-close" onClick={() => setShowEventForm(false)}>&times;</button>
            </div>
            <EventForm
              assetId={Number(assetId)}
              onSuccess={() => { setShowEventForm(false); load(); }}
              onCancel={() => setShowEventForm(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}
