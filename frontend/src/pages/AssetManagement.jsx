import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { assets as assetsApi } from '../api/client';
import { AlertTriangle, Check, ChevronsUpDown, ExternalLink, GitMerge, Loader2, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { formatMoney, formatQuantity } from '@/lib/formatters';

const ASSET_CLASSES = [
  'Ação', 'BDR', 'Criptomoeda', 'Debênture', 'CRI', 'CRA',
  'ETF', 'FII', 'FI-INFRA', 'Tesouro Direto', 'Stock', 'REIT',
];

function formatDate(value) {
  if (!value) return 'Desde sempre';
  const [y, m, d] = value.split('-');
  return `${d}/${m}/${y}`;
}

function parseCandidateIds(value) {
  try {
    return JSON.parse(value || '[]');
  } catch {
    return [];
  }
}

function parseOperationPayload(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function AssetCombobox({ options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.id.toString() === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="w-full min-w-0 justify-between font-normal bg-transparent">
          {selected ? (
            <span className="truncate">
              #{selected.id} · {selected.current_ticker || '-'} · {selected.asset_class} · {selected.market}
            </span>
          ) : <span className="text-muted-foreground">Buscar ativo destino...</span>}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] sm:w-[520px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Buscar por ticker, nome, classe ou id..." />
          <ScrollArea className="h-[300px]">
            <CommandList className="max-h-none overflow-visible">
            <CommandEmpty>Nenhum ativo encontrado.</CommandEmpty>
            <CommandGroup>
              {options.map((asset) => (
                <CommandItem
                  key={asset.id}
                  value={`${asset.id} ${asset.current_ticker || ''} ${asset.name || ''} ${asset.asset_class} ${asset.market}`}
                  onSelect={() => {
                    onChange(asset.id.toString());
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4 shrink-0', value === asset.id.toString() ? 'opacity-100' : 'opacity-0')} />
                  <div className="flex flex-col truncate">
                    <span className="font-medium">#{asset.id} · {asset.current_ticker || '-'}</span>
                    <span className="text-xs text-muted-foreground truncate">{asset.asset_class} · {asset.market} · {asset.name || 'Sem nome'}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            </CommandList>
          </ScrollArea>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function AssetManagement() {
  const [assetList, setAssetList] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('');
  const [includeMerged, setIncludeMerged] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [tickers, setTickers] = useState([]);
  const [tickerForm, setTickerForm] = useState({ ticker: '', valid_from: '' });
  const [mergeTargetId, setMergeTargetId] = useState('');
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [assets, pending] = await Promise.all([
        assetsApi.list(null, includeMerged),
        assetsApi.reviews(),
      ]);
      setAssetList(assets);
      setReviews(pending);
    } catch (err) {
      toast.error(err.message || 'Falha ao carregar Gestão de Ativos.');
    } finally {
      setLoading(false);
    }
  }, [includeMerged]);

  useEffect(() => {
    load();
  }, [load]);

  const openAsset = async (asset) => {
    setSelectedAsset(asset);
    setTickerForm({ ticker: '', valid_from: '' });
    setMergeTargetId('');
    try {
      setTickers(await assetsApi.tickers(asset.id));
    } catch (err) {
      toast.error(err.message || 'Falha ao carregar histórico de ticker.');
    }
  };

  const saveTicker = async () => {
    if (!tickerForm.ticker || !tickerForm.valid_from) {
      toast.error('Informe novo ticker e data inicial.');
      return;
    }
    try {
      const updated = await assetsApi.changeTicker(selectedAsset.id, tickerForm);
      toast.success('Troca de ticker registrada.');
      setSelectedAsset(updated);
      await load();
      setTickers(await assetsApi.tickers(updated.id));
      setTickerForm({ ticker: '', valid_from: '' });
    } catch (err) {
      toast.error(err.message || 'Falha ao registrar troca de ticker.');
    }
  };

  const mergeAsset = async () => {
    if (!mergeTargetId) {
      toast.error('Selecione o ativo destino.');
      return;
    }
    try {
      await assetsApi.merge({ source_asset_id: selectedAsset.id, target_asset_id: Number(mergeTargetId) });
      toast.success('Ativos mesclados.');
      setSelectedAsset(null);
      await load();
    } catch (err) {
      toast.error(err.message || 'Falha ao mesclar ativos.');
    }
  };

  const resolveReview = async (id) => {
    try {
      await assetsApi.resolveReview(id);
      toast.success('Revisão marcada como resolvida.');
      await load();
    } catch (err) {
      toast.error(err.message || 'Falha ao resolver revisão.');
    }
  };

  const createFromReview = async (id) => {
    try {
      const asset = await assetsApi.createFromReview(id);
      toast.success(`Ativo ${asset.current_ticker || `#${asset.id}`} criado.`);
      await load();
      await openAsset(asset);
    } catch (err) {
      toast.error(err.message || 'Falha ao criar ativo a partir da revisão.');
    }
  };

  const filtered = assetList.filter((asset) => {
    if (filterClass && asset.asset_class !== filterClass) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return [asset.current_ticker, asset.name, asset.cnpj, asset.isin, String(asset.id)]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  });

  const mergeOptions = assetList.filter((asset) => (
    selectedAsset &&
    asset.id !== selectedAsset.id &&
    !asset.merged_into_asset_id
  ));

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mb-3" />
        <span className="text-sm">Carregando ativos...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Gestão de Ativos</h2>
          <p className="text-muted-foreground text-sm mt-0.5">Cadastro global, revisões, tickers e mesclagem manual.</p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="include-merged" className="text-sm text-muted-foreground cursor-pointer font-normal">
            Exibir mesclados
          </Label>
          <Switch id="include-merged" checked={includeMerged} onCheckedChange={setIncludeMerged} />
        </div>
      </div>

      {reviews.length > 0 && (
        <Card className="border-amber-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="w-4 h-4 text-amber-500" /> Revisões Pendentes
            </CardTitle>
            <CardDescription>Casos ambíguos não foram criados nem mesclados automaticamente.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {reviews.map((review) => (
              <div key={review.id} className="flex flex-col gap-3 rounded-lg border p-3">
                <div className="text-sm">
                  <span className="font-medium">{review.ticker}</span> · {review.asset_class} · {review.market || 'mercado pendente'}
                  <p className="text-xs text-muted-foreground mt-1">{review.reason || 'Revisão manual necessária.'}</p>
                  {parseCandidateIds(review.candidate_asset_ids).length > 0 && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Candidato(s) existente(s): {parseCandidateIds(review.candidate_asset_ids).map((id) => `#${id}`).join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {parseCandidateIds(review.candidate_asset_ids).map((id) => (
                    <Button key={id} size="sm" variant="outline" onClick={() => navigate(`/assets/${id}`)}>
                      <ExternalLink className="w-4 h-4" /> Abrir #{id}
                    </Button>
                  ))}
                  {!parseOperationPayload(review.operation_payload) && (
                    <Button size="sm" variant="secondary" onClick={() => createFromReview(review.id)} disabled={!review.market}>
                      Criar mesmo assim
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => resolveReview(review.id)}>
                    <Check className="w-4 h-4" /> Descartar pendência
                  </Button>
                </div>
                {parseOperationPayload(review.operation_payload) && (
                  <div className="rounded-md border bg-muted/30">
                    <div className="border-b px-3 py-2 text-xs font-medium uppercase text-muted-foreground">Operação conflitante</div>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Classe</TableHead>
                            <TableHead>Evento</TableHead>
                            <TableHead>Data</TableHead>
                            <TableHead className="text-right">Quantidade</TableHead>
                            <TableHead className="text-right">Valor</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          <TableRow>
                            <TableCell><Badge variant="secondary">{parseOperationPayload(review.operation_payload).asset_class || review.asset_class}</Badge></TableCell>
                            <TableCell>{parseOperationPayload(review.operation_payload).event_type || '-'}</TableCell>
                            <TableCell>{formatDate(parseOperationPayload(review.operation_payload).event_date || review.event_date)}</TableCell>
                            <TableCell className="text-right">{formatQuantity(parseOperationPayload(review.operation_payload).quantity, parseOperationPayload(review.operation_payload).asset_class || review.asset_class)}</TableCell>
                            <TableCell className="text-right">R$ {formatMoney(parseOperationPayload(review.operation_payload).event_value)}</TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <CardTitle className="text-base">Ativos Registrados</CardTitle>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input className="pl-8 w-full md:w-[280px]" placeholder="Buscar ticker, nome ou id..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant={!filterClass ? 'default' : 'outline'} size="xs" onClick={() => setFilterClass('')}>Todos</Button>
            {ASSET_CLASSES.map((assetClass) => (
              <Button key={assetClass} variant={filterClass === assetClass ? 'default' : 'outline'} size="xs" onClick={() => setFilterClass(assetClass)}>
                {assetClass}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Ticker</TableHead>
                  <TableHead>Classe</TableHead>
                  <TableHead>Mercado</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((asset) => (
                  <TableRow key={asset.id} className="cursor-pointer" onClick={() => openAsset(asset)}>
                    <TableCell className="font-mono text-xs">#{asset.id}</TableCell>
                    <TableCell className="font-medium">{asset.current_ticker || '-'}</TableCell>
                    <TableCell><Badge variant="secondary">{asset.asset_class}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{asset.market}</TableCell>
                    <TableCell className="text-muted-foreground">{asset.name || '-'}</TableCell>
                    <TableCell>
                      {asset.merged_into_asset_id ? (
                        <Badge variant="outline">Mesclado em #{asset.merged_into_asset_id}</Badge>
                      ) : asset.duplicate_flag ? (
                        <Badge variant="outline" className="text-amber-600">Duplicidade</Badge>
                      ) : (
                        <span className="text-xs text-emerald-600">Ativo</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!selectedAsset} onOpenChange={(open) => !open && setSelectedAsset(null)}>
        <DialogContent className="sm:max-w-2xl">
          {selectedAsset && (
            <>
              <DialogHeader>
                <DialogTitle>{selectedAsset.current_ticker || `Ativo #${selectedAsset.id}`}</DialogTitle>
                <DialogDescription>{selectedAsset.asset_class} · {selectedAsset.market} · {selectedAsset.currency}</DialogDescription>
              </DialogHeader>

              <div className="space-y-5">
                <div className="rounded-lg border">
                  <div className="border-b px-3 py-2 text-sm font-medium">Histórico de Tickers</div>
                  <div className="divide-y">
                    {tickers.map((ticker) => (
                      <div key={ticker.id} className="flex items-center justify-between px-3 py-2 text-sm">
                        <span className="font-medium">{ticker.ticker}</span>
                        <span className="text-muted-foreground">{formatDate(ticker.valid_from)} até {ticker.valid_until ? formatDate(ticker.valid_until) : 'atual'}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {!selectedAsset.merged_into_asset_id && (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground uppercase">Novo ticker</Label>
                      <Input value={tickerForm.ticker} onChange={(e) => setTickerForm({ ...tickerForm, ticker: e.target.value.toUpperCase() })} placeholder="Ex: XPTO3" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground uppercase">Válido a partir de</Label>
                      <DatePicker value={tickerForm.valid_from} onChange={(value) => setTickerForm({ ...tickerForm, valid_from: value })} />
                    </div>
                    <div className="flex items-end">
                      <Button className="w-full" onClick={saveTicker}>Registrar troca</Button>
                    </div>
                  </div>
                )}

                {!selectedAsset.merged_into_asset_id && (
                  <div className="rounded-lg border p-3 space-y-3">
                    <div>
                      <h4 className="text-sm font-medium flex items-center gap-2"><GitMerge className="w-4 h-4" /> Mesclagem manual</h4>
                      <p className="text-xs text-muted-foreground mt-1">Move eventos deste ativo para o destino e preserva o id do destino.</p>
                    </div>
                    <div className="flex flex-col gap-2 md:flex-row md:items-center">
                      <div className="min-w-0 flex-1">
                        <AssetCombobox options={mergeOptions} value={mergeTargetId} onChange={setMergeTargetId} />
                      </div>
                      <Button variant="destructive" className="md:shrink-0" onClick={mergeAsset}>Mesclar</Button>
                    </div>
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => navigate(`/assets/${selectedAsset.id}`)}>Abrir detalhe</Button>
                <Button onClick={() => setSelectedAsset(null)}>Fechar</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
