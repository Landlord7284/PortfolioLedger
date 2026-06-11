import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, ExternalLink, Info, RotateCcw, Search, X } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { AppContext } from '../App';
import { b3 as b3Api } from '../api/client';
import { formatMoney, formatQuantity } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip } from '@/components/ui/chart';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const PROVENTOS_FILTER_STORAGE_KEY = 'ledger.proventos.filters';
const PERIOD_OPTIONS = [
  { value: 'year', label: 'Ano' },
  { value: '12m', label: '12m' },
  { value: '24m', label: '24m' },
  { value: '36m', label: '36m' },
  { value: 'all', label: 'Tudo' },
];

const CHART_GROUP_OPTIONS = [
  { value: 'asset_class', label: 'Classe' },
  { value: 'event_type', label: 'Tipo' },
  { value: 'asset', label: 'Ativo' },
];

const CHART_DISPLAY_OPTIONS = [
  { value: 'value', label: 'Valor (R$)' },
  { value: 'share', label: '% do total' },
];

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--primary)',
  'var(--muted-foreground)',
];
const TOP_SEGMENT_LIMIT = 5;
const ASSET_SEARCH_MATCH_LIMIT = 6;
const TABLE_PAGE_SIZE = 100;
const ALL_FILTER_VALUE = 'all';

function getStoredProventosFilters() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROVENTOS_FILTER_STORAGE_KEY) || '{}');
    return {
      period: PERIOD_OPTIONS.some((option) => option.value === parsed.period) ? parsed.period : 'year',
      chartGroupBy: CHART_GROUP_OPTIONS.some((option) => option.value === parsed.chartGroupBy)
        ? parsed.chartGroupBy
        : 'asset_class',
      chartDisplay: CHART_DISPLAY_OPTIONS.some((option) => option.value === parsed.chartDisplay)
        ? parsed.chartDisplay
        : 'value',
    };
  } catch {
    return { period: 'year', chartGroupBy: 'asset_class', chartDisplay: 'value' };
  }
}

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDate(value) {
  if (!value) return '-';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function formatDateTime(value) {
  if (!value) return '-';
  const [datePart, timePart = ''] = String(value).split(/[ T]/);
  const [year, month, day] = datePart.split('-');
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year} ${timePart.slice(0, 5) || '00:00'}`;
}

function formatMonth(value) {
  if (!value) return '-';
  const [year, month] = value.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  const label = new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(date).replace('.', '');
  return `${label}.${year}`;
}

function formatMonthName(value) {
  if (!value || value === ALL_FILTER_VALUE) return 'Todos';
  const date = new Date(2026, Number(value) - 1, 1);
  const label = new Intl.DateTimeFormat('pt-BR', { month: 'long' }).format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatPercent(value, hideValues = false, digits = 1) {
  if (hideValues) return '•••';
  const parsed = toNumber(value);
  return parsed.toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatYoc(value, hideValues = false) {
  if (value == null || value === '') return '—';
  return `${formatPercent(value, hideValues, 2)}%`;
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'pt-BR', { sensitivity: 'base' });
}

function normalizeSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function getAssetLabel(asset) {
  return asset?.ticker || asset?.name || (asset?.asset_id ? `#${asset.asset_id}` : '');
}

function getAssetSearchFillValue(asset) {
  return asset?.ticker || asset?.name || getAssetLabel(asset);
}

function assetMatchesSearch(asset, normalizedQuery) {
  if (!normalizedQuery) return true;
  return [asset?.ticker, asset?.name, asset?.asset_id]
    .some((value) => normalizeSearchText(value).includes(normalizedQuery));
}

function getAssetSearchRank(asset, normalizedQuery) {
  const ticker = normalizeSearchText(asset?.ticker);
  const label = normalizeSearchText(getAssetLabel(asset));
  const name = normalizeSearchText(asset?.name);

  if (ticker === normalizedQuery || label === normalizedQuery) return 0;
  if (ticker.startsWith(normalizedQuery) || label.startsWith(normalizedQuery)) return 1;
  if (name.startsWith(normalizedQuery)) return 2;
  if (ticker.includes(normalizedQuery) || label.includes(normalizedQuery)) return 3;
  return 4;
}

function displayIncomeName(row) {
  const name = row?.name || '';
  if (row?.asset_class === 'Tesouro Direto') return name;
  return name.replace(/^[A-Z0-9]{2,12}\s+-\s+/, '');
}

