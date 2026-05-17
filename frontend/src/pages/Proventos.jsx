import { useContext, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { AppContext } from '../App';
import { b3 as b3Api } from '../api/client';
import { formatMoney, formatQuantity } from '@/lib/formatters';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip } from '@/components/ui/chart';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const PERIOD_OPTIONS = [
  { value: 'year', label: 'No ano' },
  { value: '12m', label: '12 meses' },
  { value: '24m', label: '24 meses' },
  { value: '36m', label: '36 meses' },
  { value: 'all', label: 'Do início' },
];

const CHART_GROUP_OPTIONS = [
  { value: 'asset', label: 'Ativo' },
  { value: 'asset_class', label: 'Classe de ativo' },
  { value: 'event_type', label: 'Tipo de provento' },
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
const OTHERS_SEGMENT_KEY = 'Outros';

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDate(value) {
  if (!value) return '-';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function formatMonth(value) {
  if (!value) return '-';
  const [year, month] = value.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  const label = new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(date).replace('.', '');
  return `${label}.${year}`;
}

function formatPercent(value) {
  const parsed = toNumber(value);
  return parsed.toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'pt-BR', { sensitivity: 'base' });
}

function compareRows(a, b, key) {
  if (key === 'payment_date') return compareText(a.payment_date, b.payment_date);
  if (key === 'ticker') return compareText(a.ticker, b.ticker);
  if (key === 'asset_class') return compareText(a.asset_class, b.asset_class);
  if (key === 'name') return compareText(displayIncomeName(a), displayIncomeName(b));
  if (key === 'event_type') return compareText(a.event_type, b.event_type);
  if (key === 'quantity') return toNumber(a.quantity) - toNumber(b.quantity);
  if (key === 'net_value') return toNumber(a.net_value) - toNumber(b.net_value);
  return 0;
}

function displayIncomeName(row) {
  const name = row?.name || '';
  if (row?.asset_class === 'Tesouro Direto') return name;
  return name.replace(/^[A-Z0-9]{2,12}\s+-\s+/, '');
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
        {active && <Icon className="ml-1 h-3.5 w-3.5" />}
      </Button>
    </TableHead>
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
                R$ {formatMoney(segment.value, hideValues)} ({hideValues ? '•••' : `${formatPercent(segment.share)}%`})
              </span>
            </div>
          ))
        )}
      </div>
      <Separator className="my-3" />
      <div className="grid grid-cols-[1fr_auto] items-center gap-4 font-semibold">
        <span>Total Recebido:</span>
        <span className="font-mono tabular-nums">R$ {formatMoney(month.totalNetValue, hideValues)}</span>
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
  const { activePortfolioId, portfolioList, hideValues } = useContext(AppContext);
  const [period, setPeriod] = useState('year');
  const [chartGroupBy, setChartGroupBy] = useState('asset');
  const [tableYear, setTableYear] = useState('');
  const [tableMonth, setTableMonth] = useState('');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState({ key: 'payment_date', direction: 'desc' });

  const activePortfolio = portfolioList.find((portfolio) => portfolio.id === activePortfolioId);

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
  }, [activePortfolioId, period, chartGroupBy, tableYear, tableMonth]);

  const handlePeriodChange = (value) => {
    setPeriod(value);
  };

  const monthlyChartSegments = useMemo(() => (
    (report?.chart.months || []).map((month) => {
      const sortedSegments = (month.segments || [])
        .map((segment) => ({
          key: segment.key,
          value: toNumber(segment.value),
        }))
        .filter((segment) => segment.value > 0)
        .sort((a, b) => (b.value - a.value) || compareText(a.key, b.key));
      const topSegments = sortedSegments.slice(0, TOP_SEGMENT_LIMIT);
      const topKeys = new Set(topSegments.map((segment) => segment.key));
      const othersValue = sortedSegments.reduce((sum, segment) => (
        topKeys.has(segment.key) ? sum : sum + segment.value
      ), 0);

      return {
        month: month.month,
        totalNetValue: month.total_net_value,
        topSegments,
        othersValue,
      };
    })
  ), [report]);

  const chartSegments = useMemo(() => {
    const keys = [];
    monthlyChartSegments.forEach((month) => {
      month.topSegments.forEach((segment) => {
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
        key: OTHERS_SEGMENT_KEY,
        dataKey: 'segment_others',
        color: CHART_COLORS[TOP_SEGMENT_LIMIT],
        isOthers: true,
      });
    }

    return segments;
  }, [monthlyChartSegments]);

  const chartConfig = useMemo(() => (
    chartSegments.reduce((config, segment) => {
      config[segment.dataKey] = { label: segment.key, color: segment.color };
      return config;
    }, {})
  ), [chartSegments]);

  const chartData = useMemo(() => {
    const segmentByKey = new Map(chartSegments.map((segment) => [segment.key, segment]));

    return monthlyChartSegments.map((month) => {
      const total = toNumber(month.totalNetValue);
      const othersSegment = segmentByKey.get(OTHERS_SEGMENT_KEY);
      const row = {
        month: month.month,
        monthLabel: formatMonth(month.month),
        totalNetValue: month.totalNetValue,
        segmentDetails: [
          ...month.topSegments.map((segment) => ({
            key: segment.key,
            value: segment.value,
            share: total ? (segment.value / total) * 100 : 0,
            color: segmentByKey.get(segment.key)?.color,
          })),
          ...(month.othersValue > 0 ? [{
            key: OTHERS_SEGMENT_KEY,
            value: month.othersValue,
            share: total ? (month.othersValue / total) * 100 : 0,
            color: othersSegment?.color,
          }] : []),
        ],
      };
      const monthlyValues = new Map(month.topSegments.map((segment) => [segment.key, segment.value]));
      chartSegments.forEach((segment) => {
        row[segment.dataKey] = segment.isOthers ? month.othersValue : (monthlyValues.get(segment.key) || 0);
      });
      return row;
    });
  }, [monthlyChartSegments, chartSegments]);

  const yearOptions = report?.filters.years || [];
  const effectiveTableYear = tableYear || (report?.table.year ? String(report.table.year) : '');
  const effectiveTableMonth = tableMonth || (report?.table.month ? String(report.table.month) : '');
  const monthOptions = yearOptions.find((option) => String(option.year) === String(effectiveTableYear))?.months || [];
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

  const handleSort = (key) => {
    setSort((current) => (
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    ));
  };

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

        <div className="flex flex-wrap gap-2" aria-label="Periodo">
          {PERIOD_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={period === option.value ? 'default' : 'outline'}
              size="sm"
              className="h-8 rounded-full px-3"
              onClick={() => handlePeriodChange(option.value)}
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
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Renda acumulada
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="font-mono text-2xl font-semibold tabular-nums">
                R$ {formatMoney(report?.summary.total_net_value, hideValues)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Média mensal
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="font-mono text-2xl font-semibold tabular-nums">
                R$ {formatMoney(report?.summary.monthly_average, hideValues)}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {report?.summary.month_count || 0} meses no período
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <CardTitle className="text-base">Proventos mensais</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Agrupar por:</span>
              {CHART_GROUP_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant={chartGroupBy === option.value ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 rounded-full px-3"
                  onClick={() => setChartGroupBy(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          {loading && !report ? (
            <Skeleton className="h-[340px]" />
          ) : chartData.length === 0 ? (
            <div className="flex h-[340px] items-center justify-center text-center text-sm text-muted-foreground">
              Nenhum provento encontrado para o período.
            </div>
          ) : (
            <ChartContainer config={chartConfig} className="h-[340px] w-full aspect-auto">
              <BarChart data={chartData} margin={{ left: 8, right: 8, top: 16, bottom: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="monthLabel"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={16}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={80}
                  tickFormatter={(value) => hideValues ? '' : `R$ ${formatMoney(value)}`}
                />
                <ChartTooltip
                  cursor={false}
                  content={<IncomeTooltip hideValues={hideValues} />}
                />
                {chartSegments.map((segment) => (
                  <Bar
                    key={segment.dataKey}
                    dataKey={segment.dataKey}
                    stackId="income"
                    fill={`var(--color-${segment.dataKey})`}
                    radius={[3, 3, 0, 0]}
                  />
                ))}
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <CardTitle className="text-base">Detalhamento mensal</CardTitle>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={effectiveTableYear} onValueChange={(value) => {
                setTableYear(value);
                const selected = yearOptions.find((option) => String(option.year) === value);
                setTableMonth(String(selected?.months?.[0] || ''));
              }}>
                <SelectTrigger className="w-full sm:w-[120px]" aria-label="Ano">
                  <SelectValue placeholder="Ano" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {yearOptions.map((option) => (
                      <SelectItem key={option.year} value={String(option.year)}>{option.year}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Select value={effectiveTableMonth} onValueChange={setTableMonth}>
                <SelectTrigger className="w-full sm:w-[140px]" aria-label="Mês">
                  <SelectValue placeholder="Mês" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {monthOptions.map((month) => (
                      <SelectItem key={month} value={String(month)}>{String(month).padStart(2, '0')}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
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
              Nenhum provento encontrado para o mês selecionado.
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <SortableHead sortKey="ticker" sort={sort} onSort={handleSort} className="w-[86px]">Ticker</SortableHead>
                    <SortableHead sortKey="asset_class" sort={sort} onSort={handleSort} className="w-[112px]">Classe</SortableHead>
                    <SortableHead sortKey="name" sort={sort} onSort={handleSort} className="w-[190px]">Nome</SortableHead>
                    <SortableHead sortKey="payment_date" sort={sort} onSort={handleSort} className="w-[118px]">Pagamento</SortableHead>
                    <SortableHead sortKey="event_type" sort={sort} onSort={handleSort} className="w-[210px]">Tipo</SortableHead>
                    <SortableHead sortKey="quantity" sort={sort} onSort={handleSort} className="w-[128px] text-right">Quantidade</SortableHead>
                    <SortableHead sortKey="net_value" sort={sort} onSort={handleSort} className="w-[132px] text-right">Valor líquido</SortableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="truncate whitespace-nowrap font-medium" title={row.ticker || '-'}>
                        {row.ticker || '-'}
                      </TableCell>
                      <TableCell className="truncate whitespace-nowrap text-muted-foreground" title={row.asset_class || '-'}>
                        {row.asset_class || '-'}
                      </TableCell>
                      <TableCell className="truncate text-muted-foreground" title={displayIncomeName(row) || '-'}>
                        {displayIncomeName(row) || '-'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(row.payment_date)}</TableCell>
                      <TableCell className="truncate whitespace-nowrap" title={row.event_type || '-'}>
                        {row.event_type || '-'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono text-sm">
                        {formatQuantity(row.quantity, row.asset_class, hideValues)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono text-sm">
                        R$ {formatMoney(row.net_value, hideValues)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-b-0 hover:bg-transparent">
                    <TableCell colSpan={7} className="h-auto p-0">
                      <Separator />
                    </TableCell>
                  </TableRow>
                  <TableRow className="border-b-0 hover:bg-transparent">
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell className="font-semibold">TOTAL</TableCell>
                    <TableCell></TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">
                      R$ {formatMoney(report?.table.total_net_value, hideValues)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
