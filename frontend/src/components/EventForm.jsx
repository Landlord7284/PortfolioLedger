import { useState, useEffect, useContext, useRef } from 'react';
import { AppContext } from '../App';
import { events as eventsApi, assets as assetsApi } from '../api/client';

const EVENT_TYPES = [
  'Compra', 'Venda', 'Desdobramento', 'Grupamento',
  'Bonificação', 'Amortização', 'Cisão',
  'Resgate Antecipado', 'Resgate Vencimento',
];

const ASSET_CLASSES = [
  'Ação', 'BDR', 'Criptomoeda', 'Debênture', 'CRI', 'CRA',
  'ETF', 'FII', 'FI-INFRA', 'Tesouro Direto', 'Stock', 'REIT',
];

const CLASSES_WITH_MATURITY = ['Debênture', 'CRI', 'CRA', 'Tesouro Direto'];

const VALUE_IGNORED = ['Desdobramento', 'Grupamento'];

function SearchableSelect({ options, value, onChange, disabled }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selected = options.find((o) => o.value === value);
  const displayValue = open ? search : (selected ? selected.label : '');

  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="search-input-wrapper" ref={wrapperRef} style={{ width: '100%', maxWidth: 'none' }}>
      <input
        className="form-input"
        style={{ width: '100%', paddingLeft: '14px' }}
        value={displayValue}
        disabled={disabled}
        placeholder="Buscar ativo..."
        onFocus={() => { setOpen(true); setSearch(''); }}
        onChange={(e) => setSearch(e.target.value)}
      />
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, 
          background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
          borderRadius: 'var(--radius-md)', zIndex: 10, maxHeight: '200px', overflowY: 'auto',
          marginTop: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
        }}>
          {filtered.length === 0 && <div style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>Nenhum encontrado</div>}
          {filtered.map((o) => (
            <div
              key={o.value}
              style={{
                padding: '8px 12px', cursor: 'pointer',
                background: o.value === value ? 'var(--bg-card-hover)' : 'transparent'
              }}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent input blur
                onChange(o.value);
                setOpen(false);
              }}
              onMouseEnter={(e) => e.target.style.background = 'var(--bg-card-hover)'}
              onMouseLeave={(e) => e.target.style.background = o.value === value ? 'var(--bg-card-hover)' : 'transparent'}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function EventForm({ assetId, onSuccess, onCancel, onModeChange }) {
  const { activePortfolioId } = useContext(AppContext);
  const [assetList, setAssetList] = useState([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [isBulkMode, setIsBulkMode] = useState(false);

  useEffect(() => {
    if (onModeChange) onModeChange(isBulkMode);
  }, [isBulkMode, onModeChange]);

  const formatDateToBr = (isoStr) => {
    if (!isoStr) return '';
    const [y, m, d] = isoStr.split('-');
    return `${d}/${m}/${y}`;
  };

  const parseBrToDate = (brStr) => {
    if (!brStr || brStr.length !== 10) return '';
    const [d, m, y] = brStr.split('/');
    return `${y}-${m}-${d}`;
  };

  const handleDateMask = (value) => {
    let v = value.replace(/\D/g, '');
    if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2);
    if (v.length > 5) v = v.slice(0, 5) + '/' + v.slice(5, 9);
    return v;
  };

  // Single mode state
  const [selectedAssetId, setSelectedAssetId] = useState(assetId || '');
  const [eventType, setEventType] = useState('Compra');
  const [eventDate, setEventDate] = useState(formatDateToBr(new Date().toISOString().slice(0, 10)));
  const [quantity, setQuantity] = useState('');
  const [eventValue, setEventValue] = useState('');
  const [notes, setNotes] = useState('');
  
  // New asset creation
  const [isNewAsset, setIsNewAsset] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [newClass, setNewClass] = useState('Ação');
  const [newMaturityDate, setNewMaturityDate] = useState('');

  // Bulk mode state
  const [bulkRows, setBulkRows] = useState([
    { id: 1, asset_id: assetId || '', event_type: 'Compra', date: eventDate, qty: '', val: '', notes: '' }
  ]);

  useEffect(() => {
    assetsApi.list().then(setAssetList).catch(console.error);
  }, []);

  const assetOptions = assetList.map((a) => ({
    value: a.id,
    label: `${a.current_ticker || `#${a.id}`} — ${a.name || a.asset_class}`
  }));

  const handleAddBulkRow = () => {
    setBulkRows([
      ...bulkRows,
      { id: Date.now(), asset_id: assetId || '', event_type: 'Compra', date: eventDate, qty: '', val: '', notes: '' }
    ]);
  };

  const updateBulkRow = (id, field, value) => {
    setBulkRows(bulkRows.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  const removeBulkRow = (id) => {
    if (bulkRows.length > 1) {
      setBulkRows(bulkRows.filter(r => r.id !== id));
    }
  };

  const normalize = (val, evType) => {
    if (VALUE_IGNORED.includes(evType)) return '0';
    return (val || '0').replace(',', '.');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setCreating(true);

    try {
      if (isBulkMode) {
        // Bulk submit
        const payload = bulkRows.map(r => {
          if (!r.asset_id) throw new Error("Todos os ativos devem ser selecionados.");
          const parsedDate = parseBrToDate(r.date);
          if (!parsedDate) throw new Error("Formato de data inválido. Use DD/MM/YYYY.");
          return {
            portfolio_id: activePortfolioId,
            asset_id: Number(r.asset_id),
            event_type: r.event_type,
            event_date: parsedDate,
            quantity: r.qty.replace(',', '.'),
            event_value: normalize(r.val, r.event_type),
            notes: r.notes || null,
          };
        });
        await eventsApi.bulkCreate({ events: payload });
      } else {
        // Single submit
        let targetAssetId = selectedAssetId;

        if (isNewAsset) {
          const parsedMaturity = parseBrToDate(newMaturityDate);
          const asset = await assetsApi.create({
            asset_class: newClass,
            ticker: newTicker,
            currency: ['Stock', 'REIT'].includes(newClass) ? 'USD' : 'BRL',
            maturity_date: CLASSES_WITH_MATURITY.includes(newClass) ? (parsedMaturity || null) : null,
          });
          targetAssetId = asset.id;
        }

        if (!targetAssetId) {
          throw new Error('Selecione um ativo.');
        }

        const parsedDate = parseBrToDate(eventDate);
        if (!parsedDate) throw new Error("Formato de data inválido. Use DD/MM/YYYY.");

        await eventsApi.create({
          portfolio_id: activePortfolioId,
          asset_id: Number(targetAssetId),
          event_type: eventType,
          event_date: parsedDate,
          quantity: quantity.replace(',', '.'),
          event_value: normalize(eventValue, eventType),
          notes: notes || null,
        });
      }

      onSuccess?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="flex justify-between items-center mb-16">
        <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Lançamento Manual</h3>
        {!isNewAsset && (
          <label className="flex items-center gap-8 cursor-pointer">
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Adição em massa</span>
            <div className="toggle">
              <input type="checkbox" checked={isBulkMode} onChange={(e) => setIsBulkMode(e.target.checked)} />
              <span className="toggle-slider"></span>
            </div>
          </label>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {isBulkMode ? (
        <div style={{ overflowX: 'auto', marginBottom: '16px' }}>
          <table style={{ minWidth: '800px' }}>
            <thead>
              <tr>
                {!assetId && <th style={{ width: '25%' }}>Ativo</th>}
                <th style={{ width: '15%' }}>Evento</th>
                <th style={{ width: '15%' }}>Data</th>
                <th style={{ width: '15%' }}>Qtd</th>
                <th style={{ width: '15%' }}>Valor</th>
                <th style={{ width: '10%' }}>Ação</th>
              </tr>
            </thead>
            <tbody>
              {bulkRows.map(row => (
                <tr key={row.id}>
                  {!assetId && (
                    <td>
                      <SearchableSelect 
                        options={assetOptions} 
                        value={row.asset_id} 
                        onChange={(val) => updateBulkRow(row.id, 'asset_id', val)} 
                      />
                    </td>
                  )}
                  <td>
                    <select className="form-select" style={{ width: '100%', padding: '6px' }} value={row.event_type} onChange={(e) => updateBulkRow(row.id, 'event_type', e.target.value)}>
                      {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td>
                    <input type="text" placeholder="DD/MM/YYYY" className="form-input" style={{ width: '100%', padding: '6px' }} value={row.date} onChange={(e) => updateBulkRow(row.id, 'date', handleDateMask(e.target.value))} required />
                  </td>
                  <td>
                    <input className="form-input" style={{ width: '100%', padding: '6px' }} placeholder="0,00" value={row.qty} onChange={(e) => updateBulkRow(row.id, 'qty', e.target.value)} required />
                  </td>
                  <td>
                    <input className="form-input" style={{ width: '100%', padding: '6px' }} placeholder="0,00" value={row.val} onChange={(e) => updateBulkRow(row.id, 'val', e.target.value)} disabled={VALUE_IGNORED.includes(row.event_type)} required={!VALUE_IGNORED.includes(row.event_type)} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm btn-danger btn-icon" onClick={() => removeBulkRow(row.id)} disabled={bulkRows.length === 1}>🗑️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-sm btn-secondary mt-8" onClick={handleAddBulkRow}>+ Adicionar Linha</button>
        </div>
      ) : (
        <>
          {/* Single Mode Asset Selection */}
          {!assetId && (
            <div className="form-group">
              <div className="flex items-center gap-12 mb-8">
                <label className="form-label" style={{ margin: 0 }}>Ativo</label>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => setIsNewAsset(!isNewAsset)}
                >
                  {isNewAsset ? '← Selecionar existente' : '+ Novo ativo'}
                </button>
              </div>

              {isNewAsset ? (
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Ticker</label>
                    <input className="form-input" value={newTicker} onChange={(e) => setNewTicker(e.target.value.toUpperCase())} placeholder="Ex: WEGE3" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Classe</label>
                    <select className="form-select" value={newClass} onChange={(e) => setNewClass(e.target.value)}>
                      {ASSET_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  {CLASSES_WITH_MATURITY.includes(newClass) && (
                    <div className="form-group">
                      <label className="form-label">Data de Vencimento</label>
                      <input type="text" placeholder="DD/MM/YYYY" className="form-input" value={newMaturityDate} onChange={(e) => setNewMaturityDate(handleDateMask(e.target.value))} required />
                    </div>
                  )}
                </div>
              ) : (
                <SearchableSelect options={assetOptions} value={selectedAssetId} onChange={setSelectedAssetId} />
              )}
            </div>
          )}

          {/* Event type */}
          <div className="form-group">
            <label className="form-label">Tipo de Evento</label>
            <select className="form-select" value={eventType} onChange={(e) => setEventType(e.target.value)}>
              {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          {/* Date, Quantity, Value */}
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Data</label>
              <input type="text" placeholder="DD/MM/YYYY" className="form-input" value={eventDate} onChange={(e) => setEventDate(handleDateMask(e.target.value))} required />
            </div>
            <div className="form-group">
              <label className="form-label">Quantidade</label>
              <input className="form-input" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0,00" required />
            </div>
            {!VALUE_IGNORED.includes(eventType) && (
              <div className="form-group">
                <label className="form-label">Valor Evento</label>
                <input className="form-input" value={eventValue} onChange={(e) => setEventValue(e.target.value)} placeholder="0,00" required />
              </div>
            )}
          </div>

          {/* Notes */}
          <div className="form-group">
            <label className="form-label">Observações</label>
            <input className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
          </div>
        </>
      )}

      {/* Actions */}
      <div className="modal-footer" style={{ border: 'none', padding: 0, marginTop: '16px' }}>
        {onCancel && (
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancelar</button>
        )}
        <button type="submit" className="btn btn-primary" disabled={creating}>
          {creating ? <><div className="spinner" /> Salvando...</> : 'Lançar Evento'}
        </button>
      </div>
    </form>
  );
}
