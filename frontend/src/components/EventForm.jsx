import { useState, useEffect, useContext } from 'react';
import { AppContext } from '../App';
import { events as eventsApi, assets as assetsApi } from '../api/client';
import { Plus, Trash2, ArrowLeft, Loader2, AlertTriangle, Check, ChevronsUpDown, CalendarIcon } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Calendar } from "@/components/ui/calendar";
import { DatePicker } from "@/components/ui/date-picker";
import { cn } from "@/lib/utils";
import { applyCurrencyMask, currencyToBackend, sanitizeQuantityInput } from '@/lib/formatters';

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

function AssetCombobox({ options, value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal bg-transparent h-9 px-3"
        >
          {selected ? (
            <span className="truncate flex items-center">
              <span className="font-medium mr-2">{selected.ticker}</span>
              <span className="text-muted-foreground/80">{selected.name}</span>
            </span>
          ) : <span className="text-muted-foreground">Buscar ativo...</span>}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] sm:w-[400px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Buscar por ticker, nome, cnpj, isin..." />
          <CommandList>
            <CommandEmpty>Nenhum ativo encontrado.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.ticker} ${option.name} ${option.cnpj || ''} ${option.isin || ''}`}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4 shrink-0",
                      value === option.value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="flex flex-col truncate">
                    <span className="font-medium">{option.ticker}</span>
                    <span className="text-xs text-muted-foreground/80 truncate">{option.name || option.asset_class}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}



export default function EventForm({ assetId, onSuccess, onCancel, onModeChange }) {
  const { activePortfolioId } = useContext(AppContext);
  const [assetList, setAssetList] = useState([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [bulkSameDate, setBulkSameDate] = useState(false);

  useEffect(() => {
    if (onModeChange) onModeChange(isBulkMode);
  }, [isBulkMode, onModeChange]);

  const today = new Date().toISOString().slice(0, 10);

  const [selectedAssetId, setSelectedAssetId] = useState(assetId || '');
  const [eventType, setEventType] = useState('Compra');
  const [eventDate, setEventDate] = useState(today);
  const [quantity, setQuantity] = useState('');
  const [eventValue, setEventValue] = useState('');
  const [notes, setNotes] = useState('');

  const [isNewAsset, setIsNewAsset] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [newClass, setNewClass] = useState('Ação');
  const [newMaturityDate, setNewMaturityDate] = useState('');

  const [bulkRows, setBulkRows] = useState([
    { id: 1, asset_id: assetId || '', event_type: 'Compra', date: today, qty: '', val: '', notes: '' }
  ]);

  useEffect(() => {
    assetsApi.list().then(setAssetList).catch(console.error);
  }, []);

  const assetOptions = assetList.map((a) => ({
    value: a.id,
    ticker: a.current_ticker || `#${a.id}`,
    name: a.name,
    asset_class: a.asset_class,
    cnpj: a.cnpj,
    isin: a.isin
  }));

  const getAssetClass = (id) => {
    if (!id) return '';
    const a = assetList.find(x => x.id === id);
    return a ? a.asset_class : '';
  };

  const handleAddBulkRow = () => {
    const defaultDate = bulkSameDate && bulkRows.length > 0 ? bulkRows[0].date : today;
    setBulkRows([
      ...bulkRows,
      { id: Date.now(), asset_id: assetId || '', event_type: 'Compra', date: defaultDate, qty: '', val: '', notes: '' }
    ]);
  };

  const updateBulkRow = (id, field, value) => {
    setBulkRows(prev => prev.map(r => {
      if (r.id === id) {
        return { ...r, [field]: value };
      }
      // Se alterou a data da primeira linha e "Única Data" está ativo, propaga
      if (bulkSameDate && field === 'date' && id === prev[0].id) {
        return { ...r, date: value };
      }
      return r;
    }));
  };

  useEffect(() => {
    if (bulkSameDate && bulkRows.length > 1) {
      const firstDate = bulkRows[0].date;
      setBulkRows(prev => prev.map(r => ({ ...r, date: firstDate })));
    }
  }, [bulkSameDate]);

  const removeBulkRow = (id) => {
    if (bulkRows.length > 1) {
      setBulkRows(bulkRows.filter(r => r.id !== id));
    }
  };

  const normalizeValue = (val, evType) => {
    if (VALUE_IGNORED.includes(evType)) return '0';
    return currencyToBackend(val);
  };

  const normalizeQuantity = (val) => {
    return val.replace(',', '.');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setCreating(true);

    try {
      if (isBulkMode) {
        const payload = bulkRows.map(r => {
          if (!r.asset_id) throw new Error("Todos os ativos devem ser selecionados.");
          if (!r.date) throw new Error("A data é obrigatória para todos os eventos.");
          return {
            portfolio_id: activePortfolioId,
            asset_id: Number(r.asset_id),
            event_type: r.event_type,
            event_date: r.date,
            quantity: normalizeQuantity(r.qty),
            event_value: normalizeValue(r.val, r.event_type),
            notes: r.notes || null,
          };
        });
        await eventsApi.bulkCreate({ events: payload });
      } else {
        let targetAssetId = selectedAssetId;

        if (isNewAsset) {
          const asset = await assetsApi.create({
            asset_class: newClass,
            ticker: newTicker,
            currency: ['Stock', 'REIT'].includes(newClass) ? 'USD' : 'BRL',
            maturity_date: CLASSES_WITH_MATURITY.includes(newClass) ? (newMaturityDate || null) : null,
          });
          targetAssetId = asset.id;
        }

        if (!targetAssetId) {
          throw new Error('Selecione um ativo.');
        }

        if (!eventDate) throw new Error("A data do evento é obrigatória.");

        await eventsApi.create({
          portfolio_id: activePortfolioId,
          asset_id: Number(targetAssetId),
          event_type: eventType,
          event_date: eventDate,
          quantity: normalizeQuantity(quantity),
          event_value: normalizeValue(eventValue, eventType),
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
    <form onSubmit={handleSubmit} className="space-y-5 w-full min-w-0">
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
          <div className="flex items-center justify-end gap-2 mb-2">
            <label htmlFor="same-date" className="text-xs font-medium text-muted-foreground cursor-pointer">
              Única Data
            </label>
            <Switch
              id="same-date"
              checked={bulkSameDate}
              onCheckedChange={setBulkSameDate}
            />
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  {!assetId && <TableHead className="min-w-[200px]">Ativo</TableHead>}
                  <TableHead className="min-w-[140px]">Evento</TableHead>
                  <TableHead className="min-w-[130px]">Data</TableHead>
                  <TableHead className="min-w-[100px]">Qtd</TableHead>
                  <TableHead className="min-w-[120px]">Valor (R$)</TableHead>
                  <TableHead className="w-14 text-center">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bulkRows.map((row, index) => (
                  <TableRow key={row.id}>
                    {!assetId && (
                      <TableCell className="p-2">
                        <AssetCombobox
                          options={assetOptions}
                          value={row.asset_id}
                          onChange={(val) => {
                            updateBulkRow(row.id, 'asset_id', val);
                            // Limpa a quantidade ao mudar o ativo, pois a regra de decimais pode ter mudado
                            updateBulkRow(row.id, 'qty', '');
                          }}
                        />
                      </TableCell>
                    )}
                    <TableCell className="p-2">
                      <Select value={row.event_type} onValueChange={(val) => updateBulkRow(row.id, 'event_type', val)}>
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {EVENT_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="p-2">
                      <DatePicker 
                        value={row.date} 
                        onChange={(val) => updateBulkRow(row.id, 'date', val)} 
                        disabled={bulkSameDate && index > 0} 
                      />
                    </TableCell>
                    <TableCell className="p-2">
                      <Input 
                        placeholder="0,00" 
                        value={row.qty} 
                        onChange={(e) => updateBulkRow(row.id, 'qty', sanitizeQuantityInput(e.target.value, getAssetClass(row.asset_id)))} 
                        required 
                      />
                    </TableCell>
                    <TableCell className="p-2">
                      <Input 
                        placeholder="0,00" 
                        value={row.val} 
                        onChange={(e) => updateBulkRow(row.id, 'val', applyCurrencyMask(e.target.value))} 
                        disabled={VALUE_IGNORED.includes(row.event_type)} 
                        required={!VALUE_IGNORED.includes(row.event_type)} 
                      />
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
                    <Select value={newClass} onValueChange={(val) => { setNewClass(val); setQuantity(''); }}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSET_CLASSES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {CLASSES_WITH_MATURITY.includes(newClass) && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground uppercase">Data de Vencimento</label>
                      <DatePicker value={newMaturityDate} onChange={setNewMaturityDate} />
                    </div>
                  )}
                </div>
              ) : (
                <AssetCombobox 
                  options={assetOptions} 
                  value={selectedAssetId} 
                  onChange={(val) => { setSelectedAssetId(val); setQuantity(''); }} 
                />
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tipo de Evento</label>
              <Select value={eventType} onValueChange={setEventType}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Data</label>
              <DatePicker value={eventDate} onChange={setEventDate} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Quantidade</label>
              <Input 
                value={quantity} 
                onChange={(e) => setQuantity(sanitizeQuantityInput(e.target.value, isNewAsset ? newClass : getAssetClass(selectedAssetId)))} 
                placeholder="0,00" 
                required 
              />
            </div>
            {!VALUE_IGNORED.includes(eventType) && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Valor Total do Evento</label>
                <Input 
                  value={eventValue} 
                  onChange={(e) => setEventValue(applyCurrencyMask(e.target.value))} 
                  placeholder="0,00" 
                  required 
                />
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
