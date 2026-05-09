import { useState, useEffect, useContext } from 'react';
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
import { Separator } from "@/components/ui/separator";

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

function formatDateToBr(isoStr) {
  if (!isoStr) return '';
  const [y, m, d] = isoStr.split('-');
  return `${d}/${m}/${y}`;
}

function parseBrToDate(brStr) {
  if (!brStr || brStr.length !== 10) return '';
  const [d, m, y] = brStr.split('/');
  return `${y}-${m}-${d}`;
}

function handleDateMask(value) {
  let v = value.replace(/\D/g, '');
  if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2);
  if (v.length > 5) v = v.slice(0, 5) + '/' + v.slice(5, 9);
  return v;
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
        maturity_date: formatDateToBr(asset.maturity_date) || '',
      });
    }
  }, [asset]);

  if (!asset) return null;

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === 'maturity_date') {
      setFormData({ ...formData, [name]: handleDateMask(value) });
    } else {
      setFormData({ ...formData, [name]: value });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = { ...formData };
      if (payload.maturity_date) {
        payload.maturity_date = parseBrToDate(payload.maturity_date);
      }
      await onSave(payload);
      setEditing(false);
    } catch (err) {
      alert(err.message);
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
    fields.push({ name: 'maturity_date', label: 'Vencimento', type: 'text', placeholder: 'DD/MM/YYYY' });
  } else if (c === 'ETF') {
    fields.push({ name: 'cnpj', label: 'CNPJ' });
    fields.push({ name: 'isin', label: 'Código ISIN' });
  } else if (['FII', 'FI-INFRA'].includes(c)) {
    fields.push({ name: 'cnpj', label: 'CNPJ' });
    fields.push({ name: 'segment', label: 'Segmento' });
  } else if (['Stock', 'REIT'].includes(c)) {
    fields.push({ name: 'isin', label: 'Código ISIN' });
  }

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
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancelar</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Salvar'}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {fields.map(f => (
            <div className="flex flex-col gap-1.5" key={f.name}>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{f.label}</label>
              {editing ? (
                <Input
                  className="h-8 text-sm"
                  type={f.type || 'text'}
                  name={f.name}
                  value={formData[f.name]}
                  onChange={handleChange}
                  placeholder={f.placeholder || ''}
                />
              ) : (
                <div className="text-sm font-medium py-1">
                  {f.name === 'maturity_date' && asset[f.name] ? formatDateToBr(asset[f.name]) : (asset[f.name] || '—')}
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
function CorrectionModal({ event, open, onClose, onSuccess }) {
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

  const selectClassName = "flex h-9 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

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
          {error && <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">{error}</div>}

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase">Tipo de Evento</label>
            <select className={selectClassName} value={eventType} onChange={(e) => setEventType(e.target.value)}>
              {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase">Data</label>
              <Input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase">Quantidade</label>
              <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase">Valor Total</label>
            <Input value={eventValue} onChange={(e) => setEventValue(e.target.value)} required />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase">Notas</label>
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
        await eventsApi.resolveDuplicate(eventId);
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
            <span className="text-sm text-muted-foreground font-medium">{asset.currency}</span>
          </div>
        </div>
        <Button onClick={() => setShowEventForm(true)}>
          <Plus className="w-4 h-4" /> Novo Evento
        </Button>
      </div>

      {error && (
        <div className="p-3 bg-destructive/10 text-destructive rounded-lg flex items-start gap-2 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
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
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Custo Total</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">R$ {displayMoney(position.total_cost)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Preço Médio</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">R$ {displayMoney(position.average_price)}</div>
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
                <Button variant="destructive" size="sm" onClick={handleBulkDelete}>
                  <Trash2 className="w-4 h-4" /> Excluir ({selectedEvents.size})
                </Button>
              </>
            )}
            {validEvents.length === 0 && eventList.length > 0 && (
               <Button variant="destructive" size="sm" onClick={handleDeleteAsset}>
                 <AlertCircle className="w-4 h-4" /> Excluir Ativo Completamente
               </Button>
            )}
            {eventList.length === 0 && (
               <Button variant="destructive" size="sm" onClick={handleDeleteAsset}>
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
                    <input
                      type="checkbox"
                      className="rounded"
                      onChange={(e) => setSelectedEvents(e.target.checked ? new Set(validEvents.map(ev => ev.id)) : new Set())}
                      checked={validEvents.length > 0 && selectedEvents.size === validEvents.length}
                    />
                  </TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead>Evento</TableHead>
                  <TableHead className="text-right">Quantidade</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead className="text-right">Resultado</TableHead>
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
                          <input
                            type="checkbox"
                            className="rounded"
                            checked={selectedEvents.has(ev.id)}
                            onChange={() => toggleSelect(ev.id)}
                          />
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">{formatDateToBr(ev.event_date)}</TableCell>
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
                      <TableCell className="text-right font-mono text-sm">{displayMoney(ev.event_value)}</TableCell>
                      <TableCell className={`text-right font-mono text-sm ${!hideValues && ev.realized_event_result && parseFloat(ev.realized_event_result) > 0 ? 'text-emerald-500' : !hideValues && ev.realized_event_result && parseFloat(ev.realized_event_result) < 0 ? 'text-red-500' : ''}`}>
                        {ev.realized_event_result ? displayMoney(ev.realized_event_result) : '—'}
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
                                <Button size="xs" onClick={() => handleResolveDuplicate(ev.id, true)}>
                                  <Check className="w-3 h-3" /> Confirmar
                                </Button>
                                <Button size="xs" variant="destructive" onClick={() => handleResolveDuplicate(ev.id, false)}>
                                  <X className="w-3 h-3" /> Ignorar
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button size="icon-sm" variant="ghost" onClick={() => setEditingEvent(ev)}>
                                  <Edit2 className="w-3.5 h-3.5" />
                                </Button>
                                <Button size="icon-sm" variant="ghost" className="text-destructive" onClick={() => handleDelete(ev.id)}>
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
          open={!!editingEvent}
          onClose={() => setEditingEvent(null)}
          onSuccess={() => { setEditingEvent(null); load(); }}
        />
      )}
    </div>
  );
}