function compareRows(a, b, key) {
  if (key === 'payment_date') return compareText(a.payment_date, b.payment_date);
  if (key === 'ticker') return compareText(a.ticker, b.ticker);
  if (key === 'name') return compareText(displayIncomeName(a), displayIncomeName(b));
  if (key === 'event_type') return compareText(a.event_type, b.event_type);
  if (key === 'quantity') return toNumber(a.quantity) - toNumber(b.quantity);
  if (key === 'net_value') return toNumber(a.net_value) - toNumber(b.net_value);
  if (key === 'yoc') return toNumber(a.yoc) - toNumber(b.yoc);
  return 0;
}

function othersLabelForGroup(groupBy) {
  if (groupBy === 'asset') return 'Outros ativos';
  if (groupBy === 'event_type') return 'Outros tipos';
  return 'Outros';
}

function tableTitle(year, month) {
  if (!year || year === ALL_FILTER_VALUE) return 'Detalhamento — Todos os meses';
  if (!month || month === ALL_FILTER_VALUE) return `Detalhamento — ${year}`;
  return `Detalhamento — ${formatMonthName(month)}/${year}`;
}

function getPaginationItems(currentPage, pageCount) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);

  const pages = new Set([1, pageCount, currentPage]);
  if (currentPage > 1) pages.add(currentPage - 1);
  if (currentPage < pageCount) pages.add(currentPage + 1);
  if (currentPage <= 3) {
    pages.add(2);
    pages.add(3);
  }
  if (currentPage >= pageCount - 2) {
    pages.add(pageCount - 1);
    pages.add(pageCount - 2);
  }

  const sortedPages = [...pages].filter((page) => page >= 1 && page <= pageCount).sort((a, b) => a - b);
  return sortedPages.reduce((items, page) => {
    const previous = items[items.length - 1];
    if (typeof previous === 'number' && page - previous > 1) items.push(`ellipsis-${previous}-${page}`);
    items.push(page);
    return items;
  }, []);
}

function SortableHead({ sortKey, sort, onSort, className = '', children }) {
  const active = sort.key === sortKey;
  const Icon = sort.direction === 'asc' ? ArrowUp : ArrowDown;

  return (
    <TableHead className={className}>
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8 whitespace-nowrap px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => onSort(sortKey)}
      >
        {children}
        {active && <Icon data-icon="inline-end" />}
      </Button>
    </TableHead>
  );
}

function SummaryCard({ label, value, detail }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="font-mono text-2xl font-semibold tabular-nums">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function IncomeTooltip({ active, payload, hideValues }) {
  if (!active || !payload?.length) return null;
  const month = payload[0]?.payload;
  if (!month) return null;

  return (
    <div className="min-w-72 rounded-lg border bg-background p-4 text-sm shadow-xl">
      <div className="mb-3 font-semibold">{month.monthLabel}</div>
      <div className="flex flex-col gap-2">
        {month.segmentDetails.length === 0 ? (
          <div className="text-muted-foreground">Nenhum provento no mês.</div>
        ) : (
          month.segmentDetails.map((segment) => (
            <div key={segment.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: segment.color }}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate font-medium">{segment.key}</span>
              </span>
              <span className="font-mono font-semibold tabular-nums">
                {formatMoney(segment.value, hideValues)} ({formatPercent(segment.share, hideValues)}%)
              </span>
            </div>
          ))
        )}
      </div>
      <Separator className="my-3" />
      <div className="grid grid-cols-[1fr_auto] items-center gap-4 font-semibold">
        <span>Total recebido:</span>
        <span className="font-mono tabular-nums">{formatMoney(month.totalNetValue, hideValues)}</span>
      </div>
    </div>
  );
}

function LoadingCards() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Skeleton className="h-28" />
      <Skeleton className="h-28" />
    </div>
  );
}

