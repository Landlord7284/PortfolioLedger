import { useState, useEffect, useContext, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, XAxis, YAxis } from 'recharts';
import { AppContext } from '../App';
import { dashboard as dashboardApi, positions as posApi } from '../api/client';
import EventForm from '../components/EventForm';
import B3MonthlyImportModal from '../components/B3MonthlyImportModal';
import ImportModal from '../components/ImportModal';
import SchwabImportModal from '../components/SchwabImportModal';
import { Search, Plus, Download, FolderOpen, Inbox, AlertCircle, Loader2, ArrowDown, ArrowUp, AlertTriangle, Info, ChevronDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChartContainer, ChartTooltip } from '@/components/ui/chart';
import { Kbd } from '@/components/ui/kbd';
import { toast } from 'sonner';
import { formatMoney, formatQuantity } from '@/lib/formatters';
import { cn } from '@/lib/utils';

const DASHBOARD_FILTER_STORAGE_KEY = 'ledger.dashboard.filters';
const PERIOD_OPTIONS = [
  { value: 'year', label: 'Ano' },
  { value: '12m', label: '12m' },
  { value: '24m', label: '24m' },
  { value: '36m', label: '36m' },
  { value: 'all', label: 'Tudo' },
];
const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--primary)'];
const DETAIL_ASSET_LIMIT = 9;
const SEARCH_MATCH_LIMIT = 6;
const CLASS_LEVEL = { type: 'class', field: 'asset_class', label: 'Classe', emptyLabel: 'Sem classe' };
const ASSET_LEVEL = { type: 'asset', field: 'asset_id', label: 'Ativo' };
const HIERARCHY_BY_CLASS = {
  'Ação': [
    { type: 'sector', field: 'sector', label: 'Setor', emptyLabel: 'Sem setor' },
    { type: 'subsector', field: 'subsector', label: 'Subsetor', emptyLabel: 'Sem subsetor' },
    { type: 'segment', field: 'segment', label: 'Segmento', emptyLabel: 'Sem segmento' },
  ],
  FII: [
    { type: 'segment', field: 'segment', label: 'Segmento', emptyLabel: 'Sem segmento' },
  ],
  'FI-INFRA': [
    { type: 'segment', field: 'segment', label: 'Segmento', emptyLabel: 'Sem segmento' },
  ],
  'Tesouro Direto': [
    { type: 'treasury_indexer', field: 'treasury_indexer', label: 'Indexador', emptyLabel: 'Sem indexador' },
  ],
};

const TREASURY_INDEXER_LABELS = {
  SELIC: 'SELIC',
  IPCA: 'IPCA',
  PREFIXED: 'Prefixado',
};

function getStoredDashboardFilters() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DASHBOARD_FILTER_STORAGE_KEY) || '{}');
    return {
      period: PERIOD_OPTIONS.some((option) => option.value === parsed.period) ? parsed.period : 'year',
      assetClass: parsed.assetClass || '',
    };
  } catch {
    return { period: 'year', assetClass: '' };
  }
}

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getAssetLabel(position) {
  return position.current_ticker || `#${position.asset_id}`;
}

function normalizeSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function getSearchFillValue(position) {
  return position.current_ticker || position.name || getAssetLabel(position);
}

function positionMatchesSearch(position, normalizedQuery) {
  if (!normalizedQuery) return true;
  return [position.current_ticker, getAssetLabel(position), position.name, position.asset_id]
    .some((value) => normalizeSearchText(value).includes(normalizedQuery));
}

function getSearchRank(position, normalizedQuery) {
  const ticker = normalizeSearchText(position.current_ticker);
  const label = normalizeSearchText(getAssetLabel(position));
  const name = normalizeSearchText(position.name);

  if (ticker === normalizedQuery || label === normalizedQuery) return 0;
  if (ticker.startsWith(normalizedQuery) || label.startsWith(normalizedQuery)) return 1;
  if (name.startsWith(normalizedQuery)) return 2;
  if (ticker.includes(normalizedQuery) || label.includes(normalizedQuery)) return 3;
  return 4;
}

