import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../App';
import { assets as assetsApi, b3 as b3Api } from '../api/client';
import AssetMetadataCard, { buildAssetMetadataSuggestions, getMissingAssetMetadata } from '../components/AssetMetadataCard';
import { AlertCircle, AlertTriangle, ArrowDown, ArrowUp, Check, ChevronsUpDown, ExternalLink, GitMerge, Loader2, Search, Trash2 } from 'lucide-react';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { formatMoney, formatQuantity } from '@/lib/formatters';

const ASSET_CLASSES = [
  'Ação', 'BDR', 'Criptomoeda', 'Debênture', 'CRI', 'CRA',
  'ETF', 'FII', 'FI-INFRA', 'Tesouro Direto', 'Stock', 'REIT',
];

const STATUS_PRIORITY = {
  active: 1,
  incomplete: 2,
  duplicate: 3,
  merged: 4,
};

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

function getAssetStatusKey(asset) {
  if (asset.merged_into_asset_id) return 'merged';
  if (asset.duplicate_flag) return 'duplicate';
  if (getMissingAssetMetadata(asset).length > 0) return 'incomplete';
  return 'active';
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'pt-BR', { sensitivity: 'base' });
}

function compareAssets(a, b, key) {
  if (key === 'id') return a.id - b.id;
  if (key === 'ticker') return compareText(a.current_ticker, b.current_ticker);
  if (key === 'asset_class') return compareText(a.asset_class, b.asset_class);
  if (key === 'name') return compareText(a.name, b.name);
  if (key === 'status') {
    const priorityDiff = STATUS_PRIORITY[getAssetStatusKey(a)] - STATUS_PRIORITY[getAssetStatusKey(b)];
    return priorityDiff || compareText(a.current_ticker, b.current_ticker) || a.id - b.id;
  }
  return 0;
}

function SortableHead({ sortKey, sort, onSort, children }) {
  const active = sort.key === sortKey;
  const Icon = sort.direction === 'asc' ? ArrowUp : ArrowDown;

  return (
    <TableHead>
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => onSort(sortKey)}
      >
        {children}
        {active && <Icon className="ml-1 h-3.5 w-3.5" />}
      </Button>
    </TableHead>
  );
}

