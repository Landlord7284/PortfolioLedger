import { useContext, useMemo, useState } from 'react';
import { AppContext } from '../App';
import { brokerageNotes } from '../api/client';
import { AlertCircle, CheckCircle2, Loader2, Plus, ReceiptText, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { toast } from 'sonner';
import { applyCurrencyMask, currencyToBackend, sanitizeQuantityInput, formatMoney } from '@/lib/formatters';

const ASSET_CLASSES = [
  'Ação', 'BDR', 'Criptomoeda', 'Debênture', 'CRI', 'CRA',
  'ETF', 'FII', 'FI-INFRA', 'Tesouro Direto', 'Stock', 'REIT',
];

const emptyOperation = () => ({
  id: Date.now() + Math.random(),
  asset_class: 'Ação',
  ticker: '',
  operation_type: 'Compra',
  quantity: '',
  gross_value: '',
});

export default function BrokerageNote() {
  const { activePortfolioId } = useContext(AppContext);
  const today = new Date().toISOString().slice(0, 10);
  const [noteDate, setNoteDate] = useState(today);
  const [debitCredit, setDebitCredit] = useState('D');
  const [netAmount, setNetAmount] = useState('');
  const [operations, setOperations] = useState([emptyOperation()]);
  const [calculation, setCalculation] = useState(null);
  const [savingResult, setSavingResult] = useState(null);
  const [error, setError] = useState('');
  const [calculating, setCalculating] = useState(false);
  const [saving, setSaving] = useState(false);

  const payload = useMemo(() => ({
    note_date: noteDate,
    debit_credit: debitCredit,
    net_amount: currencyToBackend(netAmount),
    operations: operations.map((op) => ({
      asset_class: op.asset_class,
      ticker: op.ticker,
      operation_type: op.operation_type,
      quantity: op.quantity.replace(',', '.'),
      gross_value: currencyToBackend(op.gross_value),
    })),
  }), [noteDate, debitCredit, netAmount, operations]);

  const updateOperation = (id, field, value) => {
    setCalculation(null);
    setSavingResult(null);
    setOperations((prev) => prev.map((op) => (op.id === id ? { ...op, [field]: value } : op)));
  };

  const addOperation = () => {
    setCalculation(null);
    setSavingResult(null);
    setOperations((prev) => [...prev, emptyOperation()]);
  };

  const removeOperation = (id) => {
    if (operations.length === 1) return;
    setCalculation(null);
    setSavingResult(null);
    setOperations((prev) => prev.filter((op) => op.id !== id));
  };

  const calculate = async () => {
    setError('');
    setSavingResult(null);
    setCalculating(true);
    try {
      const result = await brokerageNotes.calculate(payload);
      setCalculation(result);
      toast[result.summary.reconciled ? 'success' : 'warning'](
        result.summary.reconciled ? 'Nota reconciliada.' : 'A nota não fechou com o líquido informado.'
      );
    } catch (err) {
      setCalculation(null);
      setError(err.message);
      toast.error(err.message || 'Falha ao calcular nota.');
    } finally {
      setCalculating(false);
    }
  };

  const save = async () => {
    if (!activePortfolioId || !calculation?.summary?.reconciled) return;
    setError('');
    setSaving(true);
    try {
      const result = await brokerageNotes.save({ ...payload, portfolio_id: activePortfolioId });
      setSavingResult(result.import_result);
      setCalculation(result.calculation);
      toast.success(`${result.import_result.imported} evento(s) salvo(s).`);
    } catch (err) {
      setError(err.message);
      toast.error(err.message || 'Falha ao salvar nota.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <ReceiptText className="h-6 w-6" />
          Rateio de Nota
        </h1>
        <p className="text-sm text-muted-foreground">
          Lance as operações, calcule o rateio no backend e salve os eventos no ledger.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dados da nota</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium uppercase text-muted-foreground">Data</Label>
            <DatePicker value={noteDate} onChange={(v) => { setNoteDate(v); setCalculation(null); }} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium uppercase text-muted-foreground">D/C</Label>
            <Select value={debitCredit} onValueChange={(v) => { setDebitCredit(v); setCalculation(null); }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="D">Débito</SelectItem>
                <SelectItem value="C">Crédito</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium uppercase text-muted-foreground">Líquido da nota</Label>
            <Input value={netAmount} onChange={(e) => { setNetAmount(applyCurrencyMask(e.target.value)); setCalculation(null); }} placeholder="0,00" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">Operações</CardTitle>
          <Button type="button" variant="outline" size="sm" onClick={addOperation}>
            <Plus className="h-4 w-4" /> Adicionar
          </Button>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[150px]">Classe</TableHead>
                  <TableHead className="min-w-[120px]">Ticker</TableHead>
                  <TableHead className="min-w-[140px]">Operação</TableHead>
                  <TableHead className="min-w-[110px]">Quantidade</TableHead>
                  <TableHead className="min-w-[130px]">Valor bruto</TableHead>
                  <TableHead className="w-14 text-center">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {operations.map((op) => (
                  <TableRow key={op.id}>
                    <TableCell className="p-2">
                      <Select value={op.asset_class} onValueChange={(v) => updateOperation(op.id, 'asset_class', v)}>
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ASSET_CLASSES.map((assetClass) => (
                            <SelectItem key={assetClass} value={assetClass}>{assetClass}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="p-2">
                      <Input value={op.ticker} onChange={(e) => updateOperation(op.id, 'ticker', e.target.value.toUpperCase())} placeholder="WEGE3" />
                    </TableCell>
                    <TableCell className="p-2">
                      <Select value={op.operation_type} onValueChange={(v) => updateOperation(op.id, 'operation_type', v)}>
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Compra">Compra</SelectItem>
                          <SelectItem value="Venda">Venda</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="p-2">
                      <Input value={op.quantity} onChange={(e) => updateOperation(op.id, 'quantity', sanitizeQuantityInput(e.target.value, op.asset_class))} placeholder="0" />
                    </TableCell>
                    <TableCell className="p-2">
                      <Input value={op.gross_value} onChange={(e) => updateOperation(op.id, 'gross_value', applyCurrencyMask(e.target.value))} placeholder="0,00" />
                    </TableCell>
                    <TableCell className="p-2 text-center">
                      <Button type="button" variant="ghost" size="icon-sm" className="text-destructive" onClick={() => removeOperation(op.id)} disabled={operations.length === 1}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={calculate} disabled={calculating}>
              {calculating ? <><Loader2 className="h-4 w-4 animate-spin" /> Calculando...</> : 'Calcular Rateio'}
            </Button>
            <Button type="button" onClick={save} disabled={saving || !calculation?.summary?.reconciled || !activePortfolioId}>
              {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Salvando...</> : <><Save className="h-4 w-4" /> Salvar no Ledger</>}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {calculation && (
        <div className="space-y-4">
          <Alert className={calculation.summary.reconciled ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : ''} variant={calculation.summary.reconciled ? 'default' : 'destructive'}>
            {calculation.summary.reconciled ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            <AlertTitle>{calculation.summary.reconciled ? 'Nota reconciliada' : 'Nota não reconciliada'}</AlertTitle>
            <AlertDescription>
              Líquido calculado: {formatMoney(calculation.summary.calculated_signed_total)} · Diferença: {formatMoney(calculation.summary.reconciliation_difference)}
            </AlertDescription>
          </Alert>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card>
              <CardContent className="p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Compras</p>
                <p className="mt-1 font-mono text-lg font-semibold">{formatMoney(calculation.summary.purchase_total)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Vendas</p>
                <p className="mt-1 font-mono text-lg font-semibold">{formatMoney(calculation.summary.sale_total)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Diferença</p>
                <p className="mt-1 font-mono text-lg font-semibold">{formatMoney(calculation.summary.operation_difference)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Taxas</p>
                <p className="mt-1 font-mono text-lg font-semibold">{formatMoney(calculation.summary.total_costs)}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Resultado para importação</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Classe</TableHead>
                      <TableHead>Ativo</TableHead>
                      <TableHead>Evento</TableHead>
                      <TableHead>Data</TableHead>
                      <TableHead className="text-right">Quantidade</TableHead>
                      <TableHead className="text-right">Preço</TableHead>
                      <TableHead className="text-right">Taxa</TableHead>
                      <TableHead className="text-right">Valor evento</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {calculation.events.map((ev, index) => (
                      <TableRow key={`${ev.ticker}-${index}`}>
                        <TableCell>{ev.asset_class}</TableCell>
                        <TableCell className="font-medium">{ev.ticker}</TableCell>
                        <TableCell>{ev.event_type}</TableCell>
                        <TableCell>{ev.event_date}</TableCell>
                        <TableCell className="text-right font-mono">{ev.quantity}</TableCell>
                        <TableCell className="text-right font-mono">{formatMoney(ev.calculated_price)}</TableCell>
                        <TableCell className="text-right font-mono">{formatMoney(ev.allocated_fee)}</TableCell>
                        <TableCell className="text-right font-mono">{formatMoney(ev.event_value)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {savingResult && (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Salvamento concluído</AlertTitle>
          <AlertDescription>
            {savingResult.imported} importado(s), {savingResult.duplicates} duplicado(s), {savingResult.review_count} em revisão e {savingResult.skipped} ignorado(s).
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