export default function Proventos() {
  const navigate = useNavigate();
  const { activePortfolioId, portfolioList, hideValues } = useContext(AppContext);
  const [proventosFilters, setProventosFilters] = useState(getStoredProventosFilters);
  const [tableYear, setTableYear] = useState('');
  const [tableMonth, setTableMonth] = useState('');
  const [tableAssetClass, setTableAssetClass] = useState(ALL_FILTER_VALUE);
  const [tableAssetId, setTableAssetId] = useState(ALL_FILTER_VALUE);
  const [assetSearchQuery, setAssetSearchQuery] = useState('');
  const [assetSearchFocused, setAssetSearchFocused] = useState(false);
  const [activeAssetSearchMatchIndex, setActiveAssetSearchMatchIndex] = useState(0);
  const [tableEventType, setTableEventType] = useState(ALL_FILTER_VALUE);
  const [tablePage, setTablePage] = useState(1);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState({ key: 'payment_date', direction: 'desc' });
  const assetSearchInputRef = useRef(null);

  const activePortfolio = portfolioList.find((portfolio) => portfolio.id === activePortfolioId);
  const { period, chartGroupBy, chartDisplay } = proventosFilters;

  useEffect(() => {
    localStorage.setItem(PROVENTOS_FILTER_STORAGE_KEY, JSON.stringify(proventosFilters));
  }, [proventosFilters]);

  useEffect(() => {
    if (!activePortfolioId) return;

    let active = true;
    async function loadReport() {
      setLoading(true);
      try {
        const data = await b3Api.incomes({
          portfolioId: activePortfolioId,
          period,
          chartGroupBy,
          tableYear: tableYear || null,
          tableMonth: tableMonth || null,
          tableAssetClass: tableAssetClass === ALL_FILTER_VALUE ? null : tableAssetClass,
          tableAssetId: tableAssetId === ALL_FILTER_VALUE ? null : tableAssetId,
          tableEventType: tableEventType === ALL_FILTER_VALUE ? null : tableEventType,
        });
        if (!active) return;
        setReport(data);
      } catch (err) {
        if (active) {
          setReport(null);
          toast.error(err.message || 'Falha ao carregar Proventos.');
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    loadReport();
    return () => {
      active = false;
    };
  }, [activePortfolioId, period, chartGroupBy, tableYear, tableMonth, tableAssetClass, tableAssetId, tableEventType]);

  const monthlyChartSegments = useMemo(() => (
    (report?.chart.months || []).map((month) => {
      const sortedSegments = (month.segments || [])
        .map((segment) => ({
          key: segment.key,
          value: toNumber(segment.value),
        }))
        .filter((segment) => segment.value > 0)
        .sort((a, b) => (b.value - a.value) || compareText(a.key, b.key));
      const hasOverflow = sortedSegments.length > TOP_SEGMENT_LIMIT;
      const visibleSegments = hasOverflow ? sortedSegments.slice(0, TOP_SEGMENT_LIMIT) : sortedSegments;
      const visibleKeys = new Set(visibleSegments.map((segment) => segment.key));
      const othersValue = hasOverflow
        ? sortedSegments.reduce((sum, segment) => (visibleKeys.has(segment.key) ? sum : sum + segment.value), 0)
        : 0;

      return {
        month: month.month,
        totalNetValue: month.total_net_value,
        visibleSegments,
        othersValue,
      };
    })
  ), [report]);

  const chartSegments = useMemo(() => {
    const keys = [];
    monthlyChartSegments.forEach((month) => {
      month.visibleSegments.forEach((segment) => {
        if (!keys.includes(segment.key)) keys.push(segment.key);
      });
    });

    const segments = keys.map((key, index) => ({
      key,
      dataKey: `segment_${index}`,
      color: CHART_COLORS[index % TOP_SEGMENT_LIMIT],
      isOthers: false,
    }));

    if (monthlyChartSegments.some((month) => month.othersValue > 0)) {
      segments.push({
        key: othersLabelForGroup(chartGroupBy),
        dataKey: 'segment_others',
        color: CHART_COLORS[TOP_SEGMENT_LIMIT],
        isOthers: true,
      });
    }

    return segments;
  }, [monthlyChartSegments, chartGroupBy]);

  const chartConfig = useMemo(() => (
    chartSegments.reduce((config, segment) => {
      config[segment.dataKey] = { label: segment.key, color: segment.color };
      return config;
    }, {})
  ), [chartSegments]);

  const chartData = useMemo(() => {
    const segmentByKey = new Map(chartSegments.map((segment) => [segment.key, segment]));
    const othersSegment = chartSegments.find((segment) => segment.isOthers);

    return monthlyChartSegments.map((month) => {
      const total = toNumber(month.totalNetValue);
      const row = {
        month: month.month,
        monthLabel: formatMonth(month.month),
        totalNetValue: month.totalNetValue,
        segmentDetails: [
          ...month.visibleSegments.map((segment) => ({
            key: segment.key,
            value: segment.value,
            share: total ? (segment.value / total) * 100 : 0,
            color: segmentByKey.get(segment.key)?.color,
            isOthers: false,
          })),
          ...(month.othersValue > 0 ? [{
            key: othersSegment?.key || othersLabelForGroup(chartGroupBy),
            value: month.othersValue,
            share: total ? (month.othersValue / total) * 100 : 0,
            color: othersSegment?.color,
            isOthers: true,
          }] : []),
        ],
      };
      const monthlyValues = new Map(month.visibleSegments.map((segment) => [segment.key, segment.value]));
      chartSegments.forEach((segment) => {
        const value = segment.isOthers ? month.othersValue : (monthlyValues.get(segment.key) || 0);
        row[segment.dataKey] = chartDisplay === 'share' ? (total ? (value / total) * 100 : 0) : value;
      });
      return row;
    });
  }, [monthlyChartSegments, chartSegments, chartDisplay, chartGroupBy]);

  const yearOptions = report?.filters.years || [];
  const classOptions = report?.filters.asset_classes || [];
  const eventTypeOptions = report?.filters.event_types || [];
  const assetOptions = report?.filters.assets || [];
  const selectedAsset = assetOptions.find((asset) => String(asset.asset_id) === tableAssetId) || null;
  const effectiveTableYear = tableYear || (report?.table.year ? String(report.table.year) : '');
  const effectiveTableMonth = tableMonth || (report?.table.month ? String(report.table.month) : '');
  const selectTableYear = effectiveTableYear || ALL_FILTER_VALUE;
  const selectTableMonth = effectiveTableMonth || ALL_FILTER_VALUE;
  const monthOptions = [...new Set(yearOptions.flatMap((option) => option.months || []))]
    .sort((a, b) => b - a);
  const hasActiveTableFilters = (
    tableAssetClass !== ALL_FILTER_VALUE
    || tableAssetId !== ALL_FILTER_VALUE
    || tableEventType !== ALL_FILTER_VALUE
    || (Boolean(tableYear) && tableYear !== ALL_FILTER_VALUE)
    || (Boolean(tableMonth) && tableMonth !== ALL_FILTER_VALUE)
  );
  const assetSearchMatches = useMemo(() => {
    const normalizedQuery = normalizeSearchText(assetSearchQuery);
    if (!normalizedQuery) return [];

    return assetOptions
      .filter((asset) => assetMatchesSearch(asset, normalizedQuery))
      .sort((a, b) => {
        const rank = getAssetSearchRank(a, normalizedQuery) - getAssetSearchRank(b, normalizedQuery);
        return rank === 0 ? compareText(getAssetLabel(a), getAssetLabel(b)) : rank;
      })
      .slice(0, ASSET_SEARCH_MATCH_LIMIT);
  }, [assetOptions, assetSearchQuery]);
  const selectedAssetSearchMatchIndex = assetSearchMatches.length
    ? Math.min(activeAssetSearchMatchIndex, assetSearchMatches.length - 1)
    : -1;
  const activeAssetSearchMatch = assetSearchMatches[selectedAssetSearchMatchIndex] || null;
  const showAssetSearchMatches = assetSearchFocused
    && normalizeSearchText(assetSearchQuery)
    && assetSearchMatches.length > 0;

  useEffect(() => {
    if (tableAssetId === ALL_FILTER_VALUE) {
      setAssetSearchQuery('');
      return;
    }
    if (selectedAsset) setAssetSearchQuery(getAssetSearchFillValue(selectedAsset));
  }, [selectedAsset, tableAssetId]);

  useEffect(() => {
    setActiveAssetSearchMatchIndex(0);
  }, [assetSearchQuery, tableAssetClass]);

  useEffect(() => {
    const handleShortcut = (event) => {
      if (event.key !== '/' || event.defaultPrevented) return;
      const target = event.target;
      const editableTarget = target instanceof HTMLElement && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable
      );
      if (editableTarget) return;

      event.preventDefault();
      assetSearchInputRef.current?.focus();
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  const sortedRows = useMemo(() => {
    const rows = report?.table.rows || [];
    return [...rows]
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const direction = sort.direction === 'asc' ? 1 : -1;
        const result = compareRows(left.row, right.row, sort.key);
        return result === 0 ? left.index - right.index : result * direction;
      })
      .map(({ row }) => row);
  }, [report, sort]);

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / TABLE_PAGE_SIZE));
  const paginatedRows = useMemo(() => {
    const start = (tablePage - 1) * TABLE_PAGE_SIZE;
    return sortedRows.slice(start, start + TABLE_PAGE_SIZE);
  }, [sortedRows, tablePage]);
  const paginationItems = useMemo(() => getPaginationItems(tablePage, pageCount), [tablePage, pageCount]);
  const currentPageStart = sortedRows.length > 0 ? ((tablePage - 1) * TABLE_PAGE_SIZE) + 1 : 0;
  const currentPageEnd = Math.min(tablePage * TABLE_PAGE_SIZE, sortedRows.length);

  useEffect(() => {
    setTablePage(1);
  }, [tableYear, tableMonth, tableAssetClass, tableAssetId, tableEventType, sort]);

  useEffect(() => {
    if (tablePage > pageCount) setTablePage(pageCount);
  }, [pageCount, tablePage]);

  const handleSort = (key) => {
    setSort((current) => (
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    ));
  };

  const handleTableYearChange = (value) => {
    setTableYear(value);
    if (value === ALL_FILTER_VALUE) setTableMonth(ALL_FILTER_VALUE);
  };

  const handleTableMonthChange = (value) => {
    setTableMonth(value);
    if (value !== ALL_FILTER_VALUE && (!tableYear || tableYear === ALL_FILTER_VALUE)) {
      setTableYear(effectiveTableYear || ALL_FILTER_VALUE);
    }
  };

  const handleClearTableFilters = () => {
    setTableAssetClass(ALL_FILTER_VALUE);
    setTableAssetId(ALL_FILTER_VALUE);
    setAssetSearchQuery('');
    setTableEventType(ALL_FILTER_VALUE);
    setTableYear('');
    setTableMonth('');
  };

  const handleClearAssetFilter = () => {
    setTableAssetId(ALL_FILTER_VALUE);
    setAssetSearchQuery('');
    assetSearchInputRef.current?.focus();
  };

  const selectAssetFilter = (asset) => {
    if (!asset?.asset_id) return;
    setTableAssetId(String(asset.asset_id));
    setAssetSearchQuery(getAssetSearchFillValue(asset));
    setAssetSearchFocused(false);
  };

  const handleAssetSearchChange = (event) => {
    setAssetSearchQuery(event.target.value);
    if (tableAssetId !== ALL_FILTER_VALUE) setTableAssetId(ALL_FILTER_VALUE);
  };

  const handleAssetSearchKeyDown = (event) => {
    if (event.key === 'ArrowDown' && assetSearchMatches.length > 0) {
      event.preventDefault();
      setActiveAssetSearchMatchIndex((current) => (current + 1) % assetSearchMatches.length);
      return;
    }

    if (event.key === 'ArrowUp' && assetSearchMatches.length > 0) {
      event.preventDefault();
      setActiveAssetSearchMatchIndex((current) => (
        current - 1 + assetSearchMatches.length
      ) % assetSearchMatches.length);
      return;
    }

    if (event.key === 'Enter' && activeAssetSearchMatch) {
      event.preventDefault();
      selectAssetFilter(activeAssetSearchMatch);
      return;
    }

    if (event.key === 'Escape') {
      setAssetSearchFocused(false);
    }
  };

  const applyMonthFilterFromChart = (month) => {
    const [year, monthNumber] = month.split('-');
    setTableYear(year);
    setTableMonth(String(Number(monthNumber)));
  };

  const handleChartSegmentClick = (row, segment) => {
    if (!row || !segment) return;
    applyMonthFilterFromChart(row.month);
    setTableAssetClass(ALL_FILTER_VALUE);
    setTableAssetId(ALL_FILTER_VALUE);
    setAssetSearchQuery('');
    setTableEventType(ALL_FILTER_VALUE);
    if (segment.isOthers) return;
    if (chartGroupBy === 'asset_class') {
      setTableAssetClass(segment.key);
    } else if (chartGroupBy === 'event_type') {
      setTableEventType(segment.key);
    } else {
      const matchingAsset = assetOptions.find((asset) => (
        asset.ticker === segment.key || asset.name === segment.key
      ));
      if (matchingAsset?.asset_id) setTableAssetId(String(matchingAsset.asset_id));
    }
  };

  const currentTableTitle = tableTitle(selectTableYear, selectTableMonth);
  const rowCount = sortedRows.length;
  const tableCountLabel = rowCount > 0
    ? `Mostrando ${currentPageStart} a ${currentPageEnd} de ${rowCount} recebimentos`
    : 'Nenhum recebimento nos filtros selecionados';

  if (!activePortfolioId) {
    return (
      <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
        Selecione uma carteira para visualizar Proventos.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Proventos</h1>
          <p className="mt-1 text-sm text-muted-foreground">{activePortfolio?.name || 'Carteira ativa'}</p>
        </div>

        <div className="flex flex-wrap gap-1.5" aria-label="Período analítico">
          {PERIOD_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={period === option.value ? 'default' : 'outline'}
              size="sm"
              className="text-sm"
              onClick={() => setProventosFilters((current) => ({ ...current, period: option.value }))}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {loading && !report ? (
        <LoadingCards />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SummaryCard
            label="Renda acumulada"
            value={formatMoney(report?.summary.total_net_value, hideValues)}
            detail={period === 'all' ? 'Período completo' : 'Comparativo: —'}
          />
          <SummaryCard
            label="Média mensal"
            value={formatMoney(report?.summary.monthly_average, hideValues)}
            detail={`${report?.summary.month_count || 0} meses no período`}
          />
        </div>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle className="text-base">Evolução mensal (R$)</CardTitle>
              <CardDescription>Clique em uma barra ou segmento para atualizar o detalhamento.</CardDescription>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">Exibir:</span>
                {CHART_DISPLAY_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    type="button"
                    variant={chartDisplay === option.value ? 'default' : 'outline'}
                    size="sm"
                    className="text-sm"
                    onClick={() => setProventosFilters((current) => ({ ...current, chartDisplay: option.value }))}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">Agrupar por:</span>
                {CHART_GROUP_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    type="button"
                    variant={chartGroupBy === option.value ? 'default' : 'outline'}
                    size="sm"
                    className="text-sm"
                    onClick={() => setProventosFilters((current) => ({ ...current, chartGroupBy: option.value }))}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          {loading && !report ? (
            <Skeleton className="h-[340px]" />
          ) : chartData.length === 0 ? (
            <div className="flex h-[300px] items-center justify-center text-center text-sm text-muted-foreground">
              Nenhum provento encontrado para o período.
            </div>
          ) : (
            <ChartContainer config={chartConfig} className="h-[340px] w-full aspect-auto">
              <BarChart
                data={chartData}
                margin={{ left: 8, right: 8, top: 16, bottom: 8 }}
                onClick={(event) => {
                  const month = event?.activePayload?.[0]?.payload?.month;
                  if (month) applyMonthFilterFromChart(month);
                }}
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="monthLabel"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={16}
                  onClick={(event) => {
                    if (event?.payload?.month) applyMonthFilterFromChart(event.payload.month);
                  }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={80}
                  tickFormatter={(value) => (
                    chartDisplay === 'share'
                      ? (hideValues ? '' : `${formatPercent(value)}%`)
                      : (hideValues ? '' : formatMoney(value))
                  )}
                />
                <ChartTooltip cursor={false} content={<IncomeTooltip hideValues={hideValues} />} />
                {chartSegments.map((segment) => (
                  <Bar
                    key={segment.dataKey}
                    dataKey={segment.dataKey}
                    stackId="income"
                    fill={`var(--color-${segment.dataKey})`}
                    radius={[3, 3, 0, 0]}
                    onClick={(data) => handleChartSegmentClick(data?.payload, segment)}
                  />
                ))}
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-end 2xl:justify-between">
            <CardTitle className="text-base">{currentTableTitle}</CardTitle>
            <div className="flex w-full flex-col gap-3 sm:flex-row sm:flex-wrap 2xl:w-auto 2xl:items-end 2xl:justify-end">
              <div className="flex w-full flex-col gap-1 sm:w-[150px]">
                <Label className="text-xs text-muted-foreground">Classe</Label>
                <Select value={tableAssetClass} onValueChange={setTableAssetClass}>
                  <SelectTrigger className="h-8 w-full" aria-label="Classe">
                    <SelectValue placeholder="Classe" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={ALL_FILTER_VALUE}>Todas</SelectItem>
                      {classOptions.map((assetClass) => (
                        <SelectItem key={assetClass} value={assetClass}>{assetClass}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-full flex-col gap-1 sm:w-[190px]">
                <Label className="text-xs text-muted-foreground">Tipo</Label>
                <Select value={tableEventType} onValueChange={setTableEventType}>
                  <SelectTrigger className="h-8 w-full" aria-label="Tipo">
                    <SelectValue placeholder="Tipo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={ALL_FILTER_VALUE}>Todos</SelectItem>
                      {eventTypeOptions.map((eventType) => (
                        <SelectItem key={eventType} value={eventType}>{eventType}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-full flex-col gap-1 sm:w-[270px]">
                <Label className="text-xs text-muted-foreground">Ativo</Label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={assetSearchInputRef}
                    role="combobox"
                    aria-expanded={Boolean(showAssetSearchMatches)}
                    aria-controls="proventos-asset-search-listbox"
                    aria-activedescendant={activeAssetSearchMatch ? `proventos-asset-search-${activeAssetSearchMatch.asset_id}` : undefined}
                    className={cn('h-8 w-full pl-8', assetSearchQuery ? 'pr-9' : 'pr-12')}
                    placeholder="Todos"
                    value={assetSearchQuery}
                    onChange={handleAssetSearchChange}
                    onFocus={() => setAssetSearchFocused(true)}
                    onBlur={() => setAssetSearchFocused(false)}
                    onKeyDown={handleAssetSearchKeyDown}
                  />
                  {assetSearchQuery ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={handleClearAssetFilter}
                        >
                          <X data-icon="inline-start" />
                          <span className="sr-only">Limpar ativo</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Limpar ativo</TooltipContent>
                    </Tooltip>
                  ) : (
                    <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                      <Kbd>/</Kbd>
                    </div>
                  )}
                  {showAssetSearchMatches && (
                    <div
                      id="proventos-asset-search-listbox"
                      role="listbox"
                      className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
                    >
                      {assetSearchMatches.map((asset, index) => {
                        const selected = index === selectedAssetSearchMatchIndex;
                        return (
                          <button
                            key={asset.asset_id}
                            id={`proventos-asset-search-${asset.asset_id}`}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={cn(
                              'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm outline-none transition-colors',
                              selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                            )}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => setActiveAssetSearchMatchIndex(index)}
                            onClick={() => selectAssetFilter(asset)}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate font-medium">{getAssetLabel(asset)}</span>
                              {asset.name && <span className="truncate text-xs text-muted-foreground">{asset.name}</span>}
                            </span>
                            {asset.asset_class && <Badge variant="secondary" className="shrink-0">{asset.asset_class}</Badge>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex w-full flex-col gap-1 sm:w-[110px] lg:ml-auto">
                <Label className="text-xs text-muted-foreground">Ano</Label>
                <Select value={selectTableYear} onValueChange={handleTableYearChange}>
                  <SelectTrigger className="h-8 w-full" aria-label="Ano">
                    <SelectValue placeholder="Ano" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={ALL_FILTER_VALUE}>Todos</SelectItem>
                      {yearOptions.map((option) => (
                        <SelectItem key={option.year} value={String(option.year)}>{option.year}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-full flex-col gap-1 sm:w-[130px]">
                <Label className="text-xs text-muted-foreground">Mês</Label>
                <Select value={selectTableMonth} onValueChange={handleTableMonthChange}>
                  <SelectTrigger className="h-8 w-full" aria-label="Mês">
                    <SelectValue placeholder="Mês" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={ALL_FILTER_VALUE}>Todos</SelectItem>
                      {monthOptions.map((month) => (
                        <SelectItem key={month} value={String(month)}>{formatMonthName(month)}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="invisible text-xs">Reset</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground"
                      disabled={!hasActiveTableFilters}
                      onClick={handleClearTableFilters}
                    >
                      <RotateCcw data-icon="inline-start" />
                      <span className="sr-only">Limpar filtros</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Limpar filtros</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading && !report ? (
            <div className="p-4">
              <Skeleton className="h-[260px]" />
            </div>
          ) : sortedRows.length === 0 ? (
            <div className="flex min-h-[220px] items-center justify-center text-center text-sm text-muted-foreground">
              Nenhum provento encontrado para os filtros selecionados.
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <SortableHead sortKey="payment_date" sort={sort} onSort={handleSort} className="w-[118px]">Pagamento</SortableHead>
                    <SortableHead sortKey="ticker" sort={sort} onSort={handleSort} className="w-[118px]">Ticker</SortableHead>
                    <SortableHead sortKey="name" sort={sort} onSort={handleSort} className="w-[260px]">Ativo</SortableHead>
                    <SortableHead sortKey="event_type" sort={sort} onSort={handleSort} className="w-[190px]">Tipo</SortableHead>
                    <SortableHead sortKey="quantity" sort={sort} onSort={handleSort} className="w-[128px] text-right">Quantidade</SortableHead>
                    <SortableHead sortKey="net_value" sort={sort} onSort={handleSort} className="w-[132px] text-right">Valor</SortableHead>
                    <SortableHead sortKey="yoc" sort={sort} onSort={handleSort} className="w-[90px] text-right">YoC</SortableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap">{formatDate(row.payment_date)}</TableCell>
                      <TableCell className="truncate whitespace-nowrap font-medium" title={row.ticker || '-'}>
                        {row.asset_id ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="-ml-2 max-w-full px-2 font-semibold"
                            onClick={() => navigate(`/assets/${row.asset_id}`)}
                          >
                            <span className="truncate">{row.ticker || `#${row.asset_id}`}</span>
                            <ExternalLink data-icon="inline-end" />
                          </Button>
                        ) : (
                          row.ticker || '-'
                        )}
                      </TableCell>
                      <TableCell className="truncate text-muted-foreground" title={displayIncomeName(row) || '-'}>
                        {displayIncomeName(row) || '-'}
                      </TableCell>
                      <TableCell className="truncate whitespace-nowrap" title={row.event_type || '-'}>
                        {row.event_type || '-'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono text-sm">
                        {formatQuantity(row.quantity, row.asset_class, hideValues)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono text-sm">
                        {formatMoney(row.net_value, hideValues)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono text-sm">
                        {formatYoc(row.yoc, hideValues)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-b-0 hover:bg-transparent">
                    <TableCell colSpan={7} className="h-auto p-0">
                      <Separator />
                    </TableCell>
                  </TableRow>
                  <TableRow className="border-b-0 hover:bg-transparent">
                    <TableCell colSpan={4} className="font-semibold">TOTAL</TableCell>
                    <TableCell></TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">
                      {formatMoney(report?.table.total_net_value, hideValues)}
                    </TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
          <div className="flex flex-col gap-3 border-t px-4 py-3 text-xs text-muted-foreground lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
              <span>{tableCountLabel}</span>
              <span className="font-medium text-foreground">
                Total do período: {formatMoney(report?.table.total_net_value, hideValues)}
              </span>
            </div>
            {pageCount > 1 && (
              <Pagination className="mx-0 w-auto justify-start lg:justify-end">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      type="button"
                      disabled={tablePage === 1}
                      onClick={() => setTablePage((current) => Math.max(1, current - 1))}
                    />
                  </PaginationItem>
                  {paginationItems.map((item) => (
                    typeof item === 'number' ? (
                      <PaginationItem key={item}>
                        <PaginationLink
                          type="button"
                          isActive={item === tablePage}
                          onClick={() => setTablePage(item)}
                        >
                          {item}
                        </PaginationLink>
                      </PaginationItem>
                    ) : (
                      <PaginationItem key={item}>
                        <PaginationEllipsis />
                      </PaginationItem>
                    )
                  ))}
                  <PaginationItem>
                    <PaginationNext
                      type="button"
                      disabled={tablePage === pageCount}
                      onClick={() => setTablePage((current) => Math.min(pageCount, current + 1))}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
              <Info data-icon="inline-start" />
              Entenda os dados desta página
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 text-sm">
            <div className="flex flex-col gap-2">
              <p>O período superior controla os cards e o gráfico.</p>
              <p>Os filtros da tabela controlam apenas o detalhamento.</p>
              <p>Clicar no gráfico sincroniza o detalhamento com o mês e o segmento selecionados.</p>
            </div>
          </PopoverContent>
        </Popover>
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <span>Dados atualizados em: {formatDateTime(report?.metadata?.data_updated_at)}</span>
          <span>Arquivo B3: {report?.metadata?.latest_b3_file_reference || '—'}</span>
          <span>
            {report?.metadata?.pending_review_count || 0} itens pendentes de revisão
            {(report?.metadata?.pending_review_count || 0) > 0 && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="ml-1 h-auto px-0 py-0 text-sm"
                onClick={() => navigate('/asset-management')}
              >
                Ver detalhes
              </Button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