function MetadataGapIcon({ missingFields }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      {missingFields.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
          </TooltipTrigger>
          <TooltipContent>
            Cadastro incompleto: {missingFields.map((field) => field.label).join(', ')}
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
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
  const { activePortfolioId, portfolioList } = useContext(AppContext);
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
  const [sort, setSort] = useState({ key: 'id', direction: 'asc' });
  const [sanitizeOpen, setSanitizeOpen] = useState(false);
  const [sanitizeMonth, setSanitizeMonth] = useState('');
  const [sanitizeConfirm, setSanitizeConfirm] = useState('');
  const [sanitizing, setSanitizing] = useState(false);
  const navigate = useNavigate();
  const activePortfolio = portfolioList.find((portfolio) => portfolio.id === activePortfolioId);

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

  const saveAssetMetadata = async (data) => {
    const updated = await assetsApi.updateMetadata(selectedAsset.id, data);
    setSelectedAsset(updated);
    await load();
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

  const sanitizeB3Import = async () => {
    if (!activePortfolioId) {
      toast.error('Selecione uma carteira ativa.');
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(sanitizeMonth) || sanitizeConfirm !== sanitizeMonth) return;

    setSanitizing(true);
    try {
      const result = await b3Api.sanitizeMonthlyImport({
        portfolioId: activePortfolioId,
        referenceMonth: sanitizeMonth,
      });
      toast.success(
        `Importacao B3 ${result.reference_month} removida: ${result.imports_removed} arquivo(s), ${result.market_prices_removed} preco(s), ${result.income_events_removed} provento(s), ${result.ledger_events_cancelled} evento(s) cancelado(s).`
      );
      setSanitizeOpen(false);
      setSanitizeMonth('');
      setSanitizeConfirm('');
      await load();
    } catch (err) {
      toast.error(err.message || 'Falha ao sanitizar importacao B3.');
    } finally {
      setSanitizing(false);
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

  const handleSort = (key) => {
    setSort((current) => (
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    ));
  };

  const filtered = assetList.filter((asset) => {
    if (filterClass && asset.asset_class !== filterClass) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return [asset.current_ticker, asset.name, asset.cnpj, asset.isin, String(asset.id)]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  });

  const sortedAssets = useMemo(() => {
    return [...filtered]
      .map((asset, index) => ({ asset, index }))
      .sort((left, right) => {
        const direction = sort.direction === 'asc' ? 1 : -1;
        const result = compareAssets(left.asset, right.asset, sort.key);
        return result === 0 ? left.index - right.index : result * direction;
      })
      .map(({ asset }) => asset);
  }, [filtered, sort]);

  const metadataSuggestions = useMemo(() => buildAssetMetadataSuggestions(assetList), [assetList]);

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
        <div className="flex w-full flex-wrap items-center gap-3 md:w-auto md:justify-end">
          <div className="relative w-full sm:w-auto">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input className="pl-8 w-full sm:w-[280px]" placeholder="Buscar ticker, nome ou id..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setSanitizeOpen(true)}
            disabled={!activePortfolioId}
          >
            <Trash2 className="w-4 h-4" /> Sanitizar B3
          </Button>
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

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant={!filterClass ? 'default' : 'outline'} size="sm" className="text-sm" onClick={() => setFilterClass('')}>Todos</Button>
          {ASSET_CLASSES.map((assetClass) => (
            <Button key={assetClass} variant={filterClass === assetClass ? 'default' : 'outline'} size="sm" className="text-sm" onClick={() => setFilterClass(assetClass)}>
              {assetClass}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Label htmlFor="include-merged" className="text-sm text-muted-foreground cursor-pointer font-normal">
            Mesclados
          </Label>
          <Switch id="include-merged" checked={includeMerged} onCheckedChange={setIncludeMerged} />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="id" sort={sort} onSort={handleSort}>ID</SortableHead>
                  <SortableHead sortKey="ticker" sort={sort} onSort={handleSort}>Ticker</SortableHead>
                  <SortableHead sortKey="asset_class" sort={sort} onSort={handleSort}>Classe</SortableHead>
                  <TableHead>Mercado</TableHead>
                  <SortableHead sortKey="name" sort={sort} onSort={handleSort}>Nome</SortableHead>
                  <SortableHead sortKey="status" sort={sort} onSort={handleSort}>Status</SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedAssets.map((asset) => {
                  const missingFields = getMissingAssetMetadata(asset);
                  return (
                    <TableRow key={asset.id} className="cursor-pointer" onClick={() => openAsset(asset)}>
                      <TableCell className="font-mono text-xs">#{asset.id}</TableCell>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <MetadataGapIcon missingFields={missingFields} />
                          <span>{asset.current_ticker || '-'}</span>
                        </div>
                      </TableCell>
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
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!selectedAsset} onOpenChange={(open) => !open && setSelectedAsset(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          {selectedAsset && (
            <>
              <DialogHeader>
                <DialogTitle>{selectedAsset.current_ticker || `Ativo #${selectedAsset.id}`}</DialogTitle>
                <DialogDescription>{selectedAsset.asset_class} · {selectedAsset.market} · {selectedAsset.currency}</DialogDescription>
              </DialogHeader>

              <div className="space-y-5">
                <AssetMetadataCard asset={selectedAsset} onSave={saveAssetMetadata} metadataSuggestions={metadataSuggestions} />

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

      <Dialog open={sanitizeOpen} onOpenChange={(open) => {
        if (!open && !sanitizing) {
          setSanitizeOpen(false);
          setSanitizeMonth('');
          setSanitizeConfirm('');
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sanitizar importacao B3</DialogTitle>
            <DialogDescription>
              Remove os dados B3 da carteira {activePortfolio?.name || 'ativa'} no mes informado e cancela eventos automaticos vinculados no ledger.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              Esta acao remove fisicamente os registros B3 do mes. Eventos manuais nao serao alterados.
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sanitize-month">Mes da importacao</Label>
              <Input
                id="sanitize-month"
                value={sanitizeMonth}
                onChange={(event) => {
                  setSanitizeMonth(event.target.value);
                  setSanitizeConfirm('');
                }}
                placeholder="YYYY-MM"
                disabled={sanitizing}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sanitize-confirm">Digite {sanitizeMonth || 'YYYY-MM'} para confirmar</Label>
              <Input
                id="sanitize-confirm"
                value={sanitizeConfirm}
                onChange={(event) => setSanitizeConfirm(event.target.value)}
                placeholder={sanitizeMonth || 'YYYY-MM'}
                disabled={sanitizing || !/^\d{4}-\d{2}$/.test(sanitizeMonth)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSanitizeOpen(false)} disabled={sanitizing}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={sanitizeB3Import}
              disabled={sanitizing || !/^\d{4}-\d{2}$/.test(sanitizeMonth) || sanitizeConfirm !== sanitizeMonth}
            >
              {sanitizing ? <><Loader2 className="w-4 h-4 animate-spin" /> Removendo...</> : <><Trash2 className="w-4 h-4" /> Remover importacao</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
