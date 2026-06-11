import { Fragment, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, Download, Edit2, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { AppContext } from '../App';
import { reports as reportsApi, tax as taxApi } from '../api/client';
import { useReportYearOptions } from '../hooks/useReportYearOptions';
import { applyCurrencyMask, currencyToBackend, formatMoney } from '@/lib/formatters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const currentYear = new Date().getFullYear();
const REGIME_B3_COMMON = 'B3_COMMON_15';
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

const REPORT_TABS = [
  { value: 'acoes', label: 'Ações', regime: 'B3_COMMON_15' },
  { value: 'fii', label: 'FII', regime: 'B3_FII_FIAGRO_20' },
  { value: 'fi-infra', label: 'FI-INFRA', regime: 'FI_INFRA_EXEMPT' },
];

const DEFAULT_REPORT_TAB = REPORT_TABS[0].value;

const REGIME_LABELS = {
  B3_COMMON_15: 'B3 - Operações Comuns',
  B3_FII_FIAGRO_20: 'B3 - FII / Fiagro',
  FI_INFRA_EXEMPT: 'FI-INFRA',
  CRYPTO_GCAP: 'Criptoativos',
};

const REGIME_DESCRIPTIONS = {
  B3_COMMON_15: 'Apuração de Ações, BDR e ETF. Alíquota de 15%.',
  B3_FII_FIAGRO_20: 'Apuração de FII e Fiagro. Alíquota de 20%.',
  FI_INFRA_EXEMPT: 'Apuração de FI-Infra conforme parâmetro fiscal vigente.',
  CRYPTO_GCAP: 'Apuração informativa nesta fase.',
};

const TABLE_COLUMNS = {
  B3_COMMON_15: [
    ['gross_sale', 'Venda'],
    ['realized_result', 'Resultado'],
    ['exempt_gain', 'Ganho Isento'],
    ['taxable_base', 'Base Tributável'],
    ['theoretical_irrf', 'IRRF Nota'],
    ['effective_irrf', 'IRRF Efetivo'],
    ['used_irrf', 'IRRF Usado'],
    ['net_tax_payable', 'Imposto'],
    ['final_loss_carryforward', 'Prejuízo Ac.'],
  ],
  B3_FII_FIAGRO_20: [
    ['gross_sale', 'Venda'],
    ['realized_result', 'Resultado'],
    ['taxable_base', 'Base Tributável'],
    ['theoretical_irrf', 'IRRF Nota'],
    ['effective_irrf', 'IRRF Efetivo'],
    ['used_irrf', 'IRRF Usado'],
    ['net_tax_payable', 'Imposto'],
    ['final_loss_carryforward', 'Prejuízo Ac.'],
  ],
  FI_INFRA_EXEMPT: [
    ['gross_sale', 'Venda'],
    ['realized_result', 'Resultado'],
    ['exempt_gain', 'Ganho Isento'],
    ['effective_irrf', 'IRRF Efetivo'],
    ['final_loss_carryforward', 'Prejuízo Ac.'],
  ],
  CRYPTO_GCAP: [
    ['gross_sale', 'Venda'],
    ['realized_result', 'Resultado'],
    ['final_loss_carryforward', 'Prejuízo acumulado informativo'],
  ],
};

const ASSET_COLUMNS = [
  ['ticker', 'Ativo', 'text'],
  ['asset_class', 'Classe', 'text'],
  ['fiscal_regime', 'Regime Fiscal', 'regime'],
  ['gross_sale', 'Venda Bruta'],
  ['realized_result', 'Resultado Líquido'],
  ['exempt_gain', 'Ganho Isento'],
  ['theoretical_irrf', 'IRRF Nota'],
  ['effective_irrf', 'IRRF Efetivo'],
];

const ASSET_COLUMNS_BY_REGIME = {
  B3_FII_FIAGRO_20: ASSET_COLUMNS.filter(([field]) => field !== 'exempt_gain'),
};

function getAssetColumns(regime) {
  return ASSET_COLUMNS_BY_REGIME[regime] || ASSET_COLUMNS;
}

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
  if (type === 'text') return row.is_manual && field === 'ticker' ? `${row[field] || '-'} (manual)` : row[field] || '-';
  if (type === 'regime') return REGIME_LABELS[row[field]] || row[field] || '-';
  return formatMoney(row[field], hideValues);
}

