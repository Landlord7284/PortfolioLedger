import { useState, useEffect, useContext, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AppContext } from '../App';
import { assets as assetsApi, events as eventsApi, positions as posApi } from '../api/client';
import EventForm from '../components/EventForm';
import { ArrowLeft, Edit2, Check, X, Plus, Trash2, AlertCircle, HelpCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from 'sonner';
import { applyCurrencyMask, currencyToBackend, sanitizeQuantityInput, formatMoney, formatQuantity } from '@/lib/formatters';

// Editable Metadata Component
function AssetMetadataCard({ asset, onSave }) {
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

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
      setSaveError('');
    }
  }, [asset]);

  if (!asset) return null;

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  const handleDateChange = (val) => {
    setFormData({ ...formData, maturity_date: val });
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await onSave({ ...formData });
      setEditing(false);
      toast.success('Informações cadastrais atualizadas.');
    } catch (err) {
      setSaveError(err.message);
      toast.error(err.message || 'Falha ao salvar informações cadastrais.');
    } finally {
      setSaving(false);
    }
  };

  const fields = [];
  const c = asset.asset_class;

  let nameLabel = 'Nome da Empresa/Emissor';
  if (['FII', 'FI-INFRA', 'ETF'].includes(c)) {
    nameLabel = 'Nome do Fundo';
  } else if (c === 'Tesouro Direto') {
    nameLabel = 'Nome do Título';
  }

  fields.push({ name: 'name', label: nameLabel });

  if (['Ação', 'BDR'].includes(c)) {
    fields.push({ name: 'cnpj', label: 'CNPJ' });
    fields.push({ name: 'sector', label: 'Setor' });
    fields.push({ name: 'subsector', label: 'Subsetor' });
    fields.push({ name: 'segment', label: 'Segmento' });
  } else if (['Debênture', 'CRI', 'CRA', 'Tesouro Direto'].includes(c)) {
    if (c !== 'Tesouro Direto') fields.push({ name: 'isin', label: 'Código ISIN' });
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

  const formatDisplayDate = (isoStr) => {
    if (!isoStr) return '—';
    const [y, m, d] = isoStr.split('-');
    return `${d}/${m}/${y}`;
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between border-b">
        <CardTitle className="text-base">Informações Cadastrais</CardTitle>
        {!editing ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Edit2 className="w-4 h-4" /> Editar
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setSaveError(''); }}>Cancelar</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Salvar'}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-4">
        {saveError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {fields.map(f => (
            <div className="flex flex-col gap-1.5" key={f.name}>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{f.label}</Label>
              {editing ? (
                f.type === 'date' ? (
                  <DatePicker value={formData[f.name]} onChange={handleDateChange} />
                ) : (
                  <Input
                    className="h-9 text-sm"
                    name={f.name}
                    value={formData[f.name]}
                    onChange={handleChange}
                    placeholder={f.placeholder || ''}
                  />
                )
              ) : (
                <div className="text-sm font-medium py-1 h-9 flex items-center">
                  {f.name === 'maturity_date' && asset[f.name] ? formatDisplayDate(asset[f.name]) : (asset[f.name] || '—')}
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Correction Modal using Dialog
function CorrectionModal({ event, assetClass, open, onClose, onSuccess }) {
  const EVENT_TYPES = [
    'Compra', 'Venda', 'Desdobramento', 'Grupamento',
    'Bonificação', 'Amortização', 'Cisão',
    'Resgate Antecipado', 'Resgate Vencimento',
  ];

  const VALUE_IGNORED = ['Desdobramento', 'Grupamento'];

  const [eventType, setEventType] = useState(event.event_type);
  const [eventDate, setEventDate] = useState(event.event_date);
  
  // Format the quantity to local format (replace dot with comma) if it comes with dot
  const initialQty = event.quantity ? event.quantity.replace('.', ',') : '';
  const initialVal = event.event_value ? event.event_value.replace('.', ',') : '';
  const initialGrossVal = event.gross_value ? event.gross_value.replace('.', ',') : '';
  
  const [quantity, setQuantity] = useState(initialQty);
  const [eventValue, setEventValue] = useState(initialVal);
  const [grossValue, setGrossValue] = useState(initialGrossVal);
  const [notes, setNotes] = useState(event.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const normalizeValue = (val, evType) => {
    if (VALUE_IGNORED.includes(evType)) return '0';
    return currencyToBackend(val) || '0';
  };

  const grossValuePayload = (val, evType) => {
    if (evType !== 'Venda') return {};
    return { gross_value: currencyToBackend(val) };
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await eventsApi.correct(event.id, {
        event_type: eventType,
        event_date: eventDate,
        quantity: quantity.replace(',', '.'),
        event_value: normalizeValue(eventValue, eventType),
        ...grossValuePayload(grossValue, eventType),
        notes: notes || null,
      });
      toast.success('Evento corrigido com sucesso.');
      onSuccess();
    } catch (err) {
      setError(err.message);
      toast.error(err.message || 'Falha ao corrigir evento.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Corrigir Evento #{event.id}</DialogTitle>
          <DialogDescription>
            A edição cria automaticamente um estorno do evento original e lança o evento corrigido.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase">Tipo de Evento</Label>
            <Select value={eventType} onValueChange={setEventType}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVENT_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase">Data</Label>
              <DatePicker value={eventDate} onChange={setEventDate} />
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase">Quantidade</Label>
              <Input 
                value={quantity} 
                onChange={(e) => setQuantity(sanitizeQuantityInput(e.target.value, assetClass))} 
                required 
              />
            </div>
          </div>

          {!VALUE_IGNORED.includes(eventType) && (
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase">Valor Op. Líquido</Label>
              <Input 
                value={eventValue} 
                onChange={(e) => setEventValue(applyCurrencyMask(e.target.value))} 
                required 
              />
            </div>
          )}

          {eventType === 'Venda' && (
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase">Valor Op. Bruto</Label>
              <Input
                value={grossValue}
                onChange={(e) => setGrossValue(applyCurrencyMask(e.target.value))}
                required
              />
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase">Notas (Opcional)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Salvar Correção'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

  // Alert Dialog State
  const [alertTarget, setAlertTarget] = useState(null); // { type, payload, title, desc, actionLabel, actionFn, variant }

  const load = useCallback(async () => {
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
      toast.error(err.message || 'Falha ao carregar dados do ativo.');
    } finally {
      setLoading(false);
    }
  }, [activePortfolioId, assetId]);

  useEffect(() => {
    if (activePortfolioId) load();
  }, [activePortfolioId, load]);

  const displayError = (msg) => {
    setError(msg);
    toast.error(msg);
    setTimeout(() => setError(''), 5000);
  };

  const executeAlertAction = async () => {
    if (!alertTarget || !alertTarget.actionFn) return;
    setError('');
    try {
      await alertTarget.actionFn(alertTarget.payload);
      if (alertTarget.type === 'asset-delete') {
        toast.success('Ativo excluído com sucesso.');
      } else if (alertTarget.type === 'bulk-delete') {
        toast.success(`${selectedEvents.size} evento(s) excluído(s).`);
      } else if (alertTarget.type === 'individual-delete') {
        toast.success('Evento excluído com sucesso.');
      } else if (alertTarget.type === 'duplicate') {
        toast.success(alertTarget.payload.confirm ? 'Evento duplicado confirmado como válido.' : 'Evento duplicado excluído.');
      }

      if (alertTarget.type === 'asset-delete') {
        navigate('/');
      } else {
        if (alertTarget.type === 'bulk-delete') {
          setSelectedEvents(new Set());
        }
        load();
      }
    } catch (err) {
      displayError(err.message);
    } finally {
      setAlertTarget(null);
    }
  };

  const confirmDelete = (eventId) => {
    setAlertTarget({
      type: 'individual-delete',
      payload: eventId,
      title: 'Excluir evento',
      desc: 'Tem certeza que deseja excluir este evento? Esta ação criará um cancelamento lógico.',
      actionLabel: 'Excluir',
      variant: 'destructive',
      actionFn: (id) => eventsApi.delete(id)
    });
  };

  const confirmBulkDelete = () => {
    setAlertTarget({
      type: 'bulk-delete',
      payload: Array.from(selectedEvents),
      title: 'Excluir eventos em lote',
      desc: `Confirma a exclusão de ${selectedEvents.size} evento(s) selecionado(s)?`,
      actionLabel: 'Excluir',
      variant: 'destructive',
      actionFn: (ids) => eventsApi.bulkDelete(ids)
    });
  };

  const confirmDeleteAsset = () => {
    setAlertTarget({
      type: 'asset-delete',
      payload: asset.id,
      title: 'Excluir Ativo Completamente',
      desc: `Tem certeza que deseja excluir completamente o ativo ${asset.current_ticker} do banco de dados? Isso apagará todos os registros vinculados.`,
      actionLabel: 'Excluir Completamente',
      variant: 'destructive',
      actionFn: (id) => assetsApi.delete(id)
    });
  };

  const confirmResolveDuplicate = (eventId, confirm) => {
    setAlertTarget({
      type: 'duplicate',
      payload: { eventId, confirm },
      title: confirm ? 'Confirmar Evento Válido' : 'Excluir Evento Duplicado',
      desc: confirm 
        ? 'Ao confirmar, este evento será marcado como válido e o alerta será removido.' 
        : 'Tem certeza que deseja excluir este evento considerado duplicado?',
      actionLabel: confirm ? 'Confirmar Evento' : 'Excluir',
      variant: confirm ? 'default' : 'destructive',
      actionFn: async ({ eventId, confirm }) => {
        if (confirm) {
          await eventsApi.resolveDuplicate(eventId);
        } else {
          await eventsApi.resolveDuplicate(eventId);
          await eventsApi.delete(eventId);
        }
      }
    });
  };

  const toggleSelect = (id) => {
    const next = new Set(selectedEvents);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedEvents(next);
  };

  const displayMoney = (val) => formatMoney(val, hideValues);
  const displayQuantity = (val) => formatQuantity(val, asset?.asset_class, hideValues);
  const isUsAsset = asset?.market === 'US' || asset?.currency === 'USD';
  const operationMoneyPrefix = isUsAsset ? 'US$' : 'R$';

  const formatDisplayDate = (isoStr) => {
    if (!isoStr) return '';
    const [y, m, d] = isoStr.split('-');
    return `${d}/${m}/${y}`;
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mb-3" />
        <span className="text-sm">Carregando ativo...</span>
      </div>
    );
  }

  if (!asset) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <HelpCircle className="w-12 h-12 text-muted-foreground/30 mb-4" />
        <h3 className="text-lg font-semibold mb-2">Ativo não encontrado</h3>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/')}>
          <ArrowLeft className="w-4 h-4" /> Voltar ao Dashboard
        </Button>
      </div>
    );
  }

  const validEvents = eventList.filter(ev => !ev.is_cancelled && !ev.is_storno);
  const orderedEventList = [...eventList].reverse();

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => navigate('/')}>
        <ArrowLeft className="w-4 h-4" /> Voltar
      </Button>

      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-3">
            {asset.current_ticker || `Ativo #${asset.id}`}
            {asset.duplicate_flag && (
              <Badge variant="outline" className="text-xs gap-1">
                <AlertCircle className="w-3 h-3" /> Duplicado detectado
              </Badge>
            )}
          </h2>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="secondary">{asset.asset_class}</Badge>
            <span className="text-sm text-muted-foreground font-medium">{asset.market}</span>
            <span className="text-sm text-muted-foreground font-medium">{asset.currency}</span>
          </div>
        </div>
        <Button onClick={() => setShowEventForm(true)}>
          <Plus className="w-4 h-4" /> Novo Evento
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className="transition-all">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <AssetMetadataCard
        asset={asset}
        onSave={(data) => assetsApi.updateMetadata(asset.id, data).then(setAsset)}
      />

      {position && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Quantidade</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{displayQuantity(position.quantity)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Custo Total (BRL)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">R$ {displayMoney(position.total_cost)}</div>
              {isUsAsset && position.total_cost_original && (
                <div className="mt-1 text-xs font-mono text-muted-foreground">US$ {displayMoney(position.total_cost_original)}</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Preço Médio (BRL)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">R$ {displayMoney(position.average_price)}</div>
              {isUsAsset && position.average_price_original && (
                <div className="mt-1 text-xs font-mono text-muted-foreground">US$ {displayMoney(position.average_price_original)}</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Resultado Realizado</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold font-mono ${!hideValues && parseFloat(position.realized_result) >= 0 ? 'text-emerald-500' : !hideValues ? 'text-red-500' : ''}`}>
                R$ {displayMoney(position.realized_result)}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between border-b">
          <div>
            <CardTitle>Histórico de Eventos (Ledger)</CardTitle>
            <CardDescription>{eventList.length} evento(s) registrado(s)</CardDescription>
          </div>
          <div className="flex gap-2 items-center">
            {selectedEvents.size > 0 && (
              <>
                <Button variant="outline" size="sm" onClick={() => setSelectedEvents(new Set())}>
                  Limpar Seleção
                </Button>
                <Button variant="destructive" size="sm" onClick={confirmBulkDelete}>
                  <Trash2 className="w-4 h-4" /> Excluir ({selectedEvents.size})
                </Button>
              </>
            )}
            {validEvents.length === 0 && eventList.length > 0 && (
               <Button variant="destructive" size="sm" onClick={confirmDeleteAsset}>
                 <AlertCircle className="w-4 h-4" /> Excluir Ativo Completamente
               </Button>
            )}
            {eventList.length === 0 && (
               <Button variant="destructive" size="sm" onClick={confirmDeleteAsset}>
                 <AlertCircle className="w-4 h-4" /> Excluir Ativo
               </Button>
            )}
          </div>
        </CardHeader>

        {eventList.length === 0 ? (
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-muted-foreground text-sm">Nenhum evento registrado para este ativo nesta carteira.</p>
          </CardContent>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-center">
                    <Checkbox
                      aria-label="Selecionar todos os eventos"
                      className="mx-auto"
                      onCheckedChange={(checked) => setSelectedEvents(checked === true ? new Set(validEvents.map(ev => ev.id)) : new Set())}
                      checked={validEvents.length > 0 && selectedEvents.size === validEvents.length}
                    />
                  </TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead>Evento</TableHead>
                  <TableHead className="text-right">Quantidade</TableHead>
                  <TableHead className="text-right">Valor Op. Líq</TableHead>
                  <TableHead className="text-right">Valor Op. Bruto</TableHead>
                  <TableHead className="text-right">Preço Un.</TableHead>
                  <TableHead className="text-right">Resultado</TableHead>
                  <TableHead className="text-right">Qtd. Total</TableHead>
                  {isUsAsset && <TableHead className="text-right">Total US$</TableHead>}
                  <TableHead className="text-right">{isUsAsset ? 'Total R$' : 'Custo Acum.'}</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orderedEventList.map((ev) => {
                  const isCancelled = ev.is_cancelled;
                  const isStorno = ev.is_storno;
                  const isInteractive = !isCancelled && !isStorno;

                  return (
                    <TableRow key={ev.id} className={!isInteractive ? 'opacity-50' : ''}>
                      <TableCell className="text-center">
                        {isInteractive && (
                          <Checkbox
                            aria-label={`Selecionar evento ${ev.id}`}
                            className="mx-auto"
                            checked={selectedEvents.has(ev.id)}
                            onCheckedChange={() => toggleSelect(ev.id)}
                          />
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">{formatDisplayDate(ev.event_date)}</TableCell>
                      <TableCell>
                        {isCancelled ? (
                          <Badge variant="destructive" className="line-through">{ev.event_type}</Badge>
                        ) : isStorno ? (
                          <Badge variant="outline">⤺ Estorno</Badge>
                        ) : (
                          <Badge variant="secondary">
                            {ev.duplicate_flag && "⚠️ "}
                            {ev.event_type}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{displayQuantity(ev.quantity)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{operationMoneyPrefix} {displayMoney(ev.event_value)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {ev.gross_value ? `${operationMoneyPrefix} ${displayMoney(ev.gross_value)}` : '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {ev.unit_price ? `${operationMoneyPrefix} ${displayMoney(ev.unit_price)}` : '—'}
                      </TableCell>
                      <TableCell className={`text-right font-mono text-sm ${!hideValues && ev.realized_event_result && parseFloat(ev.realized_event_result) > 0 ? 'text-emerald-500' : !hideValues && ev.realized_event_result && parseFloat(ev.realized_event_result) < 0 ? 'text-red-500' : ''}`}>
                        {ev.realized_event_result ? `R$ ${displayMoney(ev.realized_event_result)}` : '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {ev.running_quantity ? displayQuantity(ev.running_quantity) : '—'}
                      </TableCell>
                      {isUsAsset && (
                        <TableCell className="text-right font-mono text-sm">
                          {ev.running_total_cost_original ? `US$ ${displayMoney(ev.running_total_cost_original)}` : '—'}
                        </TableCell>
                      )}
                      <TableCell className="text-right font-mono text-sm">
                        {ev.running_total_cost ? `R$ ${displayMoney(ev.running_total_cost)}` : '—'}
                      </TableCell>
                      <TableCell>
                        {isCancelled && <span className="text-destructive text-xs font-medium">Cancelado</span>}
                        {isStorno && <span className="text-muted-foreground text-xs font-medium">Ref: #{ev.storno_of}</span>}
                        {ev.correction_of && <span className="text-muted-foreground text-xs font-medium">Corr: #{ev.correction_of}</span>}
                        {!isCancelled && !isStorno && !ev.correction_of && <span className="text-emerald-500 text-xs font-medium">Ativo</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        {isInteractive && (
                          <div className="flex justify-end gap-1">
                            {ev.duplicate_flag ? (
                              <>
                                <Button size="xs" onClick={() => confirmResolveDuplicate(ev.id, true)}>
                                  <Check className="w-3 h-3" /> Confirmar
                                </Button>
                                <Button size="xs" variant="destructive" onClick={() => confirmResolveDuplicate(ev.id, false)}>
                                  <X className="w-3 h-3" /> Ignorar
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button size="icon-sm" variant="ghost" onClick={() => setEditingEvent(ev)}>
                                  <Edit2 className="w-3.5 h-3.5" />
                                </Button>
                                <Button size="icon-sm" variant="ghost" className="text-destructive" onClick={() => confirmDelete(ev.id)}>
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              </>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Event form dialog */}
      <Dialog open={showEventForm} onOpenChange={setShowEventForm}>
        <DialogContent className={isLargeModal ? 'sm:max-w-3xl' : 'sm:max-w-xl'}>
          <DialogHeader>
            <DialogTitle>Novo Evento — {asset.current_ticker}</DialogTitle>
          </DialogHeader>
          <EventForm
            assetId={Number(assetId)}
            onSuccess={() => { setShowEventForm(false); load(); }}
            onCancel={() => setShowEventForm(false)}
            onModeChange={setIsLargeModal}
          />
        </DialogContent>
      </Dialog>

      {/* Correction dialog */}
      {editingEvent && (
        <CorrectionModal
          event={editingEvent}
          assetClass={asset.asset_class}
          open={!!editingEvent}
          onClose={() => setEditingEvent(null)}
          onSuccess={() => { setEditingEvent(null); load(); }}
        />
      )}

      {/* Global Alert Dialog */}
      <AlertDialog open={!!alertTarget} onOpenChange={(open) => !open && setAlertTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{alertTarget?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {alertTarget?.desc}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={executeAlertAction} className={alertTarget?.variant === 'destructive' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}>
              {alertTarget?.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
