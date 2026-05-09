import { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../App';
import { positions as posApi } from '../api/client';
import EventForm from '../components/EventForm';
import ImportModal from '../components/ImportModal';

/**
 * Format a numeric string as BRL-style display (truncated to 2 decimals).
 */
function formatMoney(value, currency = 'BRL') {
  const num = parseFloat(value);
  if (isNaN(num)) return '—';
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatQuantity(value) {
  const num = parseFloat(value);
  if (isNaN(num)) return '—';
  // Show up to 8 decimals, but trim trailing zeros
  const formatted = num.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
  return formatted;
}

export default function Dashboard() {
  const { activePortfolioId, portfolioList, hideValues } = useContext(AppContext);
  const [positionList, setPositionList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showEventForm, setShowEventForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [filterClass, setFilterClass] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLargeModal, setIsLargeModal] = useState(false);
  const [showRedeemed, setShowRedeemed] = useState(() => {
    return localStorage.getItem('showRedeemed') === 'true';
  });
  const navigate = useNavigate();

  useEffect(() => {
    localStorage.setItem('showRedeemed', showRedeemed);
  }, [showRedeemed]);

  const loadPositions = async () => {
    if (!activePortfolioId) {
      setPositionList([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await posApi.list(activePortfolioId);
      setPositionList(data);
    } catch (err) {
      console.error('Failed to load positions:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPositions();
  }, [activePortfolioId]);

  // Filtered positions
  const filtered = positionList.filter((p) => {
    if (!showRedeemed && parseFloat(p.quantity) === 0) return false;
    if (filterClass && p.asset_class !== filterClass) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const ticker = (p.current_ticker || '').toLowerCase();
      const name = (p.name || '').toLowerCase();
      return ticker.includes(q) || name.includes(q);
    }
    return true;
  });

  const displayMoney = (val) => hideValues ? '•••••' : formatMoney(val);
  const displayQuantity = (val) => hideValues ? '•••••' : formatQuantity(val);

  // Summary calculations
  const totalCost = positionList.reduce((s, p) => s + parseFloat(p.total_cost || 0), 0);
  const totalRealized = positionList.reduce((s, p) => s + parseFloat(p.realized_result || 0), 0);
  const activeAssets = positionList.filter((p) => parseFloat(p.quantity) > 0).length;

  // Unique classes for filter
  const classes = [...new Set(positionList.map((p) => p.asset_class))].sort();

  if (!activePortfolioId) {
    return (
      <div className="empty-state">
        <div className="icon">📁</div>
        <h3>Nenhuma carteira selecionada</h3>
        <p>Crie uma carteira em Configurações para começar.</p>
      </div>
    );
  }

  return (
    <>
      {/* Action bar */}
      <div className="flex items-center justify-between mb-24">
        <div>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 700 }}>Posições Consolidadas</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
            {portfolioList.find((p) => p.id === activePortfolioId)?.name || ''}
          </p>
        </div>
        <div className="search-input-wrapper" style={{ margin: '0 20px', flex: 1, maxWidth: '400px' }}>
          <span className="search-icon">🔍</span>
          <input 
            className="search-input"
            placeholder="Buscar por ticker ou nome..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="flex gap-12">
          <button className="btn btn-secondary" onClick={() => setShowImport(true)}>
            📥 Importar Eventos
          </button>
          <button className="btn btn-primary" onClick={() => setShowEventForm(true)}>
            + Novo Evento
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="summary-grid">
        <div className="summary-card">
          <div className="label">Custo Total</div>
          <div className="value">{hideValues ? '•••••' : `R$ ${formatMoney(totalCost)}`}</div>
        </div>
        <div className="summary-card">
          <div className="label">Resultado Realizado</div>
          <div className={`value ${!hideValues && totalRealized >= 0 ? 'positive' : !hideValues ? 'negative' : ''}`}>
            {hideValues ? '•••••' : `R$ ${formatMoney(totalRealized)}`}
          </div>
        </div>
        <div className="summary-card">
          <div className="label">Ativos em Carteira</div>
          <div className="value">{activeAssets}</div>
        </div>
        <div className="summary-card">
          <div className="label">Total de Ativos</div>
          <div className="value">{positionList.length}</div>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center justify-between mb-16">
        <div className="flex items-center gap-8">
          {classes.length > 1 && (
            <>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Filtrar:</span>
              <button
                className={`btn btn-sm ${!filterClass ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setFilterClass('')}
              >
                Todos
              </button>
              {classes.map((c) => (
                <button
                  key={c}
                  className={`btn btn-sm ${filterClass === c ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setFilterClass(c)}
                >
                  {c}
                </button>
              ))}
            </>
          )}
        </div>
        <div className="flex items-center gap-8">
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Exibir resgatados</span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={showRedeemed}
              onChange={(e) => setShowRedeemed(e.target.checked)}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
      </div>

      {/* Positions table */}
      {loading ? (
        <div className="loading-container">
          <div className="spinner" />
          <span>Carregando posições...</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <h3>Nenhuma posição encontrada</h3>
          <p>Lance um evento ou importe o Dados.xlsx para começar.</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Classe</th>
                <th>Moeda</th>
                <th className="right">Quantidade</th>
                <th className="right">Custo Total</th>
                <th className="right">Preço Médio</th>
                <th className="right">Resultado Realizado</th>
                <th>Último Evento</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((pos) => {
                const realized = parseFloat(pos.realized_result || 0);
                const qty = parseFloat(pos.quantity || 0);
                return (
                  <tr
                    key={`${pos.portfolio_id}-${pos.asset_id}`}
                    className="clickable"
                    onClick={() => navigate(`/assets/${pos.asset_id}`)}
                  >
                    <td>
                      <strong style={{ color: 'var(--text-accent)' }}>
                        {pos.current_ticker || `#${pos.asset_id}`}
                      </strong>
                      {pos.duplicate_flag && <span className="badge badge-warning" style={{marginLeft: '8px'}} title="Possui evento duplicado pendente de análise">🔴</span>}
                    </td>
                    <td><span className="badge badge-class">{pos.asset_class}</span></td>
                    <td className="text-muted">{pos.currency}</td>
                    <td className={`right mono ${qty === 0 ? 'text-muted' : ''}`}>
                      {displayQuantity(pos.quantity)}
                    </td>
                    <td className="right mono">{displayMoney(pos.total_cost)}</td>
                    <td className="right mono">{displayMoney(pos.average_price)}</td>
                    <td className={`right mono ${!hideValues && realized > 0 ? 'text-positive' : !hideValues && realized < 0 ? 'text-negative' : ''}`}>
                      {displayMoney(pos.realized_result)}
                    </td>
                    <td className="text-muted">{pos.last_event_date || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Event form modal */}
      {showEventForm && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowEventForm(false)}>
          <div className={`modal ${isLargeModal ? 'modal-large' : ''}`}>
            <div className="modal-header">
              <h2 className="modal-title">Novo Evento</h2>
              <button className="modal-close" onClick={() => setShowEventForm(false)}>&times;</button>
            </div>
            <EventForm
              onSuccess={() => { setShowEventForm(false); loadPositions(); }}
              onCancel={() => setShowEventForm(false)}
              onModeChange={setIsLargeModal}
            />
          </div>
        </div>
      )}

      {/* Import modal */}
      {showImport && (
        <ImportModal
          portfolioId={activePortfolioId}
          onClose={() => setShowImport(false)}
          onSuccess={loadPositions}
        />
      )}
    </>
  );
}
