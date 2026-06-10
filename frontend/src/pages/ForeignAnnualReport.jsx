import { useContext, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { AppContext } from '../App';
import { reports as reportsApi } from '../api/client';
import { useReportYearOptions } from '../hooks/useReportYearOptions';
import { formatMoney } from '@/lib/formatters';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const currentYear = new Date().getFullYear();

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPercent(value) {
  const parsed = Number(value) * 100;
  if (!Number.isFinite(parsed)) return '-';
  return `${parsed.toLocaleString('pt-BR', { maximumFractionDigits: 6 })}%`;
}

export default function ForeignAnnualReport() {
  const { activePortfolioId, portfolioList, hideValues } = useContext(AppContext);
  const [year, setYear] = useState(String(Math.max(2024, currentYear)));
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);

  const activePortfolio = portfolioList.find((portfolio) => portfolio.id === activePortfolioId);
  const yearOptions = useReportYearOptions(activePortfolioId, year, setYear);
  const foreignYearOptions = useMemo(() => {
    const filtered = yearOptions.filter((option) => Number(option) >= 2024);
    return filtered.length > 0 ? filtered : ['2024'];
  }, [yearOptions]);
  const rows = report?.rows || [];
  const initialLoss = toNumber(report?.initial_loss_carryforward);
  const finalBalance = toNumber(report?.final_balance);
  const consolidatedTaxDue = toNumber(report?.consolidated_tax_due);
  const lossCarryforward = toNumber(report?.loss_carryforward);
  const annualGainLoss = useMemo(() => rows.reduce((total, row) => total + toNumber(row.gain_loss), 0), [rows]);

  useEffect(() => {
    if (Number(year) < 2024) {
      setYear('2024');
      return;
    }
    if (!activePortfolioId) return;

    let active = true;
    async function loadReport() {
      setLoading(true);
      try {
        const data = await reportsApi.foreignAnnual({ portfolioId: activePortfolioId, year });
        if (active) setReport(data);
      } catch (err) {
        if (active) {
          setReport(null);
          toast.error(err.message || 'Falha ao carregar relatório de Exterior.');
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

  const reload = async () => {
    if (!activePortfolioId || Number(year) < 2024) return;
    setLoading(true);
    try {
      const data = await reportsApi.foreignAnnual({ portfolioId: activePortfolioId, year });
      setReport(data);
    } catch (err) {
      setReport(null);
      toast.error(err.message || 'Falha ao carregar relatório de Exterior.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Exterior</h1>
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
              {foreignYearOptions.map((option) => (
                <SelectItem key={option} value={option}>{option}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={reload} disabled={!activePortfolioId || loading}>
            {loading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
            Atualizar
          </Button>
        </div>
      </div>

      {report?.missing_ptax_dates?.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="shrink-0" />
          <AlertDescription>
            PTAX ausente para: {report.missing_ptax_dates.join(', ')}. Valores dessas datas não foram somados ao relatório.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Ganho/Prejuízo anual</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-2xl font-semibold tabular-nums">{formatMoney(annualGainLoss, hideValues)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Saldo final da base</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-2xl font-semibold tabular-nums">{formatMoney(finalBalance, hideValues)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Alíquota nacional</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-2xl font-semibold tabular-nums">{formatPercent(report?.tax_rate)}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="text-base">Apuração anual consolidada em BRL</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex min-h-[260px] items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="animate-spin" />
              <span className="text-sm">Carregando relatório...</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[260px]">Bem</TableHead>
                    <TableHead className="text-right">Ganho/Prejuízo</TableHead>
                    <TableHead className="text-right">Imposto Devido</TableHead>
                    <TableHead className="text-right">Imposto Pago no Exterior/Brasil</TableHead>
                    <TableHead className="text-right">Base de Cálculo</TableHead>
                    <TableHead className="text-right">Saldo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-medium">Prejuízo do ano anterior</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatMoney(0, hideValues)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatMoney(0, hideValues)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatMoney(0, hideValues)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatMoney(-initialLoss, hideValues)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatMoney(-initialLoss, hideValues)}</TableCell>
                  </TableRow>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">
                        Nenhum ativo ou rendimento no exterior encontrado para o ano selecionado.
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row) => (
                      <TableRow key={`${row.asset_id || row.ticker || row.bem}-${row.bem}`}>
                        <TableCell className="font-medium">{row.bem}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatMoney(row.gain_loss, hideValues)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatMoney(row.line_tax_due, hideValues)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatMoney(row.foreign_tax_paid, hideValues)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatMoney(row.taxable_base, hideValues)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatMoney(row.balance, hideValues)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fechamento anual</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border p-4">
            <p className="text-sm text-muted-foreground">Imposto devido consolidado do ano</p>
            <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">{formatMoney(consolidatedTaxDue, hideValues)}</p>
          </div>
          <div className="rounded-md border p-4">
            <p className="text-sm text-muted-foreground">Prejuízo/Base a compensar</p>
            <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">{formatMoney(lossCarryforward, hideValues)}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
