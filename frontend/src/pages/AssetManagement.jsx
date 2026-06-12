import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../App';
import { assets as assetsApi, b3 as b3Api, schwab as schwabApi } from '../api/client';
import AssetMetadataCard, { buildAssetMetadataSuggestions, getMissingAssetMetadata } from '../components/AssetMetadataCard';
import { AlertCircle, AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, ChevronsUpDown, ExternalLink, GitMerge, Loader2, Search, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';
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

const COLLAPSED_STORAGE_PREFIX = 'assetManagement.collapsed.';

function readCollapsedGroups() {
  if (typeof window === 'undefined') return {};
  return ['reviews', 'b3IncomePendings', 'schwabAlerts', 'schwabReviews'].reduce((acc, key) => {
    acc[key] = window.localStorage.getItem(`${COLLAPSED_STORAGE_PREFIX}${key}`) === 'true';
    return acc;
  }, {});
}

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

function CollapsibleCardHeader({ icon, title, count, collapsed, onToggle, children }) {
  const ChevronIcon = collapsed ? ChevronRight : ChevronDown;

  return (
    <CardHeader>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {icon} {title}
            <Badge variant="secondary">{count}</Badge>
          </CardTitle>
          {!collapsed && children}
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onToggle} aria-label={collapsed ? `Expandir ${title}` : `Minimizar ${title}`}>
          <ChevronIcon className="h-4 w-4" />
        </Button>
      </div>
    </CardHeader>
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
  const [b3IncomePendings, setB3IncomePendings] = useState([]);
  const [assetAlerts, setAssetAlerts] = useState([]);
  const [schwabReviews, setSchwabReviews] = useState([]);
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
  const [sanitizeFiles, setSanitizeFiles] = useState([]);
  const [sanitizeFilesLoading, setSanitizeFilesLoading] = useState(false);
  const [selectedSanitizeMonths, setSelectedSanitizeMonths] = useState(new Set());
  const [expandedSanitizeYears, setExpandedSanitizeYears] = useState(new Set());
  const [sanitizeConfirmed, setSanitizeConfirmed] = useState(false);
  const [preserveManualResolutions, setPreserveManualResolutions] = useState(true);
  const [sanitizing, setSanitizing] = useState(false);
  const [selectedB3IncomePending, setSelectedB3IncomePending] = useState(null);
  const [b3IncomeAssetId, setB3IncomeAssetId] = useState('');
  const [resolvingB3Income, setResolvingB3Income] = useState(false);
  const [schwabAssetMap, setSchwabAssetMap] = useState({});
  const [collapsedGroups, setCollapsedGroups] = useState(readCollapsedGroups);
  const navigate = useNavigate();
  const searchInputRef = useRef(null);
  const activePortfolio = portfolioList.find((portfolio) => portfolio.id === activePortfolioId);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [assets, pending, b3Pending, alerts, schwabPending] = await Promise.all([
        assetsApi.list(null, includeMerged),
        assetsApi.reviews(),
        activePortfolioId ? b3Api.incomePendings({ portfolioId: activePortfolioId }) : Promise.resolve([]),
        assetsApi.alerts({ portfolioId: activePortfolioId }),
        schwabApi.reviews({ portfolioId: activePortfolioId }),
      ]);
      const b3IncomeReviewIds = new Set(b3Pending.map((item) => item.review_id).filter(Boolean));
      setAssetList(assets);
      setReviews(pending.filter((review) => !b3IncomeReviewIds.has(review.id)));
      setB3IncomePendings(b3Pending);
      setAssetAlerts(alerts);
      setSchwabReviews(schwabPending);
    } catch (err) {
      toast.error(err.message || 'Falha ao carregar Gestão de Ativos.');
    } finally {
      setLoading(false);
    }
  }, [activePortfolioId, includeMerged]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!sanitizeOpen || !activePortfolioId) return;

    let active = true;
    async function loadSanitizeFiles() {
      setSanitizeFilesLoading(true);
      try {
        const files = await b3Api.monthlyImportFiles({ portfolioId: activePortfolioId });
        if (!active) return;
        setSanitizeFiles(files);
        setExpandedSanitizeYears(files[0]?.reference_month ? new Set([files[0].reference_month.slice(0, 4)]) : new Set());
      } catch (err) {
        if (active) {
          setSanitizeFiles([]);
          toast.error(err.message || 'Falha ao carregar arquivos B3 importados.');
        }
      } finally {
        if (active) setSanitizeFilesLoading(false);
      }
    }

    loadSanitizeFiles();
    return () => {
      active = false;
    };
  }, [activePortfolioId, sanitizeOpen]);

  useEffect(() => {
    const handleGlobalKeyDown = (event) => {
      const target = event.target;
      const isEditing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable;

      if (
        event.key !== '/'
        || event.ctrlKey
        || event.metaKey
        || event.altKey
        || isEditing
        || selectedAsset
        || sanitizeOpen
      ) {
        return;
      }

      event.preventDefault();
      searchInputRef.current?.focus();
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [selectedAsset, sanitizeOpen]);

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

  const resolveAssetAlert = async (id) => {
    try {
      await assetsApi.resolveAlert(id);
      toast.success('Alerta marcado como resolvido.');
      await load();
    } catch (err) {
      toast.error(err.message || 'Falha ao resolver alerta.');
    }
  };

  const sanitizeB3Import = async () => {
    if (!activePortfolioId) {
      toast.error('Selecione uma carteira ativa.');
      return;
    }
    const months = [...selectedSanitizeMonths].sort();
    if (months.length === 0 || !sanitizeConfirmed) return;

    setSanitizing(true);
    try {
      const results = [];
      for (const referenceMonth of months) {
        const result = await b3Api.sanitizeMonthlyImport({
          portfolioId: activePortfolioId,
          referenceMonth,
          removeManualResolutions: !preserveManualResolutions,
        });
        results.push(result);
      }
      const totals = results.reduce((acc, result) => ({
        importsRemoved: acc.importsRemoved + result.imports_removed,
        marketPricesRemoved: acc.marketPricesRemoved + result.market_prices_removed,
        incomeEventsRemoved: acc.incomeEventsRemoved + result.income_events_removed,
        ledgerEventsCancelled: acc.ledgerEventsCancelled + result.ledger_events_cancelled,
        manualResolutionsRemoved: acc.manualResolutionsRemoved + (result.manual_resolutions_removed || 0),
      }), {
        importsRemoved: 0,
        marketPricesRemoved: 0,
        incomeEventsRemoved: 0,
        ledgerEventsCancelled: 0,
        manualResolutionsRemoved: 0,
      });
      toast.success(
        `Importacao B3 removida de ${months.length} mes(es): ${totals.importsRemoved} arquivo(s), ${totals.marketPricesRemoved} preco(s), ${totals.incomeEventsRemoved} provento(s), ${totals.ledgerEventsCancelled} evento(s) cancelado(s), ${totals.manualResolutionsRemoved} vinculo(s) manual(is) removido(s).`
      );
      setSanitizeOpen(false);
      setSanitizeFiles([]);
      setSelectedSanitizeMonths(new Set());
      setExpandedSanitizeYears(new Set());
      setSanitizeConfirmed(false);
      setPreserveManualResolutions(true);
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

  const openB3IncomeResolve = (pending) => {
    setSelectedB3IncomePending(pending);
    setB3IncomeAssetId('');
  };

  const discardB3IncomePending = async (pending) => {
    try {
      await b3Api.discardIncomePending(pending.id);
      toast.success('Pendência de provento B3 descartada.');
      await load();
    } catch (err) {
      toast.error(err.message || 'Falha ao descartar pendência B3.');
    }
  };

  const resolveB3IncomePending = async () => {
    if (!selectedB3IncomePending || !b3IncomeAssetId) {
      toast.error('Selecione o ativo destino.');
      return;
    }
    setResolvingB3Income(true);
    try {
      await b3Api.resolveIncomePending(selectedB3IncomePending.id, { asset_id: Number(b3IncomeAssetId) });
      toast.success('Provento B3 vinculado ao ativo.');
      setSelectedB3IncomePending(null);
      setB3IncomeAssetId('');
      await load();
    } catch (err) {
      toast.error(err.message || 'Falha ao resolver pendência B3.');
    } finally {
      setResolvingB3Income(false);
    }
  };

  const ignoreSchwabReview = async (id) => {
    try {
      await schwabApi.ignoreReview(id);
      toast.success('Transação Schwab/TDA ignorada.');
      await load();
    } catch (err) {
      toast.error(err.message || 'Falha ao ignorar revisão Schwab/TDA.');
    }
  };

  const confirmSchwabDuplicate = async (review) => {
    try {
      await schwabApi.confirmDuplicate(review.id, {
        ledger_event_id: review.duplicate_candidate_event_ids?.[0],
      });
      toast.success('Duplicidade Schwab/TDA confirmada.');
      await load();
    } catch (err) {
      toast.error(err.message || 'Falha ao confirmar duplicidade Schwab/TDA.');
    }
  };

  const acceptSchwabReview = async (review) => {
    const mappedAssetId = schwabAssetMap[review.id]?.trim();
    const assetId = mappedAssetId ? Number(mappedAssetId) : review.asset_id;
    if (!assetId) {
      toast.error('Informe o ativo antes de aceitar este evento.');
      return;
    }
    try {
      await schwabApi.acceptReview(review.id, { asset_id: assetId });
      toast.success('Evento Schwab/TDA importado no ledger.');
      setSchwabAssetMap((current) => ({ ...current, [review.id]: '' }));
      await load();
    } catch (err) {
      toast.error(err.message || 'Falha ao aceitar evento Schwab/TDA.');
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

  const globalSchwabReviews = schwabReviews.filter((review) => !(
    review.asset_id && review.duplicate_candidate_event_ids?.length > 0
  ));

  const metadataSuggestions = useMemo(() => buildAssetMetadataSuggestions(assetList), [assetList]);

  const sanitizeFilesByYear = useMemo(() => {
    const grouped = sanitizeFiles.reduce((acc, file) => {
      const year = file.reference_month.slice(0, 4);
      if (!acc[year]) acc[year] = [];
      acc[year].push(file);
      return acc;
    }, {});
    return Object.fromEntries(Object.entries(grouped).map(([fileYear, files]) => {
      const months = files.reduce((acc, file) => {
        if (!acc[file.reference_month]) {
          acc[file.reference_month] = {
            reference_month: file.reference_month,
            files: [],
          };
        }
        acc[file.reference_month].files.push(file);
        return acc;
      }, {});
      return [
        fileYear,
        Object.values(months).sort((left, right) => right.reference_month.localeCompare(left.reference_month)),
      ];
    }));
  }, [sanitizeFiles]);

  const selectedSanitizeMonthCount = selectedSanitizeMonths.size;

  const resetSanitizeDialog = () => {
    setSanitizeOpen(false);
    setSanitizeFiles([]);
    setSelectedSanitizeMonths(new Set());
    setExpandedSanitizeYears(new Set());
    setSanitizeConfirmed(false);
    setPreserveManualResolutions(true);
  };

  const toggleSanitizeMonth = (referenceMonth) => {
    setSelectedSanitizeMonths((current) => {
      const next = new Set(current);
      if (next.has(referenceMonth)) {
        next.delete(referenceMonth);
      } else {
        next.add(referenceMonth);
      }
      return next;
    });
    setSanitizeConfirmed(false);
  };

  const toggleSanitizeYear = (year) => {
    setExpandedSanitizeYears((current) => {
      const next = new Set(current);
      if (next.has(year)) {
        next.delete(year);
      } else {
        next.add(year);
      }
      return next;
    });
  };

  const mergeOptions = assetList.filter((asset) => (
    selectedAsset &&
    asset.id !== selectedAsset.id &&
    !asset.merged_into_asset_id
  ));

  const toggleCollapsedGroup = (key) => {
    setCollapsedGroups((current) => {
      const nextValue = !current[key];
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(`${COLLAPSED_STORAGE_PREFIX}${key}`, String(nextValue));
      }
      return { ...current, [key]: nextValue };
    });
  };

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
            <Input ref={searchInputRef} className="w-full pl-8 pr-12 sm:w-[280px]" placeholder="Buscar ticker, nome ou id..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
              <Kbd>/</Kbd>
            </div>
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
          <CollapsibleCardHeader
            icon={<AlertTriangle className="w-4 h-4 text-amber-500" />}
            title="Revisões Pendentes"
            count={reviews.length}
            collapsed={collapsedGroups.reviews}
            onToggle={() => toggleCollapsedGroup('reviews')}
          >
            <CardDescription>Casos ambíguos não foram criados nem mesclados automaticamente.</CardDescription>
          </CollapsibleCardHeader>
          {!collapsedGroups.reviews && <CardContent className="space-y-2">
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
          </CardContent>}
        </Card>
      )}

      {b3IncomePendings.length > 0 && (
        <Card className="border-emerald-500/30">
          <CollapsibleCardHeader
            icon={<AlertTriangle className="w-4 h-4 text-emerald-500" />}
            title="Proventos B3 Pendentes"
            count={b3IncomePendings.length}
            collapsed={collapsedGroups.b3IncomePendings}
            onToggle={() => toggleCollapsedGroup('b3IncomePendings')}
          >
            <CardDescription>Proventos importados da B3 com valor preservado, aguardando vínculo manual com um ativo real.</CardDescription>
          </CollapsibleCardHeader>
          {!collapsedGroups.b3IncomePendings && <CardContent className="space-y-2">
            {b3IncomePendings.map((pending) => (
              <div key={pending.id} className="flex flex-col gap-3 rounded-lg border p-3">
                <div className="flex flex-col gap-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{pending.ticker || 'Código pendente'}</span>
                    <Badge variant="secondary">{pending.event_type}</Badge>
                    <span className="text-muted-foreground">{formatDate(pending.payment_date)}</span>
                    <span className="font-medium">R$ {formatMoney(pending.net_value)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{pending.product || 'Produto B3 sem descrição.'}</p>
                  <p className="text-xs text-muted-foreground">
                    Origem: B3 {pending.reference_month} · {pending.filename} · linha {pending.source_row}
                    {pending.institution ? ` · ${pending.institution}` : ''}{pending.account ? ` / ${pending.account}` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">{pending.reason || 'Provento B3 nao resolvido com seguranca.'}</p>
                  {parseCandidateIds(pending.candidate_asset_ids).length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Candidato(s) existente(s): {parseCandidateIds(pending.candidate_asset_ids).map((id) => `#${id}`).join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => openB3IncomeResolve(pending)}>
                    <GitMerge className="w-4 h-4" /> Vincular ativo
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => discardB3IncomePending(pending)}>
                    <Check className="w-4 h-4" /> Descartar pendência
                  </Button>
                  {parseCandidateIds(pending.candidate_asset_ids).length > 0 && (
                    <>
                      {parseCandidateIds(pending.candidate_asset_ids).map((id) => (
                        <Button key={id} size="sm" variant="outline" onClick={() => navigate(`/assets/${id}`)}>
                          <ExternalLink className="w-4 h-4" /> Abrir #{id}
                        </Button>
                      ))}
                    </>
                  )}
                </div>
              </div>
            ))}
          </CardContent>}
        </Card>
      )}

      {assetAlerts.length > 0 && (
        <Card className="border-sky-500/30">
          <CollapsibleCardHeader
            icon={<AlertCircle className="w-4 h-4 text-sky-500" />}
            title="Alertas Schwab/TDA"
            count={assetAlerts.length}
            collapsed={collapsedGroups.schwabAlerts}
            onToggle={() => toggleCollapsedGroup('schwabAlerts')}
          >
            <CardDescription>Eventos societários importados que exigem revisão manual antes de afetar custo ou posição.</CardDescription>
          </CollapsibleCardHeader>
          {!collapsedGroups.schwabAlerts && <CardContent className="space-y-2">
            {assetAlerts.map((alert) => (
              <div key={alert.id} className="flex flex-col gap-3 rounded-lg border p-3">
                <div className="text-sm">
                  <span className="font-medium">{alert.ticker || 'Ticker pendente'}</span> · {alert.alert_type} · {formatDate(alert.event_date)}
                  <p className="text-xs text-muted-foreground mt-1">{alert.source_action || '-'}: {alert.source_description || '-'}</p>
                  {alert.quantity && (
                    <p className="text-xs text-muted-foreground mt-1">Quantidade informada: {formatQuantity(alert.quantity)}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">Origem: {alert.source} · transação #{alert.transaction_id || '-'}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {alert.asset_id && (
                    <Button size="sm" variant="outline" onClick={() => navigate(`/assets/${alert.asset_id}`)}>
                      <ExternalLink className="w-4 h-4" /> Abrir ativo #{alert.asset_id}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => resolveAssetAlert(alert.id)}>
                    <Check className="w-4 h-4" /> Marcar resolvido
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>}
        </Card>
      )}

      {globalSchwabReviews.length > 0 && (
        <Card className="border-amber-500/30">
          <CollapsibleCardHeader
            icon={<AlertTriangle className="w-4 h-4 text-amber-500" />}
            title="Revisões Schwab/TDA"
            count={globalSchwabReviews.length}
            collapsed={collapsedGroups.schwabReviews}
            onToggle={() => toggleCollapsedGroup('schwabReviews')}
          >
            <CardDescription>Transações importadas que podem duplicar eventos existentes ou precisam de decisão antes de afetar o ledger.</CardDescription>
          </CollapsibleCardHeader>
          {!collapsedGroups.schwabReviews && <CardContent className="flex flex-col gap-3">
            {globalSchwabReviews.map((review) => (
              <div key={review.id} className="flex flex-col gap-3 rounded-lg border p-3">
                <div className="flex flex-col gap-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">#{review.id} · {review.source_action || review.normalized_type || '-'}</span>
                    <Badge variant="secondary">{review.normalized_category}</Badge>
                    <span className="text-muted-foreground">{formatDate(review.event_date)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{review.review_reason || 'Revisão manual necessária.'}</p>
                  <p className="text-xs text-muted-foreground">
                    Origem: {review.filename || 'Schwab/TDA JSON'} · linha {review.source_row} · conta {review.account_key || 'UNKNOWN'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Importado: {review.source_symbol || review.current_ticker || '-'} · qtd {formatQuantity(review.quantity)} · valor US$ {formatMoney(review.amount)}
                  </p>
                  {review.asset_id && (
                    <p className="text-xs text-muted-foreground">Ativo resolvido: #{review.asset_id} · {review.current_ticker || '-'}</p>
                  )}
                </div>

                {review.candidate_events?.length > 0 && (
                  <div className="rounded-md border bg-muted/30">
                    <div className="border-b px-3 py-2 text-xs font-medium uppercase text-muted-foreground">Candidatos no ledger</div>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>ID</TableHead>
                            <TableHead>Evento</TableHead>
                            <TableHead>Data</TableHead>
                            <TableHead>Ticker</TableHead>
                            <TableHead className="text-right">Quantidade</TableHead>
                            <TableHead className="text-right">Valor</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {review.candidate_events.map((event) => (
                            <TableRow key={event.id}>
                              <TableCell className="font-mono text-xs">#{event.id}</TableCell>
                              <TableCell>{event.event_type}</TableCell>
                              <TableCell>{formatDate(event.event_date)}</TableCell>
                              <TableCell>{event.ticker || `#${event.asset_id}`}</TableCell>
                              <TableCell className="text-right">{formatQuantity(event.quantity)}</TableCell>
                              <TableCell className="text-right">{formatMoney(event.event_value)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`schwab-asset-${review.id}`} className="text-xs text-muted-foreground">Ativo #</Label>
                    <Input
                      id={`schwab-asset-${review.id}`}
                      className="h-8 w-28"
                      placeholder={review.asset_id ? String(review.asset_id) : 'ID'}
                      value={schwabAssetMap[review.id] || ''}
                      onChange={(event) => setSchwabAssetMap((current) => ({ ...current, [review.id]: event.target.value }))}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {review.asset_id && (
                      <Button size="sm" variant="outline" onClick={() => navigate(`/assets/${review.asset_id}`)}>
                        <ExternalLink className="w-4 h-4" /> Abrir ativo
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => ignoreSchwabReview(review.id)}>
                      Ignorar importado
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => confirmSchwabDuplicate(review)} disabled={!review.duplicate_candidate_event_ids?.length}>
                      Confirmar duplicado
                    </Button>
                    <Button size="sm" onClick={() => acceptSchwabReview(review)}>
                      Aceitar como novo
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>}
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

      <Dialog open={selectedB3IncomePending !== null} onOpenChange={(open) => {
        if (!open && !resolvingB3Income) {
          setSelectedB3IncomePending(null);
          setB3IncomeAssetId('');
        }
      }}>
        <DialogContent className="max-w-2xl">
          {selectedB3IncomePending && (
            <>
              <DialogHeader>
                <DialogTitle>Vincular provento B3 a ativo</DialogTitle>
                <DialogDescription>Confira os dados originais da B3 antes de confirmar o ativo econômico correto.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="rounded-lg border bg-muted/30 p-3">
                  <div className="grid gap-2 text-sm md:grid-cols-2">
                    <div><span className="text-xs uppercase text-muted-foreground">Produto B3</span><p className="font-medium">{selectedB3IncomePending.product || '-'}</p></div>
                    <div><span className="text-xs uppercase text-muted-foreground">Código/ticker</span><p className="font-medium">{selectedB3IncomePending.ticker || '-'}</p></div>
                    <div><span className="text-xs uppercase text-muted-foreground">Evento</span><p className="font-medium">{selectedB3IncomePending.event_type}</p></div>
                    <div><span className="text-xs uppercase text-muted-foreground">Pagamento</span><p className="font-medium">{formatDate(selectedB3IncomePending.payment_date)}</p></div>
                    <div><span className="text-xs uppercase text-muted-foreground">Valor importado</span><p className="font-medium">R$ {formatMoney(selectedB3IncomePending.net_value)}</p></div>
                    <div><span className="text-xs uppercase text-muted-foreground">Origem</span><p className="font-medium">{selectedB3IncomePending.reference_month} · linha {selectedB3IncomePending.source_row}</p></div>
                    <div><span className="text-xs uppercase text-muted-foreground">Instituição</span><p className="font-medium">{selectedB3IncomePending.institution || '-'}</p></div>
                    <div><span className="text-xs uppercase text-muted-foreground">Conta</span><p className="font-medium">{selectedB3IncomePending.account || '-'}</p></div>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Ativo destino</Label>
                  <AssetCombobox options={assetList.filter((asset) => !asset.merged_into_asset_id)} value={b3IncomeAssetId} onChange={setB3IncomeAssetId} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setSelectedB3IncomePending(null)} disabled={resolvingB3Income}>Cancelar</Button>
                <Button onClick={resolveB3IncomePending} disabled={resolvingB3Income || !b3IncomeAssetId}>
                  {resolvingB3Income ? <><Loader2 className="w-4 h-4 animate-spin" /> Vinculando...</> : <><Check className="w-4 h-4" /> Confirmar vínculo</>}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={sanitizeOpen} onOpenChange={(open) => {
        if (!open && !sanitizing) {
          resetSanitizeDialog();
        }
      }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sanitizar importacao B3</DialogTitle>
            <DialogDescription>
              Remove os dados B3 da carteira {activePortfolio?.name || 'ativa'} no mes informado e cancela eventos automaticos vinculados no ledger.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              Esta acao remove fisicamente os registros B3 do mes e cancela eventos automaticos desse import. Eventos manuais nao serao alterados.
            </div>
            <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="space-y-1">
                <Label htmlFor="preserve-manual-resolutions">Preservar vínculos manuais</Label>
                <p className="text-xs text-muted-foreground">Mantém decisões como HGLG13 → HGLG11 para reaplicar automaticamente em uma reimportação futura.</p>
              </div>
              <Switch id="preserve-manual-resolutions" checked={preserveManualResolutions} onCheckedChange={setPreserveManualResolutions} disabled={sanitizing} />
            </div>
            {!preserveManualResolutions && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                Os vínculos manuais resolvidos para este mês também serão removidos e precisarão ser refeitos se o arquivo for reimportado.
              </div>
            )}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Arquivos enviados</Label>
                <span className="text-xs text-muted-foreground">{selectedSanitizeMonthCount} mes(es) selecionado(s)</span>
              </div>
              <div className="max-h-[320px] overflow-y-auto rounded-lg border">
                {sanitizeFilesLoading ? (
                  <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Carregando arquivos...
                  </div>
                ) : sanitizeFiles.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    Nenhum arquivo B3 importado para esta carteira.
                  </div>
                ) : (
                  <div className="divide-y">
                    {Object.keys(sanitizeFilesByYear).sort((a, b) => b.localeCompare(a)).map((fileYear) => {
                      const yearMonths = sanitizeFilesByYear[fileYear];
                      const expanded = expandedSanitizeYears.has(fileYear);
                      const ChevronIcon = expanded ? ChevronDown : ChevronRight;
                      return (
                        <div key={fileYear}>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm font-medium hover:bg-muted/50"
                            onClick={() => toggleSanitizeYear(fileYear)}
                            disabled={sanitizing}
                          >
                            <span className="flex items-center gap-2">
                              <ChevronIcon className="h-4 w-4" />
                              {fileYear}
                            </span>
                            <span className="text-xs font-normal text-muted-foreground">{yearMonths.length} mes(es)</span>
                          </button>
                          {expanded && (
                            <div className="divide-y border-t bg-muted/20">
                              {yearMonths.map((monthItem) => {
                                const checked = selectedSanitizeMonths.has(monthItem.reference_month);
                                return (
                                  <label key={monthItem.reference_month} className="flex cursor-pointer items-start gap-3 px-4 py-2 text-sm hover:bg-muted/50">
                                    <Checkbox
                                      checked={checked}
                                      onCheckedChange={() => toggleSanitizeMonth(monthItem.reference_month)}
                                      disabled={sanitizing}
                                      className="mt-0.5"
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="font-mono font-medium">{monthItem.reference_month}</span>
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <label className="flex items-start gap-3 rounded-lg border border-destructive/30 p-3 text-sm">
              <Checkbox
                checked={sanitizeConfirmed}
                onCheckedChange={(checked) => setSanitizeConfirmed(checked === true)}
                disabled={sanitizing || selectedSanitizeMonthCount === 0}
                className="mt-0.5"
              />
              <span>
                Confirmo que quero remover os dados B3 dos {selectedSanitizeMonthCount || 0} mes(es) selecionado(s).
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSanitizeOpen(false)} disabled={sanitizing}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={sanitizeB3Import}
              disabled={sanitizing || selectedSanitizeMonthCount === 0 || !sanitizeConfirmed}
            >
              {sanitizing ? <><Loader2 className="w-4 h-4 animate-spin" /> Removendo...</> : <><Trash2 className="w-4 h-4" /> Remover selecionados</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
