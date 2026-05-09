import { useState, useEffect, useContext, useRef } from 'react';
import { AppContext } from '../App';
import { events as eventsApi, assets as assetsApi } from '../api/client';
import { Plus, Trash2, ArrowLeft, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";

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

const selectClassName = "flex h-9 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

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
    <div className="relative w-full" ref={wrapperRef}>
      <Input
        value={displayValue}
        disabled={disabled}
        placeholder="Buscar ativo..."
        onFocus={() => { setOpen(true); setSearch(''); }}
        onChange={(e) => setSearch(e.target.value)}
      />
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-popover text-popover-foreground border border-border rounded-lg shadow-md ring-1 ring-foreground/10 z-50 max-h-60 overflow-y-auto">
          {filtered.length === 0 && <div className="p-3 text-sm text-muted-foreground text-center">Nenhum encontrado</div>}
          {filtered.map((o) => (
            <div
              key={o.value}
              className={`px-3 py-2 text-sm cursor-pointer transition-colors hover:bg-accent hover:text-accent-foreground ${o.value === value ? 'bg-accent' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(o.value);
                setOpen(false);
              }}
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

  const [selectedAssetId, setSelectedAssetId] = useState(assetId || '');
  const [eventType, setEventType] = useState('Compra');
  const [eventDate, setEventDate] = useState(formatDateToBr(new Date().toISOString().slice(0, 10)));
  const [quantity, setQuantity] = useState('');
  const [eventValue, setEventValue] = useState('');
  const [notes, setNotes] = useState('');

  const [isNewAsset, setIsNewAsset] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [newClass, setNewClass] = useState('Ação');
  const [newMaturityDate, setNewMaturityDate] = useState('');

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
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Mode toggle */}
      {!isNewAsset && (
        <div className="flex items-center justify-end gap-2">
          <label htmlFor="bulk-mode" className="text-sm text-muted-foreground cursor-pointer">
            Adição em massa
          </label>
          <Switch
            id="bulk-mode"
            checked={isBulkMode}
            onCheckedChange={setIsBulkMode}
          />
        </div>
      )}

      {error && (
        <div className="p-3 bg-destructive/10 text-destructive rounded-lg flex items-start gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {isBulkMode ? (
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  {!assetId && <TableHead className="min-w-[200px]">Ativo</TableHead>}
                  <TableHead className="min-w-[140px]">Evento</TableHead>
                  <TableHead className="min-w-[120px]">Data</TableHead>
                  <TableHead className="min-w-[100px]">Qtd</TableHead>
                  <TableHead className="min-w-[100px]">Valor</TableHead>
                  <TableHead className="w-14 text-center">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bulkRows.map(row => (
                  <TableRow key={row.id}>
                    {!assetId && (
                      <TableCell className="p-2">
                        <SearchableSelect
                          options={assetOptions}
                          value={row.asset_id}
                          onChange={(val) => updateBulkRow(row.id, 'asset_id', val)}
                        />
                      </TableCell>
                    )}
                    <TableCell className="p-2">
                      <select className={selectClassName} value={row.event_type} onChange={(e) => updateBulkRow(row.id, 'event_type', e.target.value)}>
                        {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </TableCell>
                    <TableCell className="p-2">
                      <Input type="text" placeholder="DD/MM/YYYY" value={row.date} onChange={(e) => updateBulkRow(row.id, 'date', handleDateMask(e.target.value))} required />
                    </TableCell>
                    <TableCell className="p-2">
                      <Input placeholder="0,00" value={row.qty} onChange={(e) => updateBulkRow(row.id, 'qty', e.target.value)} required />
                    </TableCell>
                    <TableCell className="p-2">
                      <Input placeholder="0,00" value={row.val} onChange={(e) => updateBulkRow(row.id, 'val', e.target.value)} disabled={VALUE_IGNORED.includes(row.event_type)} required={!VALUE_IGNORED.includes(row.event_type)} />
                    </TableCell>
                    <TableCell className="p-2 text-center">
                      <Button type="button" variant="ghost" size="icon-sm" className="text-destructive" onClick={() => removeBulkRow(row.id)} disabled={bulkRows.length === 1}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleAddBulkRow}>
            <Plus className="w-4 h-4" /> Adicionar Linha
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Asset Selection */}
          {!assetId && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Ativo</label>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => setIsNewAsset(!isNewAsset)}
                >
                  {isNewAsset ? <><ArrowLeft className="w-3 h-3" /> Selecionar existente</> : <><Plus className="w-3 h-3" /> Novo ativo</>}
                </Button>
              </div>

              {isNewAsset ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-3 border border-border rounded-lg bg-muted/30">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground uppercase">Ticker</label>
                    <Input value={newTicker} onChange={(e) => setNewTicker(e.target.value.toUpperCase())} placeholder="Ex: WEGE3" required />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground uppercase">Classe</label>
                    <select className={selectClassName} value={newClass} onChange={(e) => setNewClass(e.target.value)}>
                      {ASSET_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  {CLASSES_WITH_MATURITY.includes(newClass) && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground uppercase">Data de Vencimento</label>
                      <Input type="text" placeholder="DD/MM/YYYY" value={newMaturityDate} onChange={(e) => setNewMaturityDate(handleDateMask(e.target.value))} required />
                    </div>
                  )}
                </div>
              ) : (
                <SearchableSelect options={assetOptions} value={selectedAssetId} onChange={setSelectedAssetId} />
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tipo de Evento</label>
              <select className={selectClassName} value={eventType} onChange={(e) => setEventType(e.target.value)}>
                {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Data</label>
              <Input type="text" placeholder="DD/MM/YYYY" value={eventDate} onChange={(e) => setEventDate(handleDateMask(e.target.value))} required />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Quantidade</label>
              <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0,00" required />
            </div>
            {!VALUE_IGNORED.includes(eventType) && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Valor Total do Evento</label>
                <Input value={eventValue} onChange={(e) => setEventValue(e.target.value)} placeholder="0,00" required />
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Observações (Opcional)</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex: Referente a proventos..." />
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-4 border-t border-border">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>Cancelar</Button>
        )}
        <Button type="submit" disabled={creating}>
          {creating ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando...</> : 'Lançar Evento'}
        </Button>
      </div>
    </form>
  );
}
