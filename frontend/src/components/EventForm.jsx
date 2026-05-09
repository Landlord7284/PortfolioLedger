import { useState, useEffect, useContext } from 'react';
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

const VALUE_IGNORED = ['Desdobramento', 'Grupamento'];

export default function EventForm({ assetId, onSuccess, onCancel }) {
  const { activePortfolioId } = useContext(AppContext);
  const [assetList, setAssetList] = useState([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Form state
  const [selectedAssetId, setSelectedAssetId] = useState(assetId || '');
  const [eventType, setEventType] = useState('Compra');
  const [eventDate, setEventDate] = useState(new Date().toISOString().slice(0, 10));
  const [quantity, setQuantity] = useState('');
  const [eventValue, setEventValue] = useState('');
  const [notes, setNotes] = useState('');

  // New asset fields
  const [isNewAsset, setIsNewAsset] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [newClass, setNewClass] = useState('Ação');

  useEffect(() => {
    assetsApi.list().then(setAssetList).catch(console.error);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setCreating(true);

    try {
      let targetAssetId = selectedAssetId;

      // Create new asset if needed
      if (isNewAsset) {
        const asset = await assetsApi.create({
          asset_class: newClass,
          ticker: newTicker,
          currency: ['Stock', 'REIT'].includes(newClass) ? 'USD' : 'BRL',
        });
        targetAssetId = asset.id;
      }

      if (!targetAssetId) {
        setError('Selecione um ativo.');
        setCreating(false);
        return;
      }

      // Normalize values: replace comma with dot for backend
      const normalizedQty = quantity.replace(',', '.');
      const normalizedVal = VALUE_IGNORED.includes(eventType) ? '0' : eventValue.replace(',', '.');

      await eventsApi.create({
        portfolio_id: activePortfolioId,
        asset_id: Number(targetAssetId),
        event_type: eventType,
        event_date: eventDate,
        quantity: normalizedQty,
        event_value: normalizedVal,
        notes: notes || null,
      });

      onSuccess?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {error && <div className="alert alert-error">{error}</div>}

      {/* Asset selection */}
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
                <input
                  className="form-input"
                  value={newTicker}
                  onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
                  placeholder="Ex: WEGE3"
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Classe</label>
                <select
                  className="form-select"
                  value={newClass}
                  onChange={(e) => setNewClass(e.target.value)}
                >
                  {ASSET_CLASSES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <select
              className="form-select w-full"
              value={selectedAssetId}
              onChange={(e) => setSelectedAssetId(e.target.value)}
              required
            >
              <option value="">Selecione um ativo...</option>
              {assetList.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.current_ticker || `#${a.id}`} — {a.asset_class}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Event type */}
      <div className="form-group">
        <label className="form-label">Tipo de Evento</label>
        <select
          className="form-select"
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
        >
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      {/* Date, Quantity, Value */}
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Data</label>
          <input
            type="date"
            className="form-input"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label">Quantidade</label>
          <input
            className="form-input"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="0,00"
            required
          />
        </div>
        {!VALUE_IGNORED.includes(eventType) && (
          <div className="form-group">
            <label className="form-label">Valor Evento</label>
            <input
              className="form-input"
              value={eventValue}
              onChange={(e) => setEventValue(e.target.value)}
              placeholder="0,00"
              required
            />
          </div>
        )}
      </div>

      {/* Notes */}
      <div className="form-group">
        <label className="form-label">Observações</label>
        <input
          className="form-input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Opcional"
        />
      </div>

      {/* Actions */}
      <div className="modal-footer" style={{ border: 'none', padding: 0, marginTop: '16px' }}>
        {onCancel && (
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancelar
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={creating}>
          {creating ? <><div className="spinner" /> Salvando...</> : 'Lançar Evento'}
        </button>
      </div>
    </form>
  );
}
