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

// Editable Metadata Component
function AssetMetadataCard({ asset, onSave }) {
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (asset) {
      setFormData({
        name: asset.name || '',
        cnpj: asset.cnpj || '',
        isin: asset.isin || '',
        sector: asset.sector || '',
        subsector: asset.subsector || '',
        segment: asset.segment || '',
        maturity_date: asset.maturity_date || '',
      });
    }
  }, [asset]);

  if (!asset) return null;

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(formData);
      setEditing(false);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const fields = [];
  const c = asset.asset_class;
  fields.push({ name: 'name', label: 'Nome da Empresa/Emissor' });
  
  if (['Ação', 'BDR'].includes(c)) {
    fields.push({ name: 'cnpj', label: 'CNPJ' });
    fields.push({ name: 'sector', label: 'Setor' });
    fields.push({ name: 'subsector', label: 'Subsetor' });
    fields.push({ name: 'segment', label: 'Segmento' });
  } else if (['Debênture', 'CRI', 'CRA'].includes(c)) {
    fields.push({ name: 'isin', label: 'Código ISIN' });
    fields.push({ name: 'maturity_date', label: 'Vencimento', type: 'date' });
  } else if (c === 'ETF') {
    fields.push({ name: 'cnpj', label: 'CNPJ' });
    fields.push({ name: 'isin', label: 'Código ISIN' });
  } else if (['FII', 'FI-INFRA'].includes(c)) {
    fields.push({ name: 'cnpj', label: 'CNPJ' });
    fields.push({ name: 'segment', label: 'Segmento' });
  } else if (['Stock', 'REIT'].includes(c)) {
    fields.push({ name: 'isin', label: 'Código ISIN' });
  }

  if (fields.length === 1 && fields[0].name === 'name') {
    // Basic fallback for other classes
  }

  return (
    <div className="card mb-24">
      <div className="flex justify-between items-center mb-16">
        <h3 style={{ margin: 0, fontSize: '1rem' }}>Informações do Ativo</h3>
        {!editing ? (
          <button className="btn btn-sm btn-secondary" onClick={() => setEditing(true)}>✏️ Editar</button>
        ) : (
          <div className="flex gap-8">
            <button className="btn btn-sm btn-secondary" onClick={() => setEditing(false)}>Cancelar</button>
            <button className="btn btn-sm btn-primary" onClick={handleSave} disabled={saving}>Salvar</button>
          </div>
        )}
      </div>

      <div className="form-row">
        {fields.map(f => (
          <div className="form-group" key={f.name}>
            <label className="form-label">{f.label}</label>
            {editing ? (
              <input
                className="form-input"
                type={f.type || 'text'}
                name={f.name}
                value={formData[f.name]}
                onChange={handleChange}
              />
            ) : (
              <div style={{ color: 'var(--text-primary)', padding: '8px 0' }}>
                {asset[f.name] || '—'}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Correction Modal
function CorrectionModal({ event, onClose, onSuccess }) {
  const [eventType, setEventType] = useState(event.event_type);
  const [eventDate, setEventDate] = useState(event.event_date);
  const [quantity, setQuantity] = useState(event.quantity);
  const [eventValue, setEventValue] = useState(event.event_value);
  const [notes, setNotes] = useState(event.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await eventsApi.correct(event.id, {
        event_type: eventType,
        event_date: eventDate,
        quantity: quantity.replace(',', '.'),
        event_value: eventValue.replace(',', '.'),
        notes: notes || null,
      });
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const EVENT_TYPES = [
    'Compra', 'Venda', 'Desdobramento', 'Grupamento',
    'Bonificação', 'Amortização', 'Cisão',
    'Resgate Antecipado', 'Resgate Vencimento',
  ];

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Editar / Corrigir Evento #{event.id}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <form onSubmit={handleSubmit}>
          {error && <div className="alert alert-error">{error}</div>}
          <div className="alert alert-warning mb-16">
            A edição cria automaticamente um estorno do evento original e lança o evento corrigido.
          </div>
          <div className="form-group mb-16">
            <label className="form-label">Tipo de Evento</label>
            <select className="form-select" value={eventType} onChange={(e) => setEventType(e.target.value)}>
              {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="form-row mb-16">
            <div className="form-group">
              <label className="form-label">Data</label>
              <input type="date" className="form-input" value={eventDate} onChange={(e) => setEventDate(e.target.value)} required />
            </div>
            <div className="form-group">
              <label className="form-label">Quantidade</label>
              <input className="form-input" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
            </div>
            <div className="form-group">
              <label className="form-label">Valor</label>
              <input className="form-input" value={eventValue} onChange={(e) => setEventValue(e.target.value)} required />
            </div>
          </div>
          <div className="form-group mb-16">
            <label className="form-label">Notas</label>
            <input className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="modal-footer" style={{ border: 'none', padding: 0 }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>Salvar Correção</button>
          </div>
        </form>
      </div>
    </div>
  );
}


export default function AssetDetail() {
  const { assetId } = useParams();
  const { activePortfolioId, hideValues } = useContext(AppContext);
  const navigate = useNavigate();

  const [asset, setAsset] = useState(null);
  const [position, setPosition] = useState(null);
  const [eventList, setEventList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showEventForm, setShowEventForm] = useState(false);
  const [isLargeModal, setIsLargeModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [error, setError] = useState('');
  const [selectedEvents, setSelectedEvents] = useState(new Set());

  const formatDateToBr = (isoStr) => {
    if (!isoStr) return '';
    const [y, m, d] = isoStr.split('-');
    return `${d}/${m}/${y}`;
  };

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

  const handleDelete = async (eventId) => {
    if (!confirm('Confirma a exclusão deste evento?')) return;
    setError('');
    try {
      await eventsApi.delete(eventId);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Confirma a exclusão de ${selectedEvents.size} evento(s)?`)) return;
    setError('');
    try {
      await eventsApi.bulkDelete(Array.from(selectedEvents));
      setSelectedEvents(new Set());
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleResolveDuplicate = async (eventId, confirmDuplicate) => {
    if (!confirm(confirmDuplicate ? 'Confirmar este evento como válido e remover alerta?' : 'Ignorar e excluir este evento duplicado?')) return;
    setError('');
    try {
      if (confirmDuplicate) {
        await eventsApi.resolveDuplicate(eventId);
      } else {
        await eventsApi.delete(eventId);
      }
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteAsset = async () => {
    if (!confirm(`Tem certeza que deseja excluir completamente o ativo ${asset.current_ticker} do banco de dados?`)) return;
    setError('');
    try {
      await assetsApi.delete(asset.id);
      navigate('/');
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleSelect = (id) => {
    const next = new Set(selectedEvents);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedEvents(next);
  };

  const displayMoney = (val) => hideValues ? '•••••' : formatMoney(val);
  const displayQuantity = (val) => hideValues ? '•••••' : formatQuantity(val);

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

  const validEvents = eventList.filter(ev => !ev.is_cancelled && !ev.is_storno);
  const orderedEventList = [...eventList].reverse();

  return (
    <>
      <button className="btn btn-secondary btn-sm mb-24" onClick={() => navigate('/')}>
        ← Voltar
      </button>

      <div className="flex items-center justify-between mb-24">
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            <span style={{ color: 'var(--text-accent)' }}>
              {asset.current_ticker || `Ativo #${asset.id}`}
            </span>
            {asset.duplicate_flag && <span className="badge badge-warning" style={{marginLeft: '12px'}}>⚠️ Duplicado detectado</span>}
          </h2>
          <div className="flex items-center gap-8 mt-8">
            <span className="badge badge-class">{asset.asset_class}</span>
            <span className="text-muted">{asset.currency}</span>
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowEventForm(true)}>
          + Novo Evento
        </button>
      </div>

      {error && <div className="alert alert-error mb-16">{error}</div>}

      <AssetMetadataCard 
        asset={asset} 
        onSave={(data) => assetsApi.updateMetadata(asset.id, data).then(setAsset)} 
      />

      {position && (
        <div className="summary-grid mb-24">
          <div className="summary-card">
            <div className="label">Quantidade</div>
            <div className="value">{displayQuantity(position.quantity)}</div>
          </div>
          <div className="summary-card">
            <div className="label">Custo Total</div>
            <div className="value">R$ {displayMoney(position.total_cost)}</div>
          </div>
          <div className="summary-card">
            <div className="label">Preço Médio</div>
            <div className="value">R$ {displayMoney(position.average_price)}</div>
          </div>
          <div className="summary-card">
            <div className="label">Resultado Realizado</div>
            <div className={`value ${!hideValues && parseFloat(position.realized_result) >= 0 ? 'positive' : !hideValues ? 'negative' : ''}`}>
              R$ {displayMoney(position.realized_result)}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Histórico de Eventos (Ledger)</div>
            <div className="card-subtitle">{eventList.length} evento(s) registrado(s)</div>
          </div>
          <div className="flex gap-8 items-center">
            {selectedEvents.size > 0 && (
              <>
                <button className="btn btn-sm btn-secondary" onClick={() => setSelectedEvents(new Set())}>
                  Limpar Seleção
                </button>
                <button className="btn btn-sm btn-danger" onClick={handleBulkDelete}>
                  🗑️ Excluir Selecionados ({selectedEvents.size})
                </button>
              </>
            )}
            {validEvents.length === 0 && eventList.length > 0 && (
               <button className="btn btn-sm btn-danger" onClick={handleDeleteAsset}>
                 ⚠️ Excluir Ativo Completamente
               </button>
            )}
            {eventList.length === 0 && (
               <button className="btn btn-sm btn-danger" onClick={handleDeleteAsset}>
                 ⚠️ Excluir Ativo
               </button>
            )}
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
                  <th style={{ width: '40px' }}>
                    <input 
                      type="checkbox" 
                      onChange={(e) => setSelectedEvents(e.target.checked ? new Set(validEvents.map(ev => ev.id)) : new Set())}
                      checked={validEvents.length > 0 && selectedEvents.size === validEvents.length}
                    />
                  </th>
                  <th>Data</th>
                  <th>Evento</th>
                  <th className="right">Quantidade</th>
                  <th className="right">Valor</th>
                  <th className="right">Resultado</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {orderedEventList.map((ev) => {
                  const isCancelled = ev.is_cancelled;
                  const isStorno = ev.is_storno;
                  const isInteractive = !isCancelled && !isStorno;
                  
                  return (
                    <tr key={ev.id} style={!isInteractive ? { opacity: 0.5 } : {}}>
                      <td>
                        {isInteractive && (
                          <input 
                            type="checkbox" 
                            checked={selectedEvents.has(ev.id)}
                            onChange={() => toggleSelect(ev.id)}
                          />
                        )}
                      </td>
                      <td className="mono">{formatDateToBr(ev.event_date)}</td>
                      <td>
                        {isCancelled ? (
                          <span className="badge badge-cancelled">{ev.event_type}</span>
                        ) : isStorno ? (
                          <span className="badge badge-storno">⤺ Estorno</span>
                        ) : (
                          <span className="badge badge-event">
                            {ev.duplicate_flag && "⚠️ "}
                            {ev.event_type}
                          </span>
                        )}
                      </td>
                      <td className="right mono">{displayQuantity(ev.quantity)}</td>
                      <td className="right mono">{displayMoney(ev.event_value)}</td>
                      <td className={`right mono ${!hideValues && ev.realized_event_result && parseFloat(ev.realized_event_result) > 0 ? 'text-positive' : !hideValues && ev.realized_event_result && parseFloat(ev.realized_event_result) < 0 ? 'text-negative' : ''}`}>
                        {ev.realized_event_result ? displayMoney(ev.realized_event_result) : '—'}
                      </td>
                      <td>
                        {isCancelled && <span className="text-negative" style={{ fontSize: '0.75rem' }}>Cancelado</span>}
                        {isStorno && <span className="text-muted" style={{ fontSize: '0.75rem' }}>Ref: #{ev.storno_of}</span>}
                        {ev.correction_of && <span className="text-muted" style={{ fontSize: '0.75rem' }}>Corr: #{ev.correction_of}</span>}
                        {!isCancelled && !isStorno && !ev.correction_of && <span className="text-positive" style={{ fontSize: '0.75rem' }}>Ativo</span>}
                      </td>
                      <td>
                        {isInteractive && (
                          <div className="flex gap-8">
                            {ev.duplicate_flag ? (
                              <>
                                <button className="btn btn-sm btn-primary" onClick={() => handleResolveDuplicate(ev.id, true)}>Confirmar</button>
                                <button className="btn btn-sm btn-danger" onClick={() => handleResolveDuplicate(ev.id, false)}>Ignorar</button>
                              </>
                            ) : (
                              <>
                                <button className="btn btn-sm btn-secondary" onClick={() => setEditingEvent(ev)}>✏️</button>
                                <button className="btn btn-sm btn-danger" onClick={() => handleDelete(ev.id)}>🗑️</button>
                              </>
                            )}
                          </div>
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

      {showEventForm && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowEventForm(false)}>
          <div className={`modal ${isLargeModal ? 'modal-large' : ''}`}>
            <div className="modal-header">
              <h2 className="modal-title">Novo Evento — {asset.current_ticker}</h2>
              <button className="modal-close" onClick={() => setShowEventForm(false)}>&times;</button>
            </div>
            <EventForm
              assetId={Number(assetId)}
              onSuccess={() => { setShowEventForm(false); load(); }}
              onCancel={() => setShowEventForm(false)}
              onModeChange={setIsLargeModal}
            />
          </div>
        </div>
      )}

      {editingEvent && (
        <CorrectionModal 
          event={editingEvent} 
          onClose={() => setEditingEvent(null)}
          onSuccess={() => { setEditingEvent(null); load(); }}
        />
      )}
    </>
  );
}
