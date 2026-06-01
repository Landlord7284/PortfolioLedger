import { useContext, useEffect, useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { AppContext } from '../App';
import { reports as reportsApi } from '../api/client';
import { formatCnpj, formatMoney } from '@/lib/formatters';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const currentYear = new Date().getFullYear();

function markedStorageKey(portfolioId, year) {
  return `incomeReport:marked:${portfolioId || 'none'}:${year}`;
}

function loadMarkedRows(portfolioId, year) {
  try {
    const raw = localStorage.getItem(markedStorageKey(portfolioId, year));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveMarkedRows(portfolioId, year, markedRows) {
  localStorage.setItem(markedStorageKey(portfolioId, year), JSON.stringify([...markedRows]));
}

function compareIncomeRows(a, b) {
  const typeCompare = String(a.income_type || '').localeCompare(String(b.income_type || ''), 'pt-BR', { sensitivity: 'base' });
  if (typeCompare !== 0) return typeCompare;
  if (!a.ticker && b.ticker) return 1;
  if (a.ticker && !b.ticker) return -1;
  return String(a.ticker || '').localeCompare(String(b.ticker || ''), 'pt-BR', { sensitivity: 'base' });
}

function IncomeTable({ table, markedRows, onToggle, hideValues }) {
  const rows = useMemo(() => [...table.rows].sort(compareIncomeRows), [table.rows]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle className="text-base">{table.title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10"></TableHead>
                <TableHead>Ticker</TableHead>
                <TableHead>CNPJ da Fonte Pagadora</TableHead>
                <TableHead>Nome da Fonte Pagadora</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">
                    Nenhum rendimento encontrado para esta tabela.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => {
                  const marked = markedRows.has(row.id);
                  return (
                    <TableRow key={row.id} className={marked ? 'opacity-45' : ''}>
                      <TableCell>
                        <Checkbox
                          checked={marked}
                          onCheckedChange={() => onToggle(row.id)}
                          aria-label={`Marcar ${row.ticker || row.income_type}`}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{row.ticker || '-'}</TableCell>
                      <TableCell className="font-mono text-sm text-muted-foreground">{formatCnpj(row.payer_cnpj) || '-'}</TableCell>
                      <TableCell className="min-w-[240px]">{row.payer_name || '-'}</TableCell>
                      <TableCell className="text-muted-foreground">{row.income_type}</TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {formatMoney(row.value, hideValues)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
              <TableRow className="border-b-0 hover:bg-transparent">
                <TableCell colSpan={6} className="h-auto p-0">
                  <Separator />
                </TableCell>
              </TableRow>
              <TableRow className="border-b-0 hover:bg-transparent">
                <TableCell></TableCell>
                <TableCell></TableCell>
                <TableCell></TableCell>
                <TableCell></TableCell>
                <TableCell className="font-semibold">TOTAL</TableCell>
                <TableCell className="text-right font-mono text-sm font-semibold">
                  {formatMoney(table.total, hideValues)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function IncomeReport() {
  const { activePortfolioId, portfolioList, hideValues } = useContext(AppContext);
  const [year, setYear] = useState(String(currentYear));
  const [report, setReport] = useState(null);
  const [markedState, setMarkedState] = useState(() => ({
    key: markedStorageKey(activePortfolioId, currentYear),
    rows: loadMarkedRows(activePortfolioId, currentYear),
  }));
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const activePortfolio = portfolioList.find((portfolio) => portfolio.id === activePortfolioId);
  const currentMarkedKey = markedStorageKey(activePortfolioId, year);
  const markedRows = markedState.key === currentMarkedKey ? markedState.rows : loadMarkedRows(activePortfolioId, year);
  const yearOptions = useMemo(() => Array.from({ length: 8 }, (_, index) => String(currentYear - index)), []);
  const tables = report?.tables || [];
  const totalIncome = tables.reduce((total, table) => total + Number(table.total || 0), 0);

  useEffect(() => {
    if (!activePortfolioId) return;

    let active = true;
    async function loadReport() {
      setLoading(true);
      try {
        const data = await reportsApi.income({ portfolioId: activePortfolioId, year });
        if (active) setReport(data);
      } catch (err) {
        if (active) {
          setReport(null);
          toast.error(err.message || 'Falha ao carregar Rendimentos.');
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

  const toggleMarked = (rowId) => {
    setMarkedState(() => {
      const next = new Set(markedRows);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      saveMarkedRows(activePortfolioId, year, next);
      return {
        key: currentMarkedKey,
        rows: next,
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rendimentos</h1>
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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Total anual
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-2xl font-semibold tabular-nums">
              {formatMoney(totalIncome, hideValues)}
            </div>
          </CardContent>
        </Card>
      </div>

      {loading ? (
        <Card>
          <CardContent className="flex min-h-[260px] items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-sm">Carregando relatório...</span>
          </CardContent>
        </Card>
      ) : tables.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-[260px] items-center justify-center text-center text-sm text-muted-foreground">
            Nenhum rendimento encontrado para o ano selecionado.
          </CardContent>
        </Card>
      ) : (
        tables.map((table) => (
          <IncomeTable
            key={table.key}
            table={table}
            markedRows={markedRows}
            onToggle={toggleMarked}
            hideValues={hideValues}
          />
        ))
      )}
    </div>
  );
}
