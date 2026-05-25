import { Fragment, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, Edit2, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { AppContext } from '../App';
import { reports as reportsApi, tax as taxApi } from '../api/client';
import { applyCurrencyMask, currencyToBackend, formatMoney } from '@/lib/formatters';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const currentYear = new Date().getFullYear();
const ALL = 'all';
const IRRF_REGIMES = new Set(['B3_COMMON_15', 'B3_FII_FIAGRO_20']);

const MONTHS = [
  { value: '1', label: 'Jan' },
  { value: '2', label: 'Fev' },
  { value: '3', label: 'Mar' },
  { value: '4', label: 'Abr' },
  { value: '5', label: 'Mai' },
  { value: '6', label: 'Jun' },
  { value: '7', label: 'Jul' },
  { value: '8', label: 'Ago' },
  { value: '9', label: 'Set' },
  { value: '10', label: 'Out' },
  { value: '11', label: 'Nov' },
  { value: '12', label: 'Dez' },
];

const REGIME_ORDER = ['B3_COMMON_15', 'B3_FII_FIAGRO_20', 'FI_INFRA_EXEMPT', 'CRYPTO_GCAP'];

const REGIME_LABELS = {
  B3_COMMON_15: 'B3 - Operações comuns 15%',
  B3_FII_FIAGRO_20: 'B3 - FII / Fiagro 20%',
  FI_INFRA_EXEMPT: 'FI-Infra / Isentos',
  CRYPTO_GCAP: 'Criptoativos',
};

const REGIME_DESCRIPTIONS = {
  B3_COMMON_15: 'A isenção de R$ 20.000 para Ação BR é exibida apenas quando apurada pelo backend.',
  B3_FII_FIAGRO_20: 'Apuração separada de FII e Fiagro, sem mistura com operações comuns.',
  FI_INFRA_EXEMPT: 'Bloco informativo/isento nesta fase.',
  CRYPTO_GCAP: 'Apuração informativa nesta fase.',
};

const TABLE_COLUMNS = {
  B3_COMMON_15: [
    ['gross_sale', 'Venda bruta'],
    ['net_sale', 'Venda líquida'],
    ['costs', 'Custos'],
    ['cost_basis', 'Custo baixado'],
    ['realized_result', 'Resultado líquido'],
    ['exempt_gain', 'Ganho isento'],
    ['taxable_result_before_compensation', 'Resultado tributável antes de compensação'],
    ['initial_loss_carryforward', 'Prejuízo inicial'],
    ['used_loss', 'Prejuízo usado'],
    ['taxable_base', 'Base tributável'],
    ['tax_rate', 'Alíquota', 'rate'],
    ['tax_due', 'Imposto'],
    ['theoretical_irrf', 'IRRF teórico'],
    ['effective_irrf', 'IRRF efetivo'],
    ['darf_estimated', 'DARF estimado'],
    ['final_loss_carryforward', 'Prejuízo final'],
  ],
  B3_FII_FIAGRO_20: [
    ['gross_sale', 'Venda bruta'],
    ['net_sale', 'Venda líquida'],
    ['costs', 'Custos'],
    ['cost_basis', 'Custo baixado'],
    ['realized_result', 'Resultado líquido'],
    ['initial_loss_carryforward', 'Prejuízo inicial'],
    ['used_loss', 'Prejuízo usado'],
    ['taxable_base', 'Base tributável'],
    ['tax_rate', 'Alíquota', 'rate'],
    ['tax_due', 'Imposto'],
    ['theoretical_irrf', 'IRRF teórico'],
    ['effective_irrf', 'IRRF efetivo'],
    ['darf_estimated', 'DARF estimado'],
    ['final_loss_carryforward', 'Prejuízo final'],
  ],
  FI_INFRA_EXEMPT: [
    ['gross_sale', 'Venda bruta'],
    ['net_sale', 'Venda líquida'],
    ['costs', 'Custos'],
    ['cost_basis', 'Custo baixado'],
    ['realized_result', 'Resultado econômico'],
    ['exempt_gain', 'Ganho isento'],
    ['effective_irrf', 'IRRF efetivo'],
    ['darf_estimated', 'DARF estimado'],
    ['final_loss_carryforward', 'Prejuízo final'],
  ],
  CRYPTO_GCAP: [
    ['gross_sale', 'Venda bruta'],
    ['net_sale', 'Venda líquida'],
    ['costs', 'Custos'],
    ['cost_basis', 'Custo baixado'],
    ['realized_result', 'Resultado líquido'],
    ['final_loss_carryforward', 'Prejuízo acumulado informativo'],
    ['darf_estimated', 'DARF estimado'],
  ],
};

const ASSET_COLUMNS = [
  ['ticker', 'Ativo', 'text'],
  ['asset_class', 'Classe', 'text'],
  ['fiscal_regime', 'Regime fiscal', 'regime'],
  ['gross_sale', 'Venda bruta'],
  ['net_sale', 'Venda líquida'],
  ['costs', 'Custos'],
  ['cost_basis', 'Custo baixado'],
  ['realized_result', 'Resultado líquido'],
  ['exempt_gain', 'Ganho isento'],
  ['taxable_result_before_compensation', 'Resultado tributável antes de compensação'],
  ['theoretical_irrf', 'IRRF teórico'],
  ['effective_irrf', 'IRRF efetivo'],
];

function overrideKey(yearMonth, regime) {
  return `${yearMonth}|${regime}`;
}

function monthLabel(month) {
  return MONTHS.find((item) => item.value === String(month))?.label || String(month).padStart(2, '0');
}

function decimalToCents(value) {
  const raw = String(value ?? '0').trim();
  if (!raw) return 0n;
  const normalized = raw.replace(',', '.');
  const sign = normalized.startsWith('-') ? -1n : 1n;
  const unsigned = normalized.replace(/^[+-]/, '');
  const [wholeRaw = '0', fractionRaw = ''] = unsigned.split('.');
  const whole = BigInt(wholeRaw.replace(/\D/g, '') || '0');
  const fraction = `${fractionRaw.replace(/\D/g, '')}000`;
  const twoDigits = fraction.slice(0, 2);
  const roundingDigit = Number(fraction[2] || '0');
  let cents = BigInt(twoDigits || '0');
  if (roundingDigit >= 5) cents += 1n;
  return sign * ((whole * 100n) + cents);
}

function centsToMoneyString(cents) {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const whole = abs / 100n;
  const fraction = String(abs % 100n).padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

function addMoney(rows, field) {
  return rows.reduce((total, row) => total + decimalToCents(row[field]), 0n);
}

function moneyEquals(a, b) {
  return decimalToCents(a) === decimalToCents(b);
}

function moneyGreaterThanZero(value) {
  return decimalToCents(value) > 0n;
}

function formatRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return `${(number * 100).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
}

function formatCellValue(row, column, hideValues) {
  const [field, , type] = column;
  if (type === 'rate') return formatRate(row[field]);
  if (type === 'text') return row[field] || '-';
  if (type === 'regime') return REGIME_LABELS[row[field]] || row[field] || '-';
  return `R$ ${formatMoney(row[field], hideValues)}`;
}

function backendMoneyToInput(value) {
  const cents = decimalToCents(value);
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const whole = abs / 100n;
  const fraction = String(abs % 100n).padStart(2, '0');
  return `${sign}${whole.toLocaleString('pt-BR')},${fraction}`;
}

function getReportOverride(row) {
  if (row.irrf_override !== undefined && row.irrf_override !== null) return row.irrf_override;
  if (row.override?.effective_irrf !== undefined && row.override?.effective_irrf !== null) return row.override.effective_irrf;
  if (row.irrf?.override !== undefined && row.irrf?.override !== null) return row.irrf.override;
  return null;
}

function compareRegimes(a, b) {
  return REGIME_ORDER.indexOf(a) - REGIME_ORDER.indexOf(b);
}

function SummaryCard({ title, value, hideValues }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="font-mono text-2xl font-semibold tabular-nums">
          R$ {formatMoney(value, hideValues)}
        </div>
      </CardContent>
    </Card>
  );
}

function AssetRows({ assets, hideValues }) {
  return (
    <TableRow className="bg-muted/25 hover:bg-muted/25">
      <TableCell colSpan={20} className="p-0">
        <div className="overflow-x-auto p-3">
          <Table>
            <TableHeader>
              <TableRow>
                {ASSET_COLUMNS.map((column) => (
                  <TableHead key={column[0]} className={column[2] ? '' : 'text-right'}>
                    {column[1]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {assets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={ASSET_COLUMNS.length} className="h-16 text-center text-sm text-muted-foreground">
                    Nenhum ativo encontrado para os filtros atuais.
                  </TableCell>
                </TableRow>
              ) : (
                assets.map((asset) => (
                  <TableRow key={asset.asset_id}>
                    {ASSET_COLUMNS.map((column) => (
                      <TableCell key={column[0]} className={column[2] ? 'whitespace-nowrap' : 'text-right font-mono text-sm'}>
                        {formatCellValue(asset, column, hideValues)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </TableCell>
    </TableRow>
  );
}

function RegimeTable({
  regime,
  rows,
  expanded,
  hideValues,
  overridesByKey,
  onToggle,
  onEditIrrf,
}) {
  const columns = TABLE_COLUMNS[regime] || [];

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle className="text-base">{REGIME_LABELS[regime] || regime}</CardTitle>
            <CardDescription>{REGIME_DESCRIPTIONS[regime]}</CardDescription>
          </div>
          {(regime === 'FI_INFRA_EXEMPT' || regime === 'CRYPTO_GCAP') && (
            <Badge variant="secondary">Informativo</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10"></TableHead>
                <TableHead className="sticky left-0 bg-card">Mês</TableHead>
                {columns.map((column) => (
                  <TableHead key={column[0]} className="text-right">
                    {column[1]}
                  </TableHead>
                ))}
                {IRRF_REGIMES.has(regime) && <TableHead className="text-right">Ajuste</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const key = overrideKey(row.year_month, row.regime);
                const isExpanded = expanded.has(key);
                const overrideRecord = overridesByKey.get(key);
                const reportOverride = getReportOverride(row);
                const hasOverride = reportOverride !== null || !!overrideRecord;
                const hasIrrfDiff = !moneyEquals(row.theoretical_irrf, row.effective_irrf);
                const hasExemptGain = moneyGreaterThanZero(row.exempt_gain);

                return (
                  <Fragment key={key}>
                    <TableRow>
                      <TableCell>
                        <Button variant="ghost" size="icon-sm" onClick={() => onToggle(key)} aria-label="Expandir mês">
                          {isExpanded ? <ChevronDown /> : <ChevronRight />}
                        </Button>
                      </TableCell>
                      <TableCell className="sticky left-0 min-w-[120px] bg-card font-medium">
                        <div className="flex flex-col gap-1">
                          <span>{monthLabel(row.month)} / {row.year_month.slice(0, 4)}</span>
                          {hasExemptGain && <Badge variant="secondary">Ganho isento</Badge>}
                        </div>
                      </TableCell>
                      {columns.map((column) => (
                        <TableCell key={column[0]} className="text-right font-mono text-sm">
                          {formatCellValue(row, column, hideValues)}
                        </TableCell>
                      ))}
                      {IRRF_REGIMES.has(regime) && (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {hasOverride && <Badge variant="secondary">Ajustado</Badge>}
                            {!hasOverride && hasIrrfDiff && <Badge variant="outline">Difere</Badge>}
                            <Button variant="ghost" size="icon-sm" onClick={() => onEditIrrf(row, overrideRecord)}>
                              <Edit2 />
                              <span className="sr-only">Editar IRRF efetivo</span>
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                    {isExpanded && (
                      <AssetRows assets={row.assets || []} hideValues={hideValues} />
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function CapitalGainsReport() {
  const { activePortfolioId, portfolioList, hideValues } = useContext(AppContext);
  const [year, setYear] = useState(String(currentYear));
  const [report, setReport] = useState(null);
  const [overrides, setOverrides] = useState([]);
  const [loading, setLoading] = useState(false);
  const [monthFilter, setMonthFilter] = useState(ALL);
  const [regimeFilter, setRegimeFilter] = useState(ALL);
  const [classFilter, setClassFilter] = useState(ALL);
  const [assetFilter, setAssetFilter] = useState(ALL);
  const [expanded, setExpanded] = useState(new Set());
  const [irrfDialog, setIrrfDialog] = useState(null);
  const [savingIrrf, setSavingIrrf] = useState(false);

  const activePortfolio = portfolioList.find((portfolio) => portfolio.id === activePortfolioId);
  const yearOptions = useMemo(() => Array.from({ length: 8 }, (_, index) => String(currentYear - index)), []);

  const loadReport = useCallback(async () => {
    if (!activePortfolioId) {
      setReport(null);
      setOverrides([]);
      return;
    }

    setLoading(true);
    try {
      const [reportData, overrideData] = await Promise.all([
        reportsApi.capitalGains({ portfolioId: activePortfolioId, year }),
        taxApi.irrfOverrides({ portfolioId: activePortfolioId, year }),
      ]);
      setReport(reportData);
      setOverrides(overrideData);
    } catch (err) {
      setReport(null);
      setOverrides([]);
      toast.error(err.message || 'Falha ao carregar Ganho de Capital.');
    } finally {
      setLoading(false);
    }
  }, [activePortfolioId, year]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      loadReport();
    }, 0);
    return () => window.clearTimeout(id);
  }, [loadReport]);

  const overridesByKey = useMemo(() => {
    return new Map(overrides.map((override) => [overrideKey(override.year_month, override.regime), override]));
  }, [overrides]);

  const rows = useMemo(() => {
    return (report?.months || []).flatMap((month) => {
      return (month.regimes || [])
        .filter((row) => REGIME_ORDER.includes(row.regime))
        .map((row) => ({
          ...row,
          year_month: month.year_month,
          month: month.month,
          assets: row.assets || [],
        }));
    });
  }, [report]);

  const classOptions = useMemo(() => {
    return [...new Set(rows.flatMap((row) => row.assets.map((asset) => asset.asset_class)).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
  }, [rows]);

  const effectiveClassFilter = classFilter !== ALL && classOptions.includes(classFilter) ? classFilter : ALL;

  const assetOptions = useMemo(() => {
    const assets = rows.flatMap((row) => row.assets)
      .filter((asset) => effectiveClassFilter === ALL || asset.asset_class === effectiveClassFilter);
    const byId = new Map();
    assets.forEach((asset) => {
      byId.set(String(asset.asset_id), asset);
    });
    return [...byId.values()].sort((a, b) => String(a.ticker || '').localeCompare(String(b.ticker || ''), 'pt-BR', { sensitivity: 'base' }));
  }, [rows, effectiveClassFilter]);

  const effectiveAssetFilter = assetFilter !== ALL && assetOptions.some((asset) => String(asset.asset_id) === assetFilter)
    ? assetFilter
    : ALL;

  const visibleRows = useMemo(() => {
    return rows
      .filter((row) => monthFilter === ALL || String(row.month) === monthFilter)
      .filter((row) => regimeFilter === ALL || row.regime === regimeFilter)
      .map((row) => {
        const filteredAssets = row.assets.filter((asset) => {
          if (effectiveClassFilter !== ALL && asset.asset_class !== effectiveClassFilter) return false;
          if (effectiveAssetFilter !== ALL && String(asset.asset_id) !== effectiveAssetFilter) return false;
          return true;
        });
        const assetFiltersActive = effectiveClassFilter !== ALL || effectiveAssetFilter !== ALL;
        return {
          ...row,
          assets: assetFiltersActive ? filteredAssets : row.assets,
          _matchesAssetFilter: !assetFiltersActive || filteredAssets.length > 0,
        };
      })
      .filter((row) => row._matchesAssetFilter)
      .sort((a, b) => a.year_month.localeCompare(b.year_month) || compareRegimes(a.regime, b.regime));
  }, [effectiveAssetFilter, effectiveClassFilter, monthFilter, regimeFilter, rows]);

  const groupedRows = useMemo(() => {
    return REGIME_ORDER.map((regime) => ({
      regime,
      rows: visibleRows.filter((row) => row.regime === regime),
    })).filter((group) => group.rows.length > 0);
  }, [visibleRows]);

  const finalLossBalance = useMemo(() => {
    const latestByRegime = new Map();
    visibleRows.forEach((row) => {
      const current = latestByRegime.get(row.regime);
      if (!current || row.year_month > current.year_month) {
        latestByRegime.set(row.regime, row);
      }
    });
    return [...latestByRegime.values()].reduce((total, row) => total + decimalToCents(row.final_loss_carryforward), 0n);
  }, [visibleRows]);

  const summary = useMemo(() => ({
    realizedResult: centsToMoneyString(addMoney(visibleRows, 'realized_result')),
    exemptGain: centsToMoneyString(addMoney(visibleRows, 'exempt_gain')),
    taxableBase: centsToMoneyString(addMoney(visibleRows, 'taxable_base')),
    taxDue: centsToMoneyString(addMoney(visibleRows, 'tax_due')),
    effectiveIrrf: centsToMoneyString(addMoney(visibleRows, 'effective_irrf')),
    darfEstimated: centsToMoneyString(addMoney(visibleRows, 'darf_estimated')),
    finalLoss: centsToMoneyString(finalLossBalance),
  }), [finalLossBalance, visibleRows]);

  const alerts = useMemo(() => {
    const result = [];
    const hasIrrfOverride = visibleRows.some((row) => getReportOverride(row) !== null || overridesByKey.has(overrideKey(row.year_month, row.regime)));
    const hasIrrfDiff = visibleRows.some((row) => !moneyEquals(row.theoretical_irrf, row.effective_irrf));
    if (hasIrrfOverride || hasIrrfDiff) result.push('IRRF efetivo diferente do teórico em pelo menos uma competência.');
    if (visibleRows.some((row) => moneyGreaterThanZero(row.darf_estimated))) result.push('Há DARF estimado maior que zero no período filtrado.');
    if (visibleRows.some((row) => row.regime === 'FI_INFRA_EXEMPT')) result.push('FI-Infra exibido como informativo/isento.');
    if (visibleRows.some((row) => row.regime === 'CRYPTO_GCAP')) result.push('Cripto exibido apenas como apuração informativa nesta fase.');
    return result;
  }, [overridesByKey, visibleRows]);

  const toggleExpanded = (key) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const resetFilters = () => {
    setMonthFilter(ALL);
    setRegimeFilter(ALL);
    setClassFilter(ALL);
    setAssetFilter(ALL);
  };

  const openIrrfDialog = (row, overrideRecord) => {
    setIrrfDialog({
      row,
      override: overrideRecord || null,
      value: backendMoneyToInput(row.effective_irrf),
      notes: overrideRecord?.notes || '',
    });
  };

  const saveIrrfOverride = async () => {
    if (!irrfDialog || !activePortfolioId) return;
    setSavingIrrf(true);
    try {
      await taxApi.upsertIrrfOverride({
        portfolio_id: activePortfolioId,
        year_month: irrfDialog.row.year_month,
        regime: irrfDialog.row.regime,
        effective_irrf: currencyToBackend(irrfDialog.value),
        notes: irrfDialog.notes || null,
      });
      toast.success('IRRF efetivo ajustado.');
      setIrrfDialog(null);
      await loadReport();
    } catch (err) {
      toast.error(err.message || 'Falha ao salvar ajuste de IRRF.');
    } finally {
      setSavingIrrf(false);
    }
  };

  const deleteIrrfOverride = async () => {
    if (!irrfDialog?.override?.id) return;
    setSavingIrrf(true);
    try {
      await taxApi.deleteIrrfOverride(irrfDialog.override.id);
      toast.success('Ajuste de IRRF removido.');
      setIrrfDialog(null);
      await loadReport();
    } catch (err) {
      toast.error(err.message || 'Falha ao remover ajuste de IRRF.');
    } finally {
      setSavingIrrf(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ganho de Capital</h1>
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
              <SelectGroup>
                {yearOptions.map((option) => (
                  <SelectItem key={option} value={option}>{option}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Mês</Label>
              <Select value={monthFilter} onValueChange={setMonthFilter}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={ALL}>Todos</SelectItem>
                    {MONTHS.map((month) => <SelectItem key={month.value} value={month.value}>{month.label}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Regime fiscal</Label>
              <Select value={regimeFilter} onValueChange={setRegimeFilter}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={ALL}>Todos</SelectItem>
                    {REGIME_ORDER.map((regime) => (
                      <SelectItem key={regime} value={regime}>{REGIME_LABELS[regime]}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Classe</Label>
              <Select value={effectiveClassFilter} onValueChange={(value) => { setClassFilter(value); setAssetFilter(ALL); }}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={ALL}>Todas</SelectItem>
                    {classOptions.map((assetClass) => <SelectItem key={assetClass} value={assetClass}>{assetClass}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Ativo</Label>
              <Select value={effectiveAssetFilter} onValueChange={setAssetFilter}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={ALL}>Todos</SelectItem>
                    {assetOptions.map((asset) => (
                      <SelectItem key={asset.asset_id} value={String(asset.asset_id)}>
                        {asset.ticker || `Ativo #${asset.asset_id}`}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button variant="outline" className="w-full" onClick={resetFilters}>
                <RotateCcw data-icon="inline-start" />
                Limpar
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {alerts.length > 0 && (
        <div className="flex flex-col gap-2">
          {alerts.map((message) => (
            <Alert key={message}>
              <AlertCircle />
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard title="Resultado líquido realizado" value={summary.realizedResult} hideValues={hideValues} />
        <SummaryCard title="Ganhos isentos" value={summary.exemptGain} hideValues={hideValues} />
        <SummaryCard title="Base tributável" value={summary.taxableBase} hideValues={hideValues} />
        <SummaryCard title="Imposto calculado" value={summary.taxDue} hideValues={hideValues} />
        <SummaryCard title="IRRF efetivo considerado" value={summary.effectiveIrrf} hideValues={hideValues} />
        <SummaryCard title="DARF estimado" value={summary.darfEstimated} hideValues={hideValues} />
        <SummaryCard title="Prejuízo final a compensar" value={summary.finalLoss} hideValues={hideValues} />
      </div>

      {loading ? (
        <Card>
          <CardContent className="flex min-h-[260px] items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="animate-spin" />
            <span className="text-sm">Carregando relatório...</span>
          </CardContent>
        </Card>
      ) : groupedRows.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-[260px] items-center justify-center text-center text-sm text-muted-foreground">
            Nenhum ganho de capital encontrado para os filtros atuais.
          </CardContent>
        </Card>
      ) : (
        groupedRows.map((group) => (
          <RegimeTable
            key={group.regime}
            regime={group.regime}
            rows={group.rows}
            expanded={expanded}
            hideValues={hideValues}
            overridesByKey={overridesByKey}
            onToggle={toggleExpanded}
            onEditIrrf={openIrrfDialog}
          />
        ))
      )}

      <Dialog open={!!irrfDialog} onOpenChange={(open) => !open && !savingIrrf && setIrrfDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ajustar IRRF efetivo</DialogTitle>
            <DialogDescription>
              {irrfDialog ? `${monthLabel(irrfDialog.row.month)} / ${irrfDialog.row.year_month.slice(0, 4)} · ${REGIME_LABELS[irrfDialog.row.regime]}` : ''}
            </DialogDescription>
          </DialogHeader>
          {irrfDialog && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">IRRF teórico</Label>
                  <div className="mt-1 font-mono text-sm">R$ {formatMoney(irrfDialog.row.theoretical_irrf, hideValues)}</div>
                </div>
                <div>
                  <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">IRRF efetivo atual</Label>
                  <div className="mt-1 font-mono text-sm">R$ {formatMoney(irrfDialog.row.effective_irrf, hideValues)}</div>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="effective-irrf">IRRF efetivo considerado</Label>
                <Input
                  id="effective-irrf"
                  value={irrfDialog.value}
                  onChange={(event) => setIrrfDialog({ ...irrfDialog, value: applyCurrencyMask(event.target.value) })}
                  disabled={savingIrrf}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="irrf-notes">Observação</Label>
                <Input
                  id="irrf-notes"
                  value={irrfDialog.notes}
                  onChange={(event) => setIrrfDialog({ ...irrfDialog, notes: event.target.value })}
                  disabled={savingIrrf}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            {irrfDialog?.override?.id && (
              <Button variant="destructive" onClick={deleteIrrfOverride} disabled={savingIrrf}>
                <Trash2 data-icon="inline-start" />
                Remover
              </Button>
            )}
            <Button variant="outline" onClick={() => setIrrfDialog(null)} disabled={savingIrrf}>Cancelar</Button>
            <Button onClick={saveIrrfOverride} disabled={savingIrrf}>
              {savingIrrf ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