function hasText(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function getLevelValue(position, level) {
  if (level.type === 'asset') return String(position.asset_id);
  const value = position[level.field];
  return hasText(value) ? String(value).trim() : level.emptyLabel;
}

function getLevelLabel(position, level) {
  if (level.field === 'treasury_indexer') return TREASURY_INDEXER_LABELS[position.treasury_indexer] || getLevelValue(position, level);
  return level.type === 'asset' ? getAssetLabel(position) : getLevelValue(position, level);
}

function filterPositionsByPath(positions, path) {
  if (path.length === 0) return positions;
  return positions.filter((position) => path.every((node) => getLevelValue(position, node) === node.value));
}

function getHierarchyForClass(assetClass) {
  return HIERARCHY_BY_CLASS[assetClass] || [];
}

function getNextAllocationLevel(path, scopedPositions) {
  if (path.length === 0) return CLASS_LEVEL;

  const hierarchy = getHierarchyForClass(path[0]?.value);
  const selectedHierarchyDepth = path.length - 1;
  for (let index = selectedHierarchyDepth; index < hierarchy.length; index += 1) {
    const level = hierarchy[index];
    if (scopedPositions.some((position) => hasText(position[level.field]))) return level;
  }
  return ASSET_LEVEL;
}

function buildAllocationGroups(positions, level) {
  const groups = new Map();
  positions.forEach((position) => {
    const value = getLevelValue(position, level);
    const key = level.type === 'asset' ? `asset:${position.asset_id}` : `${level.type}:${value}`;
    const existing = groups.get(key) || {
      key,
      type: level.type,
      field: level.field,
      emptyLabel: level.emptyLabel,
      value,
      label: getLevelLabel(position, level),
      assetId: level.type === 'asset' ? position.asset_id : null,
      amount: 0,
      costBasis: 0,
      unrealized: 0,
      uses_cost_fallback: false,
      market_value_supported: true,
      positions: [],
    };

    existing.amount += toNumber(position.market_value);
    existing.costBasis += toNumber(position.cost_basis);
    existing.unrealized += toNumber(position.unrealized_result);
    existing.uses_cost_fallback = existing.uses_cost_fallback || Boolean(position.uses_cost_fallback);
    existing.market_value_supported = existing.market_value_supported && position.market_value_supported !== false;
    existing.positions.push(position);
    groups.set(key, existing);
  });

  const total = Array.from(groups.values()).reduce((sum, row) => sum + row.amount, 0);
  const sortedGroups = Array.from(groups.values())
    .sort((a, b) => b.amount - a.amount || compareText(a.label, b.label));
  const visibleGroups = level.type === 'asset' && sortedGroups.length > DETAIL_ASSET_LIMIT
    ? [
        ...sortedGroups.slice(0, DETAIL_ASSET_LIMIT),
        sortedGroups.slice(DETAIL_ASSET_LIMIT).reduce((others, row) => ({
          ...others,
          amount: others.amount + row.amount,
          costBasis: others.costBasis + row.costBasis,
          unrealized: others.unrealized + row.unrealized,
          uses_cost_fallback: others.uses_cost_fallback || row.uses_cost_fallback,
          market_value_supported: others.market_value_supported && row.market_value_supported,
          positions: [...others.positions, ...row.positions],
        }), {
          key: 'asset:others',
          type: 'others',
          field: level.field,
          value: 'Outros',
          label: 'Outros',
          assetId: null,
          amount: 0,
          costBasis: 0,
          unrealized: 0,
          uses_cost_fallback: false,
          market_value_supported: true,
          positions: [],
        }),
      ]
    : sortedGroups;

  return visibleGroups
    .map((row, index) => ({
      ...row,
      color: CHART_COLORS[index % CHART_COLORS.length],
      weight_pct: total > 0 ? (row.amount / total) * 100 : 0,
    }));
}

function getBreadcrumbLabel(path) {
  return ['Carteira', ...path.map((node) => node.label)].join(' > ');
}

function getVisibleBreadcrumbItems(path) {
  const items = path.map((node, index) => ({ type: 'node', node, index }));
  if (items.length <= 2) return items;
  return [
    { type: 'ellipsis', label: '...', title: getBreadcrumbLabel(path) },
    ...items.slice(-2),
  ];
}

function formatPercent(value, hideValues = false) {
  if (hideValues) return '•••••';
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return '—';
  return `${parsed.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

function formatCurrency(value, hideValues = false) {
  if (hideValues) return '•••••';
  return formatMoney(value);
}

function formatSignedCurrency(value, hideValues = false) {
  if (hideValues) return '•••••';
  const num = toNumber(value);
  const prefix = num > 0 ? '+' : '';
  return `${prefix}${formatCurrency(value)}`;
}

function formatDate(value) {
  if (!value) return '—';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const normalized = value.replace(' ', 'T');
  const parsed = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function formatMonth(value) {
  if (!value) return '—';
  const [year, month] = value.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  const label = new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(date).replace('.', '');
  return `${label}.${year}`;
}

function formatCompactMoney(value, hideValues = false) {
  if (hideValues) return '';
  const abs = Math.abs(Number(value || 0));
  if (abs >= 1000000) return `${(value / 1000000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (abs >= 1000) return `${(value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`;
  return Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'pt-BR', {
    numeric: true,
    sensitivity: 'base',
  });
}

function comparePositions(a, b, key) {
  if (key === 'ticker') return compareText(getAssetLabel(a), getAssetLabel(b));
  if (key === 'total_cost') return toNumber(a.total_cost) - toNumber(b.total_cost);
  if (key === 'realized_result') return toNumber(a.realized_result) - toNumber(b.realized_result);
  if (key === 'category_share') return a.category_share - b.category_share;
  if (key === 'portfolio_share') return a.portfolio_share - b.portfolio_share;
  return 0;
}

function SortableHead({ sortKey, sort, onSort, children, align = 'left' }) {
  const active = sort.key === sortKey;
  const Icon = sort.direction === 'asc' ? ArrowUp : ArrowDown;
  const alignmentClass = align === 'right' ? 'ml-auto -mr-2' : '-ml-3';

  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <Button
        variant="ghost"
        size="sm"
        className={`${alignmentClass} h-8 px-2 text-xs font-medium text-muted-foreground hover:text-foreground`}
        onClick={() => onSort(sortKey)}
      >
        {children}
        {active && <Icon className="ml-1 h-3.5 w-3.5" />}
      </Button>
    </TableHead>
  );
}

function MetricCard({ title, value, subtitle, detail, tone = 'default', badge, tooltip }) {
  const toneClass = tone === 'positive'
    ? 'text-emerald-500'
    : tone === 'negative'
      ? 'text-red-500'
      : 'text-foreground';

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</CardTitle>
          {tooltip && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-sm">{tooltip}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className={`font-mono text-2xl font-bold tabular-nums ${toneClass}`}>{value}</div>
        <div className="mt-2 flex min-h-5 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {subtitle && <span>{subtitle}</span>}
          {badge && <Badge variant="secondary">{badge}</Badge>}
        </div>
        {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-32" />
        ))}
      </div>
      <Skeleton className="h-[360px]" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Skeleton className="h-[340px]" />
        <Skeleton className="h-[340px]" />
      </div>
      <Skeleton className="h-[260px]" />
    </div>
  );
}

function MoneyTooltip({ active, payload, label, hideValues, labelFormatter }) {
  if (!active || !payload?.length) return null;
  const displayLabel = payload[0]?.payload?.year_month
    ? formatMonth(payload[0].payload.year_month)
    : labelFormatter
      ? labelFormatter(label)
      : label;
  return (
    <div className="min-w-52 rounded-lg border bg-background p-3 text-sm shadow-xl">
      <div className="mb-2 font-medium">{displayLabel}</div>
      <div className="flex flex-col gap-2">
        {payload.map((item) => (
          <div key={item.dataKey || item.name} className="flex items-center justify-between gap-4">
            <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />
              <span className="truncate">{item.name}</span>
            </span>
            <span className="font-mono font-medium tabular-nums">{formatCurrency(item.value, hideValues)}</span>
          </div>
        ))}
      </div>
      {payload[0]?.payload?.uses_cost_fallback && (
        <p className="mt-2 text-xs text-muted-foreground">
          {payload[0].payload.missing_quote_count} ativo(s) usando custo como fallback neste mês.
        </p>
      )}
      {payload[0]?.payload?.unsupported_market_value_count > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {payload[0].payload.unsupported_market_value_count} ativo(s) sem valor de mercado suportado nesta etapa.
        </p>
      )}
    </div>
  );
}

function AllocationTooltip({ active, payload, hideValues }) {
  if (!active || !payload?.length) return null;
  const item = payload[0];
  const row = item.payload;
  return (
    <div className="rounded-lg border bg-background p-3 text-sm shadow-xl">
      <div className="font-medium">{row.label}</div>
      <div className="mt-1 font-mono tabular-nums">
        {row.market_value_supported ? formatCurrency(row.amount, hideValues) : 'Sem valor de mercado'}
      </div>
      <div className="text-xs text-muted-foreground">{formatPercent(row.weight_pct, hideValues)} da seleção</div>
      {row.uses_cost_fallback && <div className="mt-1 text-xs text-muted-foreground">Inclui fallback para custo.</div>}
      {!row.market_value_supported && <div className="mt-1 text-xs text-muted-foreground">Classe sem regra de valor de mercado nesta etapa.</div>}
    </div>
  );
}

