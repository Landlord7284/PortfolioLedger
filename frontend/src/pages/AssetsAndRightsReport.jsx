import { useContext, useEffect, useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { AppContext } from '../App';
import { reports as reportsApi } from '../api/client';
import { formatCnpj, formatMoney, formatQuantity } from '@/lib/formatters';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const currentYear = new Date().getFullYear();

function formatCutoff(date) {
  if (!date) return '';
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

function markedStorageKey(portfolioId, year) {
  return `assetsAndRights:marked:${portfolioId || 'none'}:${year}`;
}

function loadMarkedAssets(portfolioId, year) {
  try {
    const raw = localStorage.getItem(markedStorageKey(portfolioId, year));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveMarkedAssets(portfolioId, year, markedAssets) {
  localStorage.setItem(markedStorageKey(portfolioId, year), JSON.stringify([...markedAssets]));
}

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function AssetsAndRightsReport() {
  const { activePortfolioId, portfolioList, hideValues } = useContext(AppContext);
  const [year, setYear] = useState(String(currentYear));
  const [report, setReport] = useState(null);
  const [filterClass, setFilterClass] = useState('');
  const [markedState, setMarkedState] = useState(() => ({
    key: markedStorageKey(activePortfolioId, currentYear),
    assets: loadMarkedAssets(activePortfolioId, currentYear),
  }));
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const activePortfolio = portfolioList.find((portfolio) => portfolio.id === activePortfolioId);
  const currentMarkedKey = markedStorageKey(activePortfolioId, year);
  const markedAssets = markedState.key === currentMarkedKey ? markedState.assets : loadMarkedAssets(activePortfolioId, year);
  const yearOptions = useMemo(() => {
    return Array.from({ length: 8 }, (_, index) => String(currentYear - index));
  }, []);

  useEffect(() => {
    if (!activePortfolioId) {
      return;
    }

    let active = true;
    async function loadReport() {
      setLoading(true);
      try {
        const data = await reportsApi.assetsAndRights({ portfolioId: activePortfolioId, year });
        if (active) setReport(data);
      } catch (err) {
        if (active) {
          setReport(null);
          toast.error(err.message || 'Falha ao carregar Bens e Direitos.');
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    loadReport();
    return () => {
      active = false;
    };
  }, [activePortfolioId, year]);

  const toggleMarked = (assetId) => {
    setMarkedState(() => {
      const next = new Set(markedAssets);
      if (next.has(assetId)) {
        next.delete(assetId);
      } else {
        next.add(assetId);
      }
      saveMarkedAssets(activePortfolioId, year, next);
      return {
        key: currentMarkedKey,
        assets: next,
      };
    });
  };

  const exportXlsx = async () => {
    if (!activePortfolioId) return;
    setExporting(true);
    try {
      const { blob, filename } = await reportsApi.fiscalExportXlsx({ portfolioId: activePortfolioId, year });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err.message || 'Falha ao exportar XLSX.');
    } finally {
      setExporting(false);
    }
  };

  const rows = useMemo(() => report?.rows || [], [report]);
  const classes = useMemo(() => [...new Set(rows.map((row) => row.asset_class).filter(Boolean))].sort(), [rows]);
  const visibleRows = useMemo(() => {
    if (!filterClass) return rows;
    return rows.filter((row) => row.asset_class === filterClass);
  }, [rows, filterClass]);
  const visibleTotals = useMemo(() => {
    return visibleRows.reduce(
      (totals, row) => ({
        previousYearCost: totals.previousYearCost + toNumber(row.previous_year_cost),
        currentYearCost: totals.currentYearCost + toNumber(row.current_year_cost),
      }),
      { previousYearCost: 0, currentYearCost: 0 }
    );
  }, [visibleRows]);
  const fiscalDelta = visibleTotals.currentYearCost - visibleTotals.previousYearCost;

  useEffect(() => {
    if (filterClass && !classes.includes(filterClass)) {
      setFilterClass('');
    }
  }, [classes, filterClass]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bens e Direitos</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {activePortfolio?.name || 'Carteira ativa'} · Ano calendário {year}
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger className="w-full sm:w-[150px]" aria-label="Ano calendário">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {yearOptions.map((option) => (
                <SelectItem key={option} value={option}>{option}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={exportXlsx} disabled={!activePortfolioId || exporting || loading}>
            {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Exportar XLSX
          </Button>
        </div>
      </div>

      {classes.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground mr-1">Filtrar:</span>
          <Button
            variant={!filterClass ? 'default' : 'outline'}
            size="xs"
            onClick={() => setFilterClass('')}
          >
            Todos
          </Button>
          {classes.map((assetClass) => (
            <Button
              key={assetClass}
              variant={filterClass === assetClass ? 'default' : 'outline'}
              size="xs"
              onClick={() => setFilterClass(assetClass)}
            >
              {assetClass}
            </Button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Posição fiscal em {formatCutoff(report?.previous_cutoff)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-2xl font-semibold tabular-nums">
              {formatMoney(visibleTotals.previousYearCost, hideValues)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Posição fiscal em {formatCutoff(report?.current_cutoff)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-2xl font-semibold tabular-nums">
              {formatMoney(visibleTotals.currentYearCost, hideValues)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Variação fiscal em BRL
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`font-mono text-2xl font-semibold tabular-nums ${!hideValues && fiscalDelta > 0 ? 'text-emerald-500' : !hideValues && fiscalDelta < 0 ? 'text-red-500' : ''}`}>
              {formatMoney(fiscalDelta, hideValues)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="text-base">
            Posição final em {formatCutoff(report?.previous_cutoff)} e {formatCutoff(report?.current_cutoff)}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex min-h-[260px] items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span className="text-sm">Carregando relatório...</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex min-h-[260px] items-center justify-center text-center text-sm text-muted-foreground">
              Nenhuma posição encontrada para o ano selecionado.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>Ticker</TableHead>
                    <TableHead>Classe</TableHead>
                    <TableHead className="text-right">Quantidade</TableHead>
                    <TableHead>Nome Ação/FII</TableHead>
                    <TableHead>CNPJ</TableHead>
                    <TableHead className="text-right">Situação em {formatCutoff(report?.previous_cutoff)}</TableHead>
                    <TableHead className="text-right">Situação em {formatCutoff(report?.current_cutoff)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map((row) => {
                    const marked = markedAssets.has(row.asset_id);
                    return (
                      <TableRow key={row.asset_id} className={marked ? 'opacity-45' : ''}>
                        <TableCell>
                          <Checkbox
                            checked={marked}
                            onCheckedChange={() => toggleMarked(row.asset_id)}
                            aria-label={`Marcar ${row.ticker || row.asset_id}`}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{row.ticker || '-'}</TableCell>
                        <TableCell className="text-muted-foreground">{row.asset_class}</TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatQuantity(row.quantity, row.asset_class, hideValues)}
                        </TableCell>
                        <TableCell className="min-w-[180px]">{row.name || '-'}</TableCell>
                        <TableCell className="font-mono text-sm text-muted-foreground">{formatCnpj(row.cnpj) || '-'}</TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatMoney(row.previous_year_cost, hideValues)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatMoney(row.current_year_cost, hideValues)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow className="border-b-0 hover:bg-transparent">
                    <TableCell colSpan={8} className="h-auto p-0">
                      <Separator />
                    </TableCell>
                  </TableRow>
                  <TableRow className="border-b-0 hover:bg-transparent">
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell className="font-semibold">TOTAL</TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">
                      {formatMoney(visibleTotals.previousYearCost, hideValues)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">
                      {formatMoney(visibleTotals.currentYearCost, hideValues)}
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
