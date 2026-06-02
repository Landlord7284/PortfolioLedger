import { useState, useEffect, useContext } from 'react';
import { AppContext } from '../App';
import { events as eventsApi, assets as assetsApi } from '../api/client';
import { Plus, Trash2, ArrowLeft, Loader2, AlertTriangle, Check, ChevronsUpDown } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { toast } from 'sonner';
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
const REIT_TYPE_UNSPECIFIED = '__reit_type_unspecified__';
const TREASURY_INDEXER_UNSPECIFIED = '__treasury_indexer_unspecified__';
const REIT_TYPE_OPTIONS = ['Equity', 'Mortgage', 'Hybrid'];
const TREASURY_INDEXER_OPTIONS = [
  { value: 'SELIC', label: 'SELIC' },
  { value: 'IPCA', label: 'IPCA' },
  { value: 'PREFIXED', label: 'Prefixado' },
];

const VALUE_IGNORED = ['Desdobramento', 'Grupamento'];

function AssetCombobox({ options, value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <Popover modal={true} open={open} onOpenChange={setOpen}>
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
          <CommandList className="max-h-[240px] overflow-y-auto overscroll-contain">
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
  const [grossValue, setGrossValue] = useState('');
  const [originUsd, setOriginUsd] = useState('');
  const [notes, setNotes] = useState('');

  const [isNewAsset, setIsNewAsset] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [newClass, setNewClass] = useState('Ação');
  const [newMarket, setNewMarket] = useState('BR');
  const [newMaturityDate, setNewMaturityDate] = useState('');
  const [newGicsSector, setNewGicsSector] = useState('');
  const [newGicsIndustryGroup, setNewGicsIndustryGroup] = useState('');
  const [newGicsIndustry, setNewGicsIndustry] = useState('');
  const [newGicsSubIndustry, setNewGicsSubIndustry] = useState('');
  const [newReitType, setNewReitType] = useState('');
  const [newTreasuryIndexer, setNewTreasuryIndexer] = useState('');

  const [bulkRows, setBulkRows] = useState([
    { id: 1, asset_id: assetId || '', event_type: 'Compra', date: today, qty: '', val: '', notes: '' }
  ]);

  useEffect(() => {
    assetsApi.list().then(setAssetList).catch((err) => {
      console.error(err);
      toast.error(err.message || 'Falha ao carregar lista de ativos.');
    });
  }, []);

  const assetOptions = assetList.map((a) => ({
    value: a.id,
    ticker: a.current_ticker || `#${a.id}`,
    name: a.name,
    asset_class: a.asset_class,
    market: a.market,
    currency: a.currency,
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
    if (!bulkSameDate) return;
    setBulkRows(prev => {
      if (prev.length <= 1) return prev;
      const firstDate = prev[0].date;
      return prev.map(r => ({ ...r, date: firstDate }));
    });
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

  const isPre2024Purchase = eventType === 'Compra' && eventDate && eventDate < '2024-01-01';
  const selectedAsset = assetList.find((a) => a.id === Number(selectedAssetId));
  const isUsdPurchaseAsset = isNewAsset
    ? newClass === 'Stock' || newClass === 'REIT' || (newClass === 'ETF' && newMarket === 'US')
    : selectedAsset?.currency === 'USD' || selectedAsset?.market === 'US';
  const showGicsFields = isNewAsset && ['Stock', 'REIT'].includes(newClass);
  const operationCurrencyLabel = isUsdPurchaseAsset ? 'US$' : 'R$';
  const showOriginUsd = isPre2024Purchase && isUsdPurchaseAsset;

  const grossValuePayload = (val, evType) => {
    if (evType !== 'Venda') return {};
    return { gross_value: currencyToBackend(val) };
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
        toast.success(`${payload.length} evento(s) lançado(s) com sucesso.`);
      } else {
        let targetAssetId = selectedAssetId;

        if (isNewAsset) {
          const asset = await assetsApi.create({
            asset_class: newClass,
            ticker: newTicker,
            market: newClass === 'ETF' ? newMarket : undefined,
            maturity_date: CLASSES_WITH_MATURITY.includes(newClass) ? (newMaturityDate || null) : null,
            ...(newClass === 'Tesouro Direto' ? { treasury_indexer: newTreasuryIndexer || null } : {}),
            ...(showGicsFields ? {
              gics_sector: newGicsSector || null,
              gics_industry_group: newGicsIndustryGroup || null,
              gics_industry: newGicsIndustry || null,
              gics_sub_industry: newGicsSubIndustry || null,
            } : {}),
            ...(newClass === 'REIT' ? { reit_type: newReitType || null } : {}),
            event_date: eventDate,
            portfolio_id: activePortfolioId,
            event_type: eventType,
            quantity: normalizeQuantity(quantity),
            event_value: normalizeValue(eventValue, eventType),
            origin_usd: showOriginUsd ? currencyToBackend(originUsd) : null,
            ...grossValuePayload(grossValue, eventType),
            notes: notes || null,
            source: 'event_form',
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
          origin_usd: showOriginUsd ? currencyToBackend(originUsd) : null,
          ...grossValuePayload(grossValue, eventType),
          notes: notes || null,
        });
        toast.success('Evento lançado com sucesso.');
      }

      onSuccess?.();
    } catch (err) {
      setError(err.message);
      toast.error(err.message || 'Falha ao lançar evento.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5 w-full min-w-0">
      {/* Mode toggle */}
      {!isNewAsset && (
        <div className="flex items-center justify-end gap-2">
          <Label htmlFor="bulk-mode" className="text-sm text-muted-foreground cursor-pointer font-normal">
            Adição em massa
          </Label>
          <Switch
            id="bulk-mode"
            checked={isBulkMode}
            onCheckedChange={setIsBulkMode}
          />
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {isBulkMode ? (
        <div className="space-y-3">
          <div className="flex items-center justify-end gap-2 mb-2">
            <Label htmlFor="same-date" className="text-xs font-medium text-muted-foreground cursor-pointer">
              Única Data
            </Label>
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
                  <TableHead className="min-w-[120px]">Valor (R$/US$)</TableHead>
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
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Ativo</Label>
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
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3 p-3 border border-border rounded-lg bg-muted/30">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground uppercase">Ticker</Label>
                    <Input value={newTicker} onChange={(e) => setNewTicker(e.target.value.toUpperCase())} placeholder="Ex: WEGE3" required />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground uppercase">Classe</Label>
                    <Select value={newClass} onValueChange={(val) => { setNewClass(val); setQuantity(''); }}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSET_CLASSES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {newClass === 'ETF' && (
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground uppercase">Mercado</Label>
                      <Select value={newMarket} onValueChange={setNewMarket}>
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="BR">BR</SelectItem>
                          <SelectItem value="US">US</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {newClass === 'Tesouro Direto' && (
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground uppercase">Indexador</Label>
                      <Select
                        value={newTreasuryIndexer || TREASURY_INDEXER_UNSPECIFIED}
                        onValueChange={(value) => setNewTreasuryIndexer(value === TREASURY_INDEXER_UNSPECIFIED ? '' : value)}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={TREASURY_INDEXER_UNSPECIFIED}>Indexador</SelectItem>
                          {TREASURY_INDEXER_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {CLASSES_WITH_MATURITY.includes(newClass) && (
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground uppercase">Data de Vencimento</Label>
                      <DatePicker value={newMaturityDate} onChange={setNewMaturityDate} />
                    </div>
                  )}
                  {newClass === 'REIT' && (
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground uppercase">REIT Type</Label>
                      <Select
                        value={newReitType || REIT_TYPE_UNSPECIFIED}
                        onValueChange={(value) => setNewReitType(value === REIT_TYPE_UNSPECIFIED ? '' : value)}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={REIT_TYPE_UNSPECIFIED}>Nao informado</SelectItem>
                          {REIT_TYPE_OPTIONS.map((type) => (
                            <SelectItem key={type} value={type}>{type}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {showGicsFields && (
                    <>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-muted-foreground uppercase">Sector</Label>
                        <Input value={newGicsSector} onChange={(e) => setNewGicsSector(e.target.value)} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-muted-foreground uppercase">Industry Group</Label>
                        <Input value={newGicsIndustryGroup} onChange={(e) => setNewGicsIndustryGroup(e.target.value)} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-muted-foreground uppercase">Industry</Label>
                        <Input value={newGicsIndustry} onChange={(e) => setNewGicsIndustry(e.target.value)} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-muted-foreground uppercase">Sub-Industry</Label>
                        <Input value={newGicsSubIndustry} onChange={(e) => setNewGicsSubIndustry(e.target.value)} />
                      </div>
                    </>
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
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tipo de Evento</Label>
              <Select value={eventType} onValueChange={(val) => {
                setEventType(val);
                if (val !== 'Venda') setGrossValue('');
                if (val !== 'Compra') setOriginUsd('');
              }}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Data</Label>
              <DatePicker value={eventDate} onChange={setEventDate} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Quantidade</Label>
              <Input 
                value={quantity} 
                onChange={(e) => setQuantity(sanitizeQuantityInput(e.target.value, isNewAsset ? newClass : getAssetClass(selectedAssetId)))} 
                placeholder="0,00" 
                required 
              />
            </div>
            {!VALUE_IGNORED.includes(eventType) && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Valor Líquido ({operationCurrencyLabel})</Label>
                  <Input 
                    value={eventValue} 
                    onChange={(e) => setEventValue(applyCurrencyMask(e.target.value))} 
                    placeholder="0,00" 
                    required 
                  />
                </div>
                {eventType === 'Venda' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Valor Bruto ({operationCurrencyLabel})</Label>
                    <Input 
                      value={grossValue} 
                      onChange={(e) => setGrossValue(applyCurrencyMask(e.target.value))} 
                      placeholder="0,00" 
                      required 
                    />
                  </div>
                )}
                {showOriginUsd && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Origem US</Label>
                    <Input
                      value={originUsd}
                      onChange={(e) => setOriginUsd(applyCurrencyMask(e.target.value))}
                      placeholder="0,00"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Observações (Opcional)</Label>
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