function OperationalAlert({ alerts, hideValues }) {
  const hasAlert = alerts && (
    (alerts.missing_recent_quotes_count || 0) > 0
    || (alerts.unsupported_market_value_count || 0) > 0
    || (alerts.no_quotes && !alerts.no_events)
  );
  if (!hasAlert) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="text-amber-500" aria-label="Alertas operacionais do dashboard">
          <AlertTriangle className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent align="start" className="max-w-sm">
        <div className="flex flex-col gap-2 text-sm">
          {alerts.no_quotes ? (
            <div>Nenhuma cotação mensal B3 encontrada para os filtros atuais.</div>
          ) : (
            <div>
              {alerts.missing_recent_quotes_count} ativo(s) sem cotação no mês-base {formatMonth(alerts.latest_quote_month)}.
            </div>
          )}
          {alerts.missing_recent_quotes_summary?.length > 0 && (
            <div className="text-muted-foreground">Ativos: {alerts.missing_recent_quotes_summary.join(', ')}</div>
          )}
          {alerts.unsupported_market_value_count > 0 && (
            <div>
              {alerts.unsupported_market_value_count} ativo(s) sem regra de valor de mercado nesta etapa.
            </div>
          )}
          {alerts.unsupported_market_value_summary?.length > 0 && (
            <div className="text-muted-foreground">Sem valor de mercado: {alerts.unsupported_market_value_summary.join(', ')}</div>
          )}
          {alerts.uses_cost_fallback && (
            <div className="text-muted-foreground">
              Fallback explícito para custo: {formatCurrency(alerts.cost_fallback_amount, hideValues)}.
            </div>
          )}
          <div className="text-muted-foreground">Última importação B3: {formatDateTime(alerts.last_b3_import_at)}</div>
          <div className="text-muted-foreground">Última competência de cotação: {formatMonth(alerts.latest_quote_month)}</div>
          <div className="text-muted-foreground">Última cotação: {alerts.latest_quote_date ? formatDate(alerts.latest_quote_date) : '—'}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export default function Dashboard() {
  const { activePortfolioId, hideValues } = useContext(AppContext);
  const [positionList, setPositionList] = useState([]);
  const [positionsLoading, setPositionsLoading] = useState(true);
  const [dashboardData, setDashboardData] = useState(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [portfolioDashboardData, setPortfolioDashboardData] = useState(null);
  const [portfolioDashboardLoading, setPortfolioDashboardLoading] = useState(true);
  const [dashboardFilters, setDashboardFilters] = useState(getStoredDashboardFilters);
  const [allocationPath, setAllocationPath] = useState([]);
  const [showEventForm, setShowEventForm] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [showB3Import, setShowB3Import] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSchwabImport, setShowSchwabImport] = useState(false);
  const [assetFilterClass, setAssetFilterClass] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);
  const [sort, setSort] = useState({ key: 'ticker', direction: 'asc' });
  const [isLargeModal, setIsLargeModal] = useState(false);
  const [showRedeemed, setShowRedeemed] = useState(() => {
    return localStorage.getItem('showRedeemed') === 'true';
  });
  const navigate = useNavigate();
  const searchInputRef = useRef(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') === 'assets' ? 'assets' : 'dashboard';
  const dashboardAssetClass = dashboardFilters.assetClass;
  const dashboardPeriod = dashboardFilters.period;

  const handleTabChange = (value) => {
    setSearchParams(value === 'assets' ? { tab: 'assets' } : {}, { replace: true });
  };

  const openImportFlow = (flow) => {
    setShowImportMenu(false);
    if (flow === 'b3') setShowB3Import(true);
    if (flow === 'positions') setShowImport(true);
    if (flow === 'schwab') setShowSchwabImport(true);
  };

  useEffect(() => {
    localStorage.setItem('showRedeemed', showRedeemed);
  }, [showRedeemed]);

  useEffect(() => {
    localStorage.setItem(DASHBOARD_FILTER_STORAGE_KEY, JSON.stringify(dashboardFilters));
  }, [dashboardFilters]);

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
        || showEventForm
        || showB3Import
        || showImport
        || showSchwabImport
      ) {
        return;
      }

      event.preventDefault();
      setSearchFocused(true);
      searchInputRef.current?.focus();
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [showEventForm, showB3Import, showImport, showSchwabImport]);

  const loadPositions = useCallback(async () => {
    if (!activePortfolioId) {
      setPositionList([]);
      setPositionsLoading(false);
      return;
    }
    setPositionsLoading(true);
    try {
      const data = await posApi.list(activePortfolioId);
      setPositionList(data);
    } catch (err) {
      console.error('Failed to load positions:', err);
      toast.error(err.message || 'Falha ao carregar posições.');
    } finally {
      setPositionsLoading(false);
    }
  }, [activePortfolioId]);

  const loadDashboard = useCallback(async () => {
    if (!activePortfolioId) {
      setDashboardData(null);
      setDashboardLoading(false);
      return;
    }
    setDashboardLoading(true);
    try {
      const data = await dashboardApi.get({
        portfolioId: activePortfolioId,
        period: dashboardPeriod,
        assetClass: dashboardAssetClass || null,
      });
      setDashboardData(data);
    } catch (err) {
      console.error('Failed to load dashboard:', err);
      setDashboardData(null);
      toast.error(err.message || 'Falha ao carregar Dashboard.');
    } finally {
      setDashboardLoading(false);
    }
  }, [activePortfolioId, dashboardPeriod, dashboardAssetClass]);

  const loadPortfolioDashboard = useCallback(async () => {
    if (!activePortfolioId) {
      setPortfolioDashboardData(null);
      setPortfolioDashboardLoading(false);
      return;
    }
    setPortfolioDashboardLoading(true);
    try {
      const data = await dashboardApi.get({
        portfolioId: activePortfolioId,
        period: 'year',
        assetClass: null,
      });
      setPortfolioDashboardData(data);
    } catch (err) {
      console.error('Failed to load portfolio dashboard:', err);
      setPortfolioDashboardData(null);
      toast.error(err.message || 'Falha ao carregar alocação da carteira.');
    } finally {
      setPortfolioDashboardLoading(false);
    }
  }, [activePortfolioId]);

  const refreshData = useCallback(() => {
    loadPositions();
    loadDashboard();
    loadPortfolioDashboard();
  }, [loadPositions, loadDashboard, loadPortfolioDashboard]);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (active) loadPositions();
    });
    return () => {
      active = false;
    };
  }, [loadPositions]);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (active) loadDashboard();
    });
    return () => {
      active = false;
    };
  }, [loadDashboard]);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (active) loadPortfolioDashboard();
    });
    return () => {
      active = false;
    };
  }, [loadPortfolioDashboard]);

  useEffect(() => {
    setAllocationPath([]);
  }, [activePortfolioId]);

  const handleSort = (key) => {
    setSort((current) => (
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    ));
  };

  const handleAllocationItemClick = useCallback((row) => {
    if (!row) return;
    if (row.type === 'others') return;
    if (row.type === 'asset' && row.assetId) {
      navigate(`/assets/${row.assetId}`);
      return;
    }
    setAllocationPath((current) => [
      ...current,
      {
        type: row.type,
        field: row.field,
        value: row.value,
        label: row.label,
        emptyLabel: row.emptyLabel,
      },
    ]);
  }, [navigate]);

  const handleBreadcrumbClick = useCallback((index) => {
    setAllocationPath((current) => (index < 0 ? [] : current.slice(0, index + 1)));
  }, []);

  const positionsWithShare = useMemo(() => {
    const allocationBase = positionList.filter((p) => showRedeemed || toNumber(p.quantity) !== 0);
    const portfolioTotal = allocationBase.reduce((sum, p) => sum + Math.max(toNumber(p.total_cost), 0), 0);
    const classTotals = allocationBase.reduce((totals, p) => {
      const assetClass = p.asset_class || 'Sem classe';
      totals[assetClass] = (totals[assetClass] || 0) + Math.max(toNumber(p.total_cost), 0);
      return totals;
    }, {});

    return positionList.map((p) => {
      const totalCost = Math.max(toNumber(p.total_cost), 0);
      const classTotal = classTotals[p.asset_class || 'Sem classe'] || 0;

      return {
        ...p,
        category_share: classTotal > 0 ? (totalCost / classTotal) * 100 : 0,
        portfolio_share: portfolioTotal > 0 ? (totalCost / portfolioTotal) * 100 : 0,
      };
    });
  }, [positionList, showRedeemed]);

  const filtered = useMemo(() => {
    const visible = positionsWithShare.filter((p) => {
      if (!showRedeemed && toNumber(p.quantity) === 0) return false;
      if (assetFilterClass && p.asset_class !== assetFilterClass) return false;
      return positionMatchesSearch(p, normalizeSearchText(searchQuery));
    });

    return [...visible].sort((a, b) => {
      const direction = sort.direction === 'asc' ? 1 : -1;
      const result = comparePositions(a, b, sort.key);
      return result === 0 ? compareText(getAssetLabel(a), getAssetLabel(b)) : result * direction;
    });
  }, [positionsWithShare, showRedeemed, assetFilterClass, searchQuery, sort]);

  const searchMatches = useMemo(() => {
    const normalizedQuery = normalizeSearchText(searchQuery);
    if (!normalizedQuery) return [];

    return positionsWithShare
      .filter((position) => {
        if (!showRedeemed && toNumber(position.quantity) === 0) return false;
        if (assetFilterClass && position.asset_class !== assetFilterClass) return false;
        return positionMatchesSearch(position, normalizedQuery);
      })
      .sort((a, b) => {
        const rank = getSearchRank(a, normalizedQuery) - getSearchRank(b, normalizedQuery);
        return rank === 0 ? compareText(getAssetLabel(a), getAssetLabel(b)) : rank;
      })
      .slice(0, SEARCH_MATCH_LIMIT);
  }, [positionsWithShare, showRedeemed, assetFilterClass, searchQuery]);

  useEffect(() => {
    setActiveSearchMatchIndex(0);
  }, [searchQuery, assetFilterClass, showRedeemed]);

  const selectedSearchMatchIndex = searchMatches.length ? Math.min(activeSearchMatchIndex, searchMatches.length - 1) : -1;
  const activeSearchMatch = searchMatches[selectedSearchMatchIndex] || null;
  const showSearchMatches = searchFocused && normalizeSearchText(searchQuery) && searchMatches.length > 0;

  const navigateToSearchMatch = useCallback((position) => {
    if (!position) return;
    setSearchQuery(getSearchFillValue(position));
    setSearchFocused(false);
    navigate(`/assets/${position.asset_id}`);
  }, [navigate]);

  const handleSearchKeyDown = useCallback((event) => {
    if (event.key === 'ArrowDown' && searchMatches.length > 0) {
      event.preventDefault();
      setActiveSearchMatchIndex((current) => (current + 1) % searchMatches.length);
      return;
    }

    if (event.key === 'ArrowUp' && searchMatches.length > 0) {
      event.preventDefault();
      setActiveSearchMatchIndex((current) => (current - 1 + searchMatches.length) % searchMatches.length);
      return;
    }

    if (event.key === 'Tab' && activeSearchMatch) {
      const fillValue = getSearchFillValue(activeSearchMatch);
      if (searchQuery !== fillValue) {
        event.preventDefault();
        setSearchQuery(fillValue);
      }
      return;
    }

    if (event.key === 'Enter' && activeSearchMatch) {
      event.preventDefault();
      navigateToSearchMatch(activeSearchMatch);
      return;
    }

    if (event.key === 'Escape') {
      setSearchFocused(false);
    }
  }, [activeSearchMatch, navigateToSearchMatch, searchMatches.length, searchQuery]);

  const displayMoney = (val) => formatMoney(val, hideValues);
  const displayQuantity = (val, assetClass) => formatQuantity(val, assetClass, hideValues);
  const classes = [...new Set(positionList.map((p) => p.asset_class).filter(Boolean))].sort();
  const dashboardClassOptions = dashboardData?.filters?.asset_classes?.length ? dashboardData.filters.asset_classes : classes;
  const summary = dashboardData?.summary;
  const alerts = dashboardData?.operational_alerts;

  const equityData = useMemo(() => (
    (dashboardData?.equity_curve || []).map((row) => ({
      ...row,
      monthLabel: formatMonth(row.year_month),
      market_value: toNumber(row.market_value),
      cost_basis: toNumber(row.cost_basis),
      net_contribution: toNumber(row.net_contribution),
      net_contributions_accumulated: toNumber(row.net_contributions_accumulated),
    }))
  ), [dashboardData]);

  const portfolioStructureData = portfolioDashboardData || (!dashboardAssetClass && dashboardPeriod === 'year' ? dashboardData : null);

  const portfolioCurrentPositions = useMemo(() => (
    (portfolioStructureData?.current_positions || []).filter((position) => toNumber(position.quantity) > 0)
  ), [portfolioStructureData]);

  const portfolioMarketTotal = useMemo(() => (
    portfolioCurrentPositions.reduce((sum, position) => sum + toNumber(position.market_value), 0)
  ), [portfolioCurrentPositions]);

  const allocationSelection = useMemo(() => {
    const scopedPositions = filterPositionsByPath(portfolioCurrentPositions, allocationPath);
    const level = getNextAllocationLevel(allocationPath, scopedPositions);
    const groups = buildAllocationGroups(scopedPositions, level);
    const total = scopedPositions.reduce((sum, position) => sum + toNumber(position.market_value), 0);
    const unrealized = scopedPositions.reduce((sum, position) => sum + toNumber(position.unrealized_result), 0);
    const sortedAssets = [...scopedPositions].sort((a, b) => (
      toNumber(b.market_value) - toNumber(a.market_value) || compareText(getAssetLabel(a), getAssetLabel(b))
    ));
    const topAssets = sortedAssets.slice(0, DETAIL_ASSET_LIMIT);
    const remainingAssets = sortedAssets.slice(DETAIL_ASSET_LIMIT);
    const detailRows = topAssets.map((position) => ({
      key: `asset:${position.asset_id}`,
      type: 'asset',
      assetId: position.asset_id,
      label: getAssetLabel(position),
      name: position.name,
      marketValue: toNumber(position.market_value),
      unrealized: toNumber(position.unrealized_result),
      share: total > 0 ? (toNumber(position.market_value) / total) * 100 : 0,
      usesCostFallback: Boolean(position.uses_cost_fallback),
      marketValueSupported: position.market_value_supported !== false,
    }));

    if (remainingAssets.length > 0) {
      const otherMarketValue = remainingAssets.reduce((sum, position) => sum + toNumber(position.market_value), 0);
      detailRows.push({
        key: 'others',
        type: 'others',
        label: 'Outros',
        name: `${remainingAssets.length} ativo(s)`,
        marketValue: otherMarketValue,
        unrealized: remainingAssets.reduce((sum, position) => sum + toNumber(position.unrealized_result), 0),
        share: total > 0 ? (otherMarketValue / total) * 100 : 0,
        usesCostFallback: remainingAssets.some((position) => position.uses_cost_fallback),
        marketValueSupported: remainingAssets.every((position) => position.market_value_supported !== false),
      });
    }

    const buildAllocationHighlight = (position) => position ? ({
      label: getAssetLabel(position),
      share: total > 0 ? (toNumber(position.market_value) / total) * 100 : 0,
    }) : null;

    return {
      scopedPositions,
      level,
      groups,
      total,
      unrealized,
      largestAllocation: buildAllocationHighlight(sortedAssets[0]),
      smallestAllocation: buildAllocationHighlight([...sortedAssets].sort((a, b) => (
        toNumber(a.market_value) - toNumber(b.market_value) || compareText(getAssetLabel(a), getAssetLabel(b))
      ))[0]),
      detailRows,
      label: getBreadcrumbLabel(allocationPath),
      portfolioShare: portfolioMarketTotal > 0 ? (total / portfolioMarketTotal) * 100 : 0,
    };
  }, [allocationPath, portfolioCurrentPositions, portfolioMarketTotal]);

  const incomeData = useMemo(() => (
    (dashboardData?.income_series || []).map((row) => ({
      ...row,
      monthLabel: formatMonth(row.year_month),
      amount: toNumber(row.amount),
    }))
  ), [dashboardData]);

  const hasDashboardEvents = !alerts?.no_events;
  const hasEquityData = equityData.some((row) => row.market_value !== 0 || row.cost_basis !== 0 || row.net_contribution !== 0 || row.net_contributions_accumulated !== 0);
  const resultTone = toNumber(summary?.unrealized_result) > 0 ? 'positive' : toNumber(summary?.unrealized_result) < 0 ? 'negative' : 'default';
  const realizedTone = toNumber(summary?.realized_result) > 0 ? 'positive' : toNumber(summary?.realized_result) < 0 ? 'negative' : 'default';
  const realizedPeriodDetail = summary?.realized_result_period_start
    ? `${formatDate(summary.realized_result_period_start)} a ${formatDate(summary.realized_result_period_end)}`
    : `Até ${formatDate(summary?.realized_result_period_end)}`;
  const incomeSubtitle = summary?.income_month_count > 1
    ? `Média mensal ${formatCurrency(summary.income_monthly_avg, hideValues)}`
    : 'No período selecionado';
  const allocationLoading = portfolioDashboardLoading && !portfolioStructureData;
  const allocationResultTone = allocationSelection.unrealized > 0 ? 'text-emerald-500' : allocationSelection.unrealized < 0 ? 'text-red-500' : 'text-foreground';
  const largestAllocationLabel = allocationSelection.largestAllocation
    ? `${allocationSelection.largestAllocation.label} (${formatPercent(allocationSelection.largestAllocation.share, hideValues)})`
    : '—';
  const smallestAllocationLabel = allocationSelection.smallestAllocation
    ? `${allocationSelection.smallestAllocation.label} (${formatPercent(allocationSelection.smallestAllocation.share, hideValues)})`
    : '—';
  const allocationPieData = allocationSelection.groups.filter((row) => row.amount > 0 && row.market_value_supported);
  const allocationBreadcrumbItems = useMemo(() => getVisibleBreadcrumbItems(allocationPath), [allocationPath]);

  if (!activePortfolioId) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <FolderOpen className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <h3 className="mb-2 text-lg font-semibold">Nenhuma carteira selecionada</h3>
        <p className="max-w-sm text-sm text-muted-foreground">Crie uma carteira em Configurações para começar.</p>
      </div>
    );
  }

  return (
    <div className="-mt-3 flex flex-col gap-6">
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col gap-5">
        <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
          <div className="overflow-x-auto pb-1">
            <TabsList className="min-w-max justify-start">
              <TabsTrigger value="dashboard" className="h-9 flex-none px-3">
                Dashboard
              </TabsTrigger>
              <TabsTrigger value="assets" className="h-9 flex-none px-3">
                Ativos
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <OperationalAlert alerts={alerts} hideValues={hideValues} />
            <div className="relative w-[260px]">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                role="combobox"
                aria-expanded={Boolean(showSearchMatches)}
                aria-controls="dashboard-asset-search-listbox"
                aria-activedescendant={activeSearchMatch ? `dashboard-asset-search-${activeSearchMatch.asset_id}` : undefined}
                className="w-full pl-8 pr-12"
                placeholder="Buscar ticker ou nome..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onKeyDown={handleSearchKeyDown}
              />
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                <Kbd>/</Kbd>
              </div>
              {showSearchMatches && (
                <div
                  id="dashboard-asset-search-listbox"
                  role="listbox"
                  className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
                >
                  {searchMatches.map((position, index) => {
                    const selected = index === selectedSearchMatchIndex;
                    return (
                      <button
                        key={position.asset_id}
                        id={`dashboard-asset-search-${position.asset_id}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm outline-none transition-colors',
                          selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                        )}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveSearchMatchIndex(index)}
                        onClick={() => navigateToSearchMatch(position)}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">{getAssetLabel(position)}</span>
                          {position.name && <span className="truncate text-xs text-muted-foreground">{position.name}</span>}
                        </span>
                        {position.asset_class && <Badge variant="secondary" className="shrink-0">{position.asset_class}</Badge>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <Popover open={showImportMenu} onOpenChange={setShowImportMenu}>
              <PopoverTrigger asChild>
                <Button variant="outline">
                  <Download className="h-4 w-4" />
                  Importar
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-2">
                <div className="flex flex-col gap-1">
                  <Button variant="ghost" className="justify-start" onClick={() => openImportFlow('b3')}>
                    B3 - Relatório Mensal
                  </Button>
                  <Button variant="ghost" className="justify-start" onClick={() => openImportFlow('positions')}>
                    Posições Excel
                  </Button>
                  <Button variant="ghost" className="justify-start" onClick={() => openImportFlow('schwab')}>
                    Schwab
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            <Button onClick={() => setShowEventForm(true)}>
              <Plus className="h-4 w-4" />
              Novo Evento
            </Button>
          </div>
        </div>

        <TabsContent value="dashboard" className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            {dashboardClassOptions.length > 0 && (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Classe do Dashboard">
                <Button
                  variant={!dashboardAssetClass ? 'default' : 'outline'}
                  size="sm"
                  className="text-sm"
                  onClick={() => setDashboardFilters((current) => ({ ...current, assetClass: '' }))}
                >
                  Todos
                </Button>
                {dashboardClassOptions.map((assetClass) => (
                  <Button
                    key={assetClass}
                    variant={dashboardAssetClass === assetClass ? 'default' : 'outline'}
                    size="sm"
                    className="text-sm"
                    onClick={() => setDashboardFilters((current) => ({ ...current, assetClass }))}
                  >
                    {assetClass}
                  </Button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 lg:ml-auto lg:justify-end" aria-label="Período do Dashboard">
              {PERIOD_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant={dashboardPeriod === option.value ? 'default' : 'outline'}
                  size="sm"
                  className="text-sm"
                  onClick={() => setDashboardFilters((current) => ({ ...current, period: option.value }))}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>

          {dashboardLoading && !dashboardData ? (
            <DashboardSkeleton />
          ) : !dashboardData || !hasDashboardEvents ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <Inbox className="mb-3 h-10 w-10 text-muted-foreground/40" />
                <h3 className="mb-1 text-base font-medium">Nenhum evento registrado</h3>
                <p className="max-w-sm text-sm text-muted-foreground">Lance um evento ou importe os dados para montar a visão patrimonial.</p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
                <MetricCard
                  title="Valor de Mercado"
                  value={formatCurrency(summary.market_value, hideValues)}
                  subtitle={summary.market_value_date ? `Base ${formatDate(summary.market_value_date)}` : 'Sem cotação B3'}
                  badge={summary.market_value_uses_cost_fallback ? 'Fallback custo' : null}
                  tooltip="Valor de mercado usa a cotação mensal B3 do mês-base. Quando a cotação do ativo não existe nesse mês, a API usa o custo como fallback explícito e sinalizado. Criptomoedas ficam fora nesta etapa."
                />
                <MetricCard
                  title="Valor Patrimonial"
                  value={formatCurrency(summary.cost_basis, hideValues)}
                  subtitle="Valor patrimonial atual"
                  tooltip="Custo patrimonial atual das posições abertas, derivado do replay do ledger."
                />
                <MetricCard
                  title="Diferença de Mercado"
                  value={formatSignedCurrency(summary.unrealized_result, hideValues)}
                  subtitle={formatPercent(summary.unrealized_result_pct, hideValues)}
                  tone={resultTone}
                  tooltip="Valor de mercado menos valor patrimonial dos ativos com valor de mercado suportado. Não inclui vendas realizadas, proventos nem criptomoedas nesta etapa."
                />
                <MetricCard
                  title="Resultado Realizado"
                  value={formatSignedCurrency(summary.realized_result, hideValues)}
                  subtitle="Operações realizadas"
                  detail={realizedPeriodDetail}
                  tone={realizedTone}
                  tooltip="Resultado consolidado de vendas e resgates realizados no período selecionado. Separado do resultado não realizado."
                />
                <MetricCard
                  title="Proventos"
                  value={formatCurrency(summary.income, hideValues)}
                  subtitle={incomeSubtitle}
                  tooltip="Resumo dos proventos importados da B3 no período e classe selecionados. O detalhamento continua na tela Proventos."
                />
              </div>

              <Card className="overflow-hidden">
                <CardHeader className="border-b">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <CardTitle className="text-base">Evolução Patrimonial Mensal</CardTitle>
                    {alerts?.uses_cost_fallback && (
                      <Badge variant="secondary">Alguns meses usam fallback para custo</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="p-4">
                  {!hasEquityData ? (
                    <div className="flex h-[340px] items-center justify-center text-center text-sm text-muted-foreground">
                      Sem dados suficientes para montar a evolução patrimonial.
                    </div>
                  ) : (
                    <ChartContainer
                      config={{
                        market_value: { label: 'Valor de Mercado', color: 'var(--chart-1)' },
                        cost_basis: { label: 'Valor Patrimonial', color: 'var(--chart-2)' },
                        net_contributions_accumulated: { label: 'Aporte líquido acumulado', color: 'var(--chart-4)' },
                        net_contribution: { label: 'Aporte líquido mensal', color: 'var(--muted-foreground)' },
                      }}
                      className="h-[340px] w-full aspect-auto"
                    >
                      <ComposedChart data={equityData} margin={{ left: 8, right: 16, top: 16, bottom: 8 }}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="monthLabel" tickLine={false} axisLine={false} tickMargin={8} minTickGap={18} />
                        <YAxis yAxisId="value" tickLine={false} axisLine={false} tickMargin={8} width={86} tickFormatter={(value) => formatCompactMoney(value, hideValues)} />
                        <YAxis yAxisId="flow" orientation="right" tickLine={false} axisLine={false} tickMargin={8} width={72} tickFormatter={(value) => formatCompactMoney(value, hideValues)} />
                        <ChartTooltip content={<MoneyTooltip hideValues={hideValues} labelFormatter={formatMonth} />} />
                        <Bar yAxisId="flow" name="Aporte líquido mensal" dataKey="net_contribution" fill="var(--color-net_contribution)" opacity={0.42} radius={[3, 3, 0, 0]} />
                        <Line yAxisId="value" name="Valor de Mercado" type="monotone" dataKey="market_value" stroke="var(--color-market_value)" strokeWidth={2.5} dot={false} />
                        <Line yAxisId="value" name="Valor Patrimonial" type="monotone" dataKey="cost_basis" stroke="var(--color-cost_basis)" strokeWidth={2} strokeDasharray="5 5" dot={false} />
                        <Line yAxisId="value" name="Aporte líquido acumulado" type="monotone" dataKey="net_contributions_accumulated" stroke="var(--color-net_contributions_accumulated)" strokeWidth={1.75} strokeDasharray="6 3 1 3" dot={false} />
                      </ComposedChart>
                    </ChartContainer>
                  )}
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <Card className="overflow-hidden">
                  <CardHeader className="border-b">
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div>
                        <CardTitle className="text-base">Alocação Atual por Classe</CardTitle>
                        <p className="mt-1 text-xs text-muted-foreground">Visão estrutural da carteira atual.</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1 md:justify-end" aria-label="Navegação da alocação">
                        <Button
                          type="button"
                          variant={allocationPath.length === 0 ? 'secondary' : 'ghost'}
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => handleBreadcrumbClick(-1)}
                        >
                          Carteira
                        </Button>
                        {allocationBreadcrumbItems.map((item) => (
                          <div
                            key={item.type === 'ellipsis' ? 'ellipsis' : `${item.node.type}:${item.node.value}:${item.index}`}
                            className="flex items-center gap-1"
                          >
                            <span className="text-xs text-muted-foreground">&gt;</span>
                            {item.type === 'ellipsis' ? (
                              <span className="flex h-7 items-center px-2 text-xs text-muted-foreground" title={item.title}>
                                {item.label}
                              </span>
                            ) : (
                              <Button
                                type="button"
                                variant={item.index === allocationPath.length - 1 ? 'secondary' : 'ghost'}
                                size="sm"
                                className="h-7 max-w-36 px-2 text-xs"
                                onClick={() => handleBreadcrumbClick(item.index)}
                                title={item.node.label}
                              >
                                <span className="truncate">{item.node.label}</span>
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="p-4">
                    {allocationLoading ? (
                      <div className="flex h-[280px] items-center justify-center text-center text-sm text-muted-foreground">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Carregando alocação atual...
                      </div>
                    ) : allocationSelection.groups.length === 0 ? (
                      <div className="flex h-[280px] items-center justify-center text-center text-sm text-muted-foreground">
                        Nenhuma posição aberta na carteira atual.
                      </div>
                    ) : (
                      <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-1 2xl:grid-cols-[220px_minmax(0,1fr)]">
                        <ChartContainer config={{}} className="h-[220px] w-full aspect-auto">
                          <PieChart>
                            <ChartTooltip content={<AllocationTooltip hideValues={hideValues} />} />
                            <Pie
                              data={allocationPieData}
                              dataKey="amount"
                              nameKey="label"
                              innerRadius={58}
                              outerRadius={88}
                              paddingAngle={2}
                              onClick={(entry) => handleAllocationItemClick(entry?.payload || entry)}
                              className="cursor-pointer"
                            >
                              {allocationPieData.map((entry) => (
                                <Cell key={entry.key} fill={entry.color} className="cursor-pointer" />
                              ))}
                            </Pie>
                          </PieChart>
                        </ChartContainer>
                        <div className="flex flex-col gap-1.5">
                          <div className="text-xs text-muted-foreground">
                            Clique em uma fatia ou item para abrir {allocationSelection.level.label.toLowerCase()}.
                          </div>
                          {allocationSelection.groups.map((row) => (
                            <button
                              key={row.key}
                              type="button"
                              className={cn(
                                'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/50',
                                row.positions.length === allocationSelection.scopedPositions.length && allocationPath.length > 0 && 'border-primary/40 bg-muted/30'
                              )}
                              onClick={() => handleAllocationItemClick(row)}
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: row.color }} />
                                <span className="truncate text-sm font-medium">{row.label}</span>
                                {row.uses_cost_fallback && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                                    </TooltipTrigger>
                                    <TooltipContent>Inclui valor de custo como fallback.</TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                              <div className="text-right">
                                <div className="font-mono text-sm font-medium tabular-nums">
                                  {row.market_value_supported ? formatCurrency(row.amount, hideValues) : 'Sem valor de mercado'}
                                </div>
                                <div className="text-xs text-muted-foreground">{formatPercent(row.weight_pct, hideValues)}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="overflow-hidden">
                  <CardHeader className="border-b">
                    <div className="flex flex-col gap-1">
                      <CardTitle className="text-base">Detalhamento da Seleção</CardTitle>
                      <p className="text-xs text-muted-foreground">{allocationSelection.label}</p>
                    </div>
                  </CardHeader>
                  <CardContent className="p-4">
                    {allocationLoading ? (
                      <div className="flex h-[280px] items-center justify-center text-center text-sm text-muted-foreground">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Carregando detalhamento...
                      </div>
                    ) : allocationSelection.scopedPositions.length === 0 ? (
                      <div className="flex h-[280px] items-center justify-center text-center text-sm text-muted-foreground">
                        Nenhum ativo para a seleção atual.
                      </div>
                    ) : (
                      <div className="flex flex-col gap-4">
                        <div className="overflow-hidden rounded-lg border">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-[220px] max-w-[220px]">Ativo</TableHead>
                                <TableHead className="text-right">Valor de mercado</TableHead>
                                <TableHead className="text-right">%</TableHead>
                                <TableHead className="text-right">Resultado Aberto</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {allocationSelection.detailRows.map((row) => (
                                <TableRow
                                  key={row.key}
                                  className={row.type === 'asset' ? 'cursor-pointer' : undefined}
                                  onClick={() => {
                                    if (row.type === 'asset') navigate(`/assets/${row.assetId}`);
                                  }}
                                >
                                  <TableCell className="w-[220px] max-w-[220px]">
                                    <div className="flex min-w-0 items-center gap-2">
                                      <span className="min-w-0 truncate font-medium">{row.label}</span>
                                      {row.usesCostFallback && (
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                                          </TooltipTrigger>
                                          <TooltipContent>Inclui valor de custo como fallback.</TooltipContent>
                                        </Tooltip>
                                      )}
                                    </div>
                                    {row.name && <div className="mt-0.5 truncate text-xs text-muted-foreground">{row.name}</div>}
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-sm tabular-nums">
                                    {row.marketValueSupported ? formatCurrency(row.marketValue, hideValues) : 'Sem valor de mercado'}
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-sm tabular-nums">{formatPercent(row.share, hideValues)}</TableCell>
                                  <TableCell className={cn('text-right font-mono text-sm tabular-nums', !hideValues && row.unrealized > 0 && 'text-emerald-500', !hideValues && row.unrealized < 0 && 'text-red-500')}>
                                    {formatSignedCurrency(row.unrealized, hideValues)}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>

                        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                          <div className="rounded-lg border p-3">
                            <div className="text-xs text-muted-foreground">Total da seleção</div>
                            <div className="mt-1 font-mono text-sm font-semibold tabular-nums">{formatCurrency(allocationSelection.total, hideValues)}</div>
                          </div>
                          <div className="rounded-lg border p-3">
                            <div className="text-xs text-muted-foreground">% da carteira</div>
                            <div className="mt-1 font-mono text-sm font-semibold tabular-nums">{formatPercent(allocationSelection.portfolioShare, hideValues)}</div>
                          </div>
                          <div className="rounded-lg border p-3">
                            <div className="text-xs text-muted-foreground">Resultado Aberto</div>
                            <div className={cn('mt-1 font-mono text-sm font-semibold tabular-nums', !hideValues && allocationResultTone)}>
                              {formatSignedCurrency(allocationSelection.unrealized, hideValues)}
                            </div>
                          </div>
                          <div className="rounded-lg border p-3 lg:col-span-1">
                            <div className="text-xs text-muted-foreground">Maior Alocação</div>
                            <div className="mt-1 truncate text-sm font-medium">{largestAllocationLabel}</div>
                          </div>
                          <div className="rounded-lg border p-3 lg:col-span-2">
                            <div className="text-xs text-muted-foreground">Menor Alocação</div>
                            <div className="mt-1 truncate text-sm font-medium">{smallestAllocationLabel}</div>
                          </div>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card className="overflow-hidden">
                <CardHeader className="border-b">
                  <CardTitle className="text-base">Proventos Mensais</CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  {incomeData.every((row) => row.amount === 0) ? (
                    <div className="flex h-[240px] items-center justify-center text-center text-sm text-muted-foreground">
                      Nenhum provento encontrado no período selecionado.
                    </div>
                  ) : (
                    <ChartContainer config={{ amount: { label: 'Proventos', color: 'var(--chart-3)' } }} className="h-[240px] w-full aspect-auto">
                      <BarChart data={incomeData} margin={{ left: 8, right: 8, top: 16, bottom: 8 }}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="monthLabel" tickLine={false} axisLine={false} tickMargin={8} minTickGap={12} />
                        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={86} tickFormatter={(value) => formatCompactMoney(value, hideValues)} />
                        <ChartTooltip content={<MoneyTooltip hideValues={hideValues} />} />
                        <Bar name="Proventos" dataKey="amount" fill="var(--color-amount)" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ChartContainer>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="assets" className="flex flex-col gap-5">
          <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex flex-wrap items-center gap-1.5">
              {classes.length > 1 && (
                <>
                  <Button
                    variant={!assetFilterClass ? 'default' : 'outline'}
                    size="sm"
                    className="text-sm"
                    onClick={() => setAssetFilterClass('')}
                  >
                    Todos
                  </Button>
                  {classes.map((c) => (
                    <Button
                      key={c}
                      variant={assetFilterClass === c ? 'default' : 'outline'}
                      size="sm"
                      className="text-sm"
                      onClick={() => setAssetFilterClass(c)}
                    >
                      {c}
                    </Button>
                  ))}
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="show-redeemed" className="cursor-pointer text-sm font-normal text-muted-foreground">
                Exibir resgatados
              </Label>
              <Switch
                id="show-redeemed"
                checked={showRedeemed}
                onCheckedChange={setShowRedeemed}
              />
            </div>
          </div>

          {positionsLoading ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="mb-3 h-6 w-6 animate-spin" />
              <span className="text-sm">Carregando posições...</span>
            </div>
          ) : filtered.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <Inbox className="mb-3 h-10 w-10 text-muted-foreground/40" />
                <h3 className="mb-1 text-base font-medium">Nenhuma posição encontrada</h3>
                <p className="max-w-sm text-sm text-muted-foreground">Lance um evento ou importe os dados para começar.</p>
              </CardContent>
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <div className="max-h-[calc(100vh-18rem)] overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow>
                      <SortableHead sortKey="ticker" sort={sort} onSort={handleSort}>Ticker</SortableHead>
                      <TableHead>Classe</TableHead>
                      <TableHead className="text-right">Quantidade</TableHead>
                      <SortableHead sortKey="total_cost" sort={sort} onSort={handleSort} align="right">Custo Total</SortableHead>
                      <TableHead className="text-right">Preço Médio</TableHead>
                      <SortableHead sortKey="realized_result" sort={sort} onSort={handleSort} align="right">Resultado</SortableHead>
                      <SortableHead sortKey="category_share" sort={sort} onSort={handleSort} align="right">% Categoria</SortableHead>
                      <SortableHead sortKey="portfolio_share" sort={sort} onSort={handleSort} align="right">% Carteira</SortableHead>
                      <TableHead>Último Evento</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((pos) => {
                      const realized = toNumber(pos.realized_result);
                      const qty = toNumber(pos.quantity);
                      return (
                        <TableRow
                          key={`${pos.portfolio_id}-${pos.asset_id}`}
                          className="cursor-pointer"
                          onClick={() => navigate(`/assets/${pos.asset_id}`)}
                        >
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">
                                {pos.current_ticker || `#${pos.asset_id}`}
                              </span>
                              {pos.duplicate_flag && (
                                <AlertCircle className="h-3.5 w-3.5 text-amber-500" title="Duplicado pendente de análise" />
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">{pos.asset_class}</Badge>
                          </TableCell>
                          <TableCell className={`text-right font-mono text-sm ${qty === 0 ? 'text-muted-foreground/50' : ''}`}>
                            {displayQuantity(pos.quantity, pos.asset_class)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">{displayMoney(pos.total_cost)}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{displayMoney(pos.average_price)}</TableCell>
                          <TableCell className={`text-right font-mono text-sm ${!hideValues && realized > 0 ? 'text-emerald-500' : !hideValues && realized < 0 ? 'text-red-500' : ''}`}>
                            {displayMoney(pos.realized_result)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">{formatPercent(pos.category_share, hideValues)}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{formatPercent(pos.portfolio_share, hideValues)}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{pos.last_event_date || '—'}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={showEventForm} onOpenChange={setShowEventForm}>
        <DialogContent className={isLargeModal ? 'sm:max-w-4xl' : 'sm:max-w-xl'}>
          <DialogHeader>
            <DialogTitle>Novo Evento</DialogTitle>
          </DialogHeader>
          <EventForm
            onSuccess={() => { setShowEventForm(false); refreshData(); }}
            onCancel={() => setShowEventForm(false)}
            onModeChange={setIsLargeModal}
          />
        </DialogContent>
      </Dialog>

      {showB3Import && (
        <B3MonthlyImportModal
          portfolioId={activePortfolioId}
          onClose={() => setShowB3Import(false)}
          onSuccess={refreshData}
        />
      )}

      {showImport && (
        <ImportModal
          portfolioId={activePortfolioId}
          onClose={() => setShowImport(false)}
          onSuccess={refreshData}
        />
      )}

      {showSchwabImport && (
        <SchwabImportModal
          onClose={() => setShowSchwabImport(false)}
        />
      )}
    </div>
  );
}