function backendMoneyToInput(value) {
  const cents = decimalToCents(value);
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const whole = abs / 100n;
  const fraction = String(abs % 100n).padStart(2, '0');
  return `${sign}${whole.toLocaleString('pt-BR')},${fraction}`;
}

function applySignedCurrencyMask(value) {
  const isNegative = String(value).includes('-');
  const masked = applyCurrencyMask(String(value).replace(/-/g, ''));
  if (!masked || decimalToCents(currencyToBackend(masked)) === 0n) return masked;
  return isNegative ? `-${masked}` : masked;
}

function newManualEventDraft() {
  return {
    clientId: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    id: null,
    ticker: '',
    gross_sale: '0,00',
    realized_result: '0,00',
    _deleted: false,
  };
}

function isBlankManualEventDraft(event) {
  return !String(event.ticker || '').trim()
    && decimalToCents(currencyToBackend(event.gross_sale)) === 0n
    && decimalToCents(currencyToBackend(event.realized_result)) === 0n;
}

function emptyRegimeRow({ year, month, regime = REGIME_B3_COMMON }) {
  const monthValue = String(month).padStart(2, '0');
  return {
    year_month: `${year}-${monthValue}`,
    month: Number(month),
    regime,
    bucket: null,
    darf_code: null,
    gross_sale: '0.00',
    net_sale: '0.00',
    costs: '0.00',
    cost_basis: '0.00',
    realized_result: '0.00',
    exempt_gain: '0.00',
    taxable_result_before_compensation: '0.00',
    initial_loss_carryforward: '0.00',
    used_loss: '0.00',
    taxable_base: '0.00',
    tax_rate: '0',
    tax_due: '0.00',
    theoretical_irrf: '0.00',
    irrf_override: null,
    effective_irrf: '0.00',
    calculated_net_tax_payable: '0.00',
    manual_tax_paid: null,
    minimum_darf_amount: '0.00',
    initial_darf_carryforward: '0.00',
    darf_before_minimum: '0.00',
    darf_estimated: '0.00',
    final_darf_carryforward: '0.00',
    initial_irrf_carryforward: '0.00',
    used_irrf: '0.00',
    net_tax_payable: '0.00',
    final_irrf_carryforward: '0.00',
    final_loss_carryforward: '0.00',
    assets: [],
  };
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

function hasManualTaxPaid(row) {
  return row?.manual_tax_paid !== null && row?.manual_tax_paid !== undefined && moneyGreaterThanZero(row.manual_tax_paid);
}

function hasManualTaxPaidDifferentFromCalculated(row) {
  return hasManualTaxPaid(row) && !moneyEquals(row.manual_tax_paid, row.calculated_net_tax_payable);
}

function SummaryCard({ title, value, hideValues, action }) {
  return (
    <Card size="sm" className="gap-2">
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-1">
        <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="pt-0">
        <div className="font-mono text-xl font-semibold tabular-nums">
          {formatMoney(value, hideValues)}
        </div>
      </CardContent>
    </Card>
  );
}

function AssetRows({ assets, hideValues, colSpan, regime }) {
  const columns = getAssetColumns(regime);

  return (
    <TableRow className="bg-muted/25 hover:bg-muted/25">
      <TableCell colSpan={colSpan} className="p-0">
        <div className="overflow-x-auto p-3">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((column) => (
                  <TableHead key={column[0]} className={column[2] ? '' : 'text-right'}>
                    {column[1]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {assets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-16 text-center text-sm text-muted-foreground">
                    Nenhum ativo encontrado para os filtros atuais.
                  </TableCell>
                </TableRow>
              ) : (
                assets.map((asset) => (
                  <TableRow key={asset.asset_id}>
                    {columns.map((column) => (
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
  taxPaidOverridesByKey,
  manualEventsByKey,
  onToggle,
  onEditIrrf,
  onAddManualRights,
}) {
  const columns = TABLE_COLUMNS[regime] || [];
  const expandedColSpan = columns.length + 2 + (IRRF_REGIMES.has(regime) ? 1 : 0);
  const canAddManualRights = regime === REGIME_B3_COMMON;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle className="text-base">{REGIME_LABELS[regime] || regime}</CardTitle>
            <CardDescription>{REGIME_DESCRIPTIONS[regime]}</CardDescription>
          </div>
          {canAddManualRights ? (
            <Button variant="outline" size="sm" onClick={onAddManualRights}>
              <Plus data-icon="inline-start" />
              Venda de Direitos
            </Button>
          ) : (regime === 'FI_INFRA_EXEMPT' || regime === 'CRYPTO_GCAP') && (
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
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={expandedColSpan} className="h-20 text-center text-sm text-muted-foreground">
                    {canAddManualRights
                      ? 'Nenhum mês com apuração automática. Use Venda de Direitos para cadastrar um evento manual.'
                      : 'Nenhuma apuração encontrada para este regime no ano selecionado.'}
                  </TableCell>
                </TableRow>
              ) : rows.map((row) => {
                const key = overrideKey(row.year_month, row.regime);
                const isExpanded = expanded.has(key);
                const overrideRecord = overridesByKey.get(key);
                const taxPaidOverride = taxPaidOverridesByKey.get(key);
                const manualEventRecords = manualEventsByKey.get(key) || [];
                const reportOverride = getReportOverride(row);
                const hasManualTax = row.manual_tax_paid !== null && row.manual_tax_paid !== undefined;
                const hasOverride = reportOverride !== null || !!overrideRecord || hasManualTax || manualEventRecords.length > 0;
                const hasIrrfDiff = !moneyEquals(row.theoretical_irrf, row.effective_irrf);

                return (
                  <Fragment key={key}>
                    <TableRow>
                      <TableCell>
                        <Button variant="ghost" size="icon-sm" onClick={() => onToggle(key)} aria-label="Expandir mês">
                          {isExpanded ? <ChevronDown /> : <ChevronRight />}
                        </Button>
                      </TableCell>
                      <TableCell className="sticky left-0 min-w-[120px] bg-card font-medium">
                        {monthLabel(row.month)} / {row.year_month.slice(0, 4)}
                      </TableCell>
                      {columns.map((column) => (
                        <TableCell key={column[0]} className="text-right font-mono text-sm">
                          {formatCellValue(row, column, hideValues)}
                        </TableCell>
                      ))}
                      {IRRF_REGIMES.has(regime) && (
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {hasOverride && (
                              <span
                                className="size-2 rounded-full bg-primary"
                                title="Ajustado"
                                aria-label="Ajustado"
                              />
                            )}
                            {!hasOverride && hasIrrfDiff && <Badge variant="outline">Difere</Badge>}
                            <Button variant="ghost" size="icon-sm" onClick={() => onEditIrrf(row, overrideRecord, taxPaidOverride, manualEventRecords)}>
                              <Edit2 />
                              <span className="sr-only">Editar ajuste de apuração</span>
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                    {isExpanded && (
                      <AssetRows assets={row.assets || []} hideValues={hideValues} colSpan={expandedColSpan} regime={regime} />
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

function DarfSuggestionsPopoverContent({ suggestions, hideValues, paymentConfirmationsByKey, rowsByKey, savingPaymentKeys, onTogglePayment }) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium">DARFs do ano</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Regimes com o mesmo código de receita são exibidos separadamente.
        </p>
      </div>
      {suggestions.length === 0 ? (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Nenhuma DARF estimada para o ano selecionado.
        </div>
      ) : (
        <div className="max-h-[min(60vh,28rem)] overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mês</TableHead>
                <TableHead>Código</TableHead>
                <TableHead>Regime</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-center">Pago</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suggestions.map((suggestion) => {
                const paymentKey = overrideKey(suggestion.year_month, suggestion.regime);
                const row = rowsByKey.get(paymentKey);
                const manualPaidDifferent = hasManualTaxPaidDifferentFromCalculated(row);
                const checked = !manualPaidDifferent && (hasManualTaxPaid(row) || paymentConfirmationsByKey.has(paymentKey));
                const disabled = savingPaymentKeys.has(paymentKey) || hasManualTaxPaid(row) || !moneyGreaterThanZero(suggestion.darf_estimated);

                return (
                  <TableRow key={`${suggestion.year_month}|${suggestion.darf_code}|${suggestion.regime || (suggestion.included_regimes || []).join('|')}`}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {monthLabel(suggestion.month)} / {suggestion.year_month.slice(0, 4)}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{suggestion.darf_code}</TableCell>
                    <TableCell className="min-w-40 text-sm">
                      {REGIME_LABELS[suggestion.regime] || suggestion.regime || (suggestion.included_regimes || [])
                        .map((regime) => REGIME_LABELS[regime] || regime)
                        .join(', ')}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatMoney(suggestion.darf_estimated, hideValues)}
                    </TableCell>
                    <TableCell className="text-center">
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={() => onTogglePayment(suggestion)}
                        aria-label={`Confirmar pagamento do DARF de ${monthLabel(suggestion.month)} / ${suggestion.year_month.slice(0, 4)}`}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default function CapitalGainsReport() {
  const { activePortfolioId, portfolioList, hideValues } = useContext(AppContext);
  const [year, setYear] = useState(String(currentYear));
  const [report, setReport] = useState(null);
  const [overrides, setOverrides] = useState([]);
  const [taxPaidOverrides, setTaxPaidOverrides] = useState([]);
  const [darfPaymentConfirmations, setDarfPaymentConfirmations] = useState([]);
  const [manualEvents, setManualEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState(DEFAULT_REPORT_TAB);
  const [expanded, setExpanded] = useState(new Set());
  const [irrfDialog, setIrrfDialog] = useState(null);
  const [savingIrrf, setSavingIrrf] = useState(false);
  const [savingPaymentKeys, setSavingPaymentKeys] = useState(new Set());
  const [exporting, setExporting] = useState(false);

  const activePortfolio = portfolioList.find((portfolio) => portfolio.id === activePortfolioId);
  const yearOptions = useReportYearOptions(activePortfolioId, year, setYear);

  const loadReport = useCallback(async () => {
    if (!activePortfolioId) {
      setReport(null);
      setOverrides([]);
      setTaxPaidOverrides([]);
      setDarfPaymentConfirmations([]);
      setManualEvents([]);
      return;
    }

    setLoading(true);
    try {
      const [reportData, overrideData, taxPaidOverrideData, paymentConfirmationData, manualEventData] = await Promise.all([
        reportsApi.capitalGains({ portfolioId: activePortfolioId, year }),
        taxApi.irrfOverrides({ portfolioId: activePortfolioId, year }),
        taxApi.capitalGainTaxPaidOverrides({ portfolioId: activePortfolioId, year }),
        taxApi.capitalGainDarfPaymentConfirmations({ portfolioId: activePortfolioId, year }),
        taxApi.capitalGainManualEvents({ portfolioId: activePortfolioId, year }),
      ]);
      setReport(reportData);
      setOverrides(overrideData);
      setTaxPaidOverrides(taxPaidOverrideData);
      setDarfPaymentConfirmations(paymentConfirmationData);
      setManualEvents(manualEventData);
    } catch (err) {
      setReport(null);
      setOverrides([]);
      setTaxPaidOverrides([]);
      setDarfPaymentConfirmations([]);
      setManualEvents([]);
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

  const taxPaidOverridesByKey = useMemo(() => {
    return new Map(taxPaidOverrides.map((override) => [overrideKey(override.year_month, override.regime), override]));
  }, [taxPaidOverrides]);

  const darfPaymentConfirmationsByKey = useMemo(() => {
    return new Map(darfPaymentConfirmations.map((confirmation) => [overrideKey(confirmation.year_month, confirmation.regime), confirmation]));
  }, [darfPaymentConfirmations]);

  const manualEventsByKey = useMemo(() => {
    const byKey = new Map();
    manualEvents.forEach((event) => {
      const key = overrideKey(event.year_month, event.regime);
      const list = byKey.get(key) || [];
      list.push(event);
      byKey.set(key, list);
    });
    return byKey;
  }, [manualEvents]);

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

  const rowsByKey = useMemo(() => {
    return new Map(rows.map((row) => [overrideKey(row.year_month, row.regime), row]));
  }, [rows]);

  const darfSuggestions = useMemo(() => {
    return (report?.months || []).flatMap((month) => {
      return (month.darf_suggestions || []).map((suggestion) => ({
        ...suggestion,
        year_month: month.year_month,
        month: month.month,
      }));
    });
  }, [report]);

  const visibleRows = useMemo(() => {
    return [...rows]
      .sort((a, b) => a.year_month.localeCompare(b.year_month) || compareRegimes(a.regime, b.regime));
  }, [rows]);

  const activeTabConfig = useMemo(() => {
    return REPORT_TABS.find((tab) => tab.value === activeTab) || REPORT_TABS[0];
  }, [activeTab]);

  const activeRegimeRows = useMemo(() => {
    return visibleRows.filter((row) => row.regime === activeTabConfig.regime);
  }, [activeTabConfig.regime, visibleRows]);

  const visibleDarfSuggestions = useMemo(() => {
    return [...darfSuggestions]
      .sort((a, b) => a.year_month.localeCompare(b.year_month) || a.darf_code.localeCompare(b.darf_code) || compareRegimes(a.regime, b.regime));
  }, [darfSuggestions]);

  const hasPendingDarfPayment = useMemo(() => {
    return visibleDarfSuggestions.some((suggestion) => {
      if (!moneyGreaterThanZero(suggestion.darf_estimated)) return false;
      const key = overrideKey(suggestion.year_month, suggestion.regime);
      const row = rowsByKey.get(key);
      if (hasManualTaxPaid(row)) return false;
      return !darfPaymentConfirmationsByKey.has(key);
    });
  }, [darfPaymentConfirmationsByKey, rowsByKey, visibleDarfSuggestions]);

  const finalLossBalance = useMemo(() => {
    const latestByRegime = new Map();
    activeRegimeRows.forEach((row) => {
      const current = latestByRegime.get(row.regime);
      if (!current || row.year_month > current.year_month) {
        latestByRegime.set(row.regime, row);
      }
    });
    return [...latestByRegime.values()].reduce((total, row) => total + decimalToCents(row.final_loss_carryforward), 0n);
  }, [activeRegimeRows]);

  const finalIrrfBalance = useMemo(() => {
    const latestByRegime = new Map();
    activeRegimeRows.forEach((row) => {
      const current = latestByRegime.get(row.regime);
      if (!current || row.year_month > current.year_month) {
        latestByRegime.set(row.regime, row);
      }
    });
    return [...latestByRegime.values()].reduce((total, row) => total + decimalToCents(row.final_irrf_carryforward), 0n);
  }, [activeRegimeRows]);

  const summary = useMemo(() => ({
    realizedResult: centsToMoneyString(addMoney(activeRegimeRows, 'realized_result')),
    exemptGain: centsToMoneyString(addMoney(activeRegimeRows, 'exempt_gain')),
    finalIrrf: centsToMoneyString(finalIrrfBalance),
    darfEstimated: centsToMoneyString(addMoney(visibleDarfSuggestions, 'darf_estimated')),
    finalLoss: centsToMoneyString(finalLossBalance),
  }), [activeRegimeRows, finalIrrfBalance, finalLossBalance, visibleDarfSuggestions]);

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

  const toggleDarfPaymentConfirmation = async (suggestion) => {
    if (!activePortfolioId || !suggestion.regime) return;
    const key = overrideKey(suggestion.year_month, suggestion.regime);
    const existing = darfPaymentConfirmationsByKey.get(key);
    setSavingPaymentKeys((current) => new Set(current).add(key));
    try {
      if (existing) {
        await taxApi.deleteCapitalGainDarfPaymentConfirmation(existing.id);
        setDarfPaymentConfirmations((current) => current.filter((confirmation) => confirmation.id !== existing.id));
      } else {
        const created = await taxApi.upsertCapitalGainDarfPaymentConfirmation({
          portfolio_id: activePortfolioId,
          year_month: suggestion.year_month,
          regime: suggestion.regime,
        });
        setDarfPaymentConfirmations((current) => [
          ...current.filter((confirmation) => overrideKey(confirmation.year_month, confirmation.regime) !== key),
          created,
        ]);
      }
    } catch (err) {
      toast.error(err.message || 'Falha ao confirmar pagamento do DARF.');
    } finally {
      setSavingPaymentKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const buildIrrfDialogState = (row, overrideRecord, taxPaidOverride, manualEventRecords, options = {}) => ({
    row,
    override: overrideRecord || null,
    taxPaidOverride: taxPaidOverride || null,
    value: backendMoneyToInput(row.effective_irrf),
    taxPaidValue: backendMoneyToInput(taxPaidOverride?.manual_tax_paid || row.manual_tax_paid || '0'),
    notes: overrideRecord?.notes || '',
    allowMonthSelect: !!options.allowMonthSelect,
    manualEvents: (manualEventRecords || []).map((event) => ({
      clientId: `event-${event.id}`,
      id: event.id,
      ticker: event.ticker || '',
      gross_sale: backendMoneyToInput(event.gross_sale),
      realized_result: backendMoneyToInput(event.realized_result),
      _deleted: false,
    })),
  });

  const openIrrfDialog = (row, overrideRecord, taxPaidOverride, manualEventRecords) => {
    setIrrfDialog(buildIrrfDialogState(row, overrideRecord, taxPaidOverride, manualEventRecords));
  };

  const commonRowForMonth = (month) => {
    return rows.find((row) => row.regime === REGIME_B3_COMMON && String(row.month) === String(month))
      || emptyRegimeRow({ year, month });
  };

  const openManualRightsDialog = () => {
    const month = 1;
    const row = commonRowForMonth(month);
    const key = overrideKey(row.year_month, row.regime);
    const overrideRecord = overridesByKey.get(key);
    const taxPaidOverride = taxPaidOverridesByKey.get(key);
    const manualEventRecords = manualEventsByKey.get(key) || [];
    setIrrfDialog(buildIrrfDialogState(row, overrideRecord, taxPaidOverride, manualEventRecords, { allowMonthSelect: true }));
  };

  const updateDialogMonth = (month) => {
    const row = commonRowForMonth(month);
    const key = overrideKey(row.year_month, row.regime);
    const overrideRecord = overridesByKey.get(key);
    const taxPaidOverride = taxPaidOverridesByKey.get(key);
    const manualEventRecords = manualEventsByKey.get(key) || [];
    setIrrfDialog(buildIrrfDialogState(row, overrideRecord, taxPaidOverride, manualEventRecords, { allowMonthSelect: true }));
  };

  const updateManualEventDraft = (clientId, updates) => {
    setIrrfDialog((current) => ({
      ...current,
      manualEvents: current.manualEvents.map((event) => (
        event.clientId === clientId ? { ...event, ...updates } : event
      )),
    }));
  };

  const addManualEventDraft = () => {
    setIrrfDialog((current) => ({
      ...current,
      manualEvents: [...current.manualEvents, newManualEventDraft()],
    }));
  };

  const removeManualEventDraft = (clientId) => {
    setIrrfDialog((current) => ({
      ...current,
      manualEvents: current.manualEvents
        .map((event) => (event.clientId === clientId && event.id ? { ...event, _deleted: true } : event))
        .filter((event) => event.id || event.clientId !== clientId),
    }));
  };

  const saveIrrfOverride = async () => {
    if (!irrfDialog || !activePortfolioId) return;
    const manualEventsToSave = irrfDialog.manualEvents.filter((event) => !event._deleted && !isBlankManualEventDraft(event));
    if (manualEventsToSave.some((event) => !event.ticker.trim())) {
      toast.error('Informe o ativo dos eventos manuais.');
      return;
    }
    setSavingIrrf(true);
    try {
      const operations = [];
      const irrfChanged = irrfDialog.override?.id || !moneyEquals(currencyToBackend(irrfDialog.value), irrfDialog.row.effective_irrf) || (irrfDialog.notes || '').trim();
      if (irrfChanged) {
        operations.push(taxApi.upsertIrrfOverride({
          portfolio_id: activePortfolioId,
          year_month: irrfDialog.row.year_month,
          regime: irrfDialog.row.regime,
          effective_irrf: currencyToBackend(irrfDialog.value),
          notes: irrfDialog.notes || null,
        }));
      }

      const taxPaid = currencyToBackend(irrfDialog.taxPaidValue);
      const paymentKey = overrideKey(irrfDialog.row.year_month, irrfDialog.row.regime);
      const paymentConfirmation = darfPaymentConfirmationsByKey.get(paymentKey);
      if (decimalToCents(taxPaid) > 0n) {
        operations.push(taxApi.upsertCapitalGainTaxPaidOverride({
          portfolio_id: activePortfolioId,
          year_month: irrfDialog.row.year_month,
          regime: irrfDialog.row.regime,
          manual_tax_paid: taxPaid,
        }));
        if (paymentConfirmation && !moneyEquals(taxPaid, irrfDialog.row.calculated_net_tax_payable)) {
          operations.push(taxApi.deleteCapitalGainDarfPaymentConfirmation(paymentConfirmation.id));
        }
      } else if (irrfDialog.taxPaidOverride?.id) {
        operations.push(taxApi.deleteCapitalGainTaxPaidOverride(irrfDialog.taxPaidOverride.id));
      }

      irrfDialog.manualEvents.forEach((event) => {
        if (event._deleted && event.id) {
          operations.push(taxApi.deleteCapitalGainManualEvent(event.id));
          return;
        }
        if (isBlankManualEventDraft(event)) return;
        const payload = {
          portfolio_id: activePortfolioId,
          year_month: irrfDialog.row.year_month,
          regime: irrfDialog.row.regime,
          ticker: event.ticker.trim().toUpperCase(),
          gross_sale: currencyToBackend(event.gross_sale),
          realized_result: currencyToBackend(event.realized_result),
        };
        if (event.id) {
          operations.push(taxApi.updateCapitalGainManualEvent(event.id, payload));
        } else {
          operations.push(taxApi.createCapitalGainManualEvent(payload));
        }
      });

      await Promise.all(operations);
      toast.success('Ajuste de apuração salvo.');
      setIrrfDialog(null);
      await loadReport();
    } catch (err) {
      toast.error(err.message || 'Falha ao salvar ajuste de apuração.');
    } finally {
      setSavingIrrf(false);
    }
  };

  const handleIrrfDialogKeyDown = (event) => {
    if (event.key !== 'Enter' || savingIrrf) return;
    if (event.target.closest('button')) return;

    event.preventDefault();
    saveIrrfOverride();
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

  const deleteTaxPaidOverride = async () => {
    if (!irrfDialog?.taxPaidOverride?.id) return;
    setSavingIrrf(true);
    try {
      await taxApi.deleteCapitalGainTaxPaidOverride(irrfDialog.taxPaidOverride.id);
      toast.success('Ajuste de imposto pago removido.');
      setIrrfDialog(null);
      await loadReport();
    } catch (err) {
      toast.error(err.message || 'Falha ao remover ajuste de imposto pago.');
    } finally {
      setSavingIrrf(false);
    }
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
          <Button variant="outline" onClick={exportXlsx} disabled={!activePortfolioId || exporting || loading}>
            {exporting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}
            Exportar XLSX
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <SummaryCard title="Resultado líquido" value={summary.realizedResult} hideValues={hideValues} />
        <SummaryCard title="Ganhos isentos" value={summary.exemptGain} hideValues={hideValues} />
        <SummaryCard title="Saldo IRRF a compensar" value={summary.finalIrrf} hideValues={hideValues} />
        <SummaryCard title="Prejuízo final" value={summary.finalLoss} hideValues={hideValues} />
        <SummaryCard
          title="DARFs"
          value={summary.darfEstimated}
          hideValues={hideValues}
          action={(
            <div className="-mt-1 flex items-center gap-1">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="xs" className="text-muted-foreground">
                    Ver DARFs
                    <ChevronDown data-icon="inline-end" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[calc(100vw-2rem)] max-w-2xl p-3 sm:w-[44rem]">
                  <DarfSuggestionsPopoverContent
                    suggestions={visibleDarfSuggestions}
                    hideValues={hideValues}
                    paymentConfirmationsByKey={darfPaymentConfirmationsByKey}
                    rowsByKey={rowsByKey}
                    savingPaymentKeys={savingPaymentKeys}
                    onTogglePayment={toggleDarfPaymentConfirmation}
                  />
                </PopoverContent>
              </Popover>
              {hasPendingDarfPayment && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-xs" aria-label="DARF pendente de confirmação de pagamento">
                      <AlertCircle />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>DARF pendente de confirmação de pagamento.</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col gap-4">
        <div className="overflow-x-auto">
          <TabsList className="min-w-max justify-start">
            {REPORT_TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>
            ))}
          </TabsList>
        </div>
        {REPORT_TABS.map((tab) => {
          const tabRows = visibleRows.filter((row) => row.regime === tab.regime);
          return (
            <TabsContent key={tab.value} value={tab.value} className="mt-0">
              {loading ? (
                <Card>
                  <CardContent className="flex min-h-[260px] items-center justify-center gap-2 text-muted-foreground">
                    <Loader2 className="animate-spin" />
                    <span className="text-sm">Carregando relatório...</span>
                  </CardContent>
                </Card>
              ) : (
                <RegimeTable
                  regime={tab.regime}
                  rows={tabRows}
                  expanded={expanded}
                  hideValues={hideValues}
                  overridesByKey={overridesByKey}
                  taxPaidOverridesByKey={taxPaidOverridesByKey}
                  manualEventsByKey={manualEventsByKey}
                  onToggle={toggleExpanded}
                  onEditIrrf={openIrrfDialog}
                  onAddManualRights={openManualRightsDialog}
                />
              )}
            </TabsContent>
          );
        })}
      </Tabs>

      <Dialog open={!!irrfDialog} onOpenChange={(open) => !open && !savingIrrf && setIrrfDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ajustar apuração</DialogTitle>
            <DialogDescription>
              {irrfDialog ? `${monthLabel(irrfDialog.row.month)} / ${irrfDialog.row.year_month.slice(0, 4)} · ${REGIME_LABELS[irrfDialog.row.regime]}` : ''}
            </DialogDescription>
          </DialogHeader>
          {irrfDialog && (
            <div className="flex flex-col gap-4" onKeyDown={handleIrrfDialogKeyDown}>
              {irrfDialog.allowMonthSelect && (
                <div className="flex flex-col gap-1.5">
                  <Label>Mês da apuração</Label>
                  <Select value={String(irrfDialog.row.month)} onValueChange={updateDialogMonth} disabled={savingIrrf}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {MONTHS.map((month) => <SelectItem key={month.value} value={month.value}>{month.label}</SelectItem>)}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">IRRF teórico</Label>
                  <div className="mt-1 font-mono text-sm">R$ {formatMoney(irrfDialog.row.theoretical_irrf, hideValues)}</div>
                </div>
                <div>
                  <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">IRRF efetivo atual</Label>
                  <div className="mt-1 font-mono text-sm">R$ {formatMoney(irrfDialog.row.effective_irrf, hideValues)}</div>
                </div>
                <div>
                  <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Imposto calculado</Label>
                  <div className="mt-1 font-mono text-sm">R$ {formatMoney(irrfDialog.row.calculated_net_tax_payable, hideValues)}</div>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="effective-irrf">IRRF Efetivo</Label>
                <div className="flex gap-2">
                  <Input
                    id="effective-irrf"
                    value={irrfDialog.value}
                    onChange={(event) => setIrrfDialog({ ...irrfDialog, value: applyCurrencyMask(event.target.value) })}
                    disabled={savingIrrf}
                  />
                  {irrfDialog.override?.id && (
                    <Button variant="outline" size="icon" onClick={deleteIrrfOverride} disabled={savingIrrf} aria-label="Remover IRRF efetivo manual">
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="manual-tax-paid">Imposto Pago</Label>
                <div className="flex gap-2">
                  <Input
                    id="manual-tax-paid"
                    value={irrfDialog.taxPaidValue}
                    onChange={(event) => setIrrfDialog({ ...irrfDialog, taxPaidValue: applyCurrencyMask(event.target.value) })}
                    disabled={savingIrrf}
                  />
                  {irrfDialog.taxPaidOverride?.id && (
                    <Button variant="outline" size="icon" onClick={deleteTaxPaidOverride} disabled={savingIrrf} aria-label="Remover imposto pago manual">
                      <Trash2 />
                    </Button>
                  )}
                </div>
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
              {irrfDialog.row.regime === REGIME_B3_COMMON && (
              <div className="flex flex-col gap-3 rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label className="text-sm font-medium">Venda de Direitos</Label>
                  </div>
                  <Button variant="outline" size="sm" onClick={addManualEventDraft} disabled={savingIrrf}>
                    <Plus data-icon="inline-start" />
                    Adicionar
                  </Button>
                </div>
                {irrfDialog.manualEvents.filter((event) => !event._deleted).length === 0 ? (
                  <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    Nenhum evento manual cadastrado.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {irrfDialog.manualEvents.filter((event) => !event._deleted).map((event) => (
                      <div key={event.clientId} className="grid grid-cols-[5.5rem_1fr] gap-2 rounded-md border p-3 sm:grid-cols-[5.5rem_6.75rem_6.75rem_auto]">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor={`manual-ticker-${event.clientId}`}>Ativo</Label>
                          <Input
                            id={`manual-ticker-${event.clientId}`}
                            value={event.ticker}
                            onChange={(inputEvent) => updateManualEventDraft(event.clientId, { ticker: inputEvent.target.value.toUpperCase() })}
                            disabled={savingIrrf}
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor={`manual-gross-${event.clientId}`}>Venda Bruta</Label>
                          <Input
                            id={`manual-gross-${event.clientId}`}
                            value={event.gross_sale}
                            onChange={(inputEvent) => updateManualEventDraft(event.clientId, { gross_sale: applyCurrencyMask(inputEvent.target.value) })}
                            disabled={savingIrrf}
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor={`manual-result-${event.clientId}`}>Resultado</Label>
                          <Input
                            id={`manual-result-${event.clientId}`}
                            value={event.realized_result}
                            onChange={(inputEvent) => updateManualEventDraft(event.clientId, { realized_result: applySignedCurrencyMask(inputEvent.target.value) })}
                            disabled={savingIrrf}
                          />
                        </div>
                        <div className="flex items-end">
                          <Button variant="ghost" size="icon" onClick={() => removeManualEventDraft(event.clientId)} disabled={savingIrrf} aria-label="Remover evento manual">
                            <Trash2 />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              )}
            </div>
          )}
          <DialogFooter>
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
