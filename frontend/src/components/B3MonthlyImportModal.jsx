import { useMemo, useState } from 'react';
import { b3 as b3Api } from '../api/client';
import { AlertCircle, AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function StatCard({ label, value, className = '' }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={`font-mono text-xl font-bold ${className}`}>{value ?? 0}</p>
      </CardContent>
    </Card>
  );
}

function DetailList({ title, icon: Icon, items, destructive = false }) {
  if (!items?.length) return null;

  return (
    <div className="space-y-2">
      <h4 className={`flex items-center gap-1 text-sm font-medium ${destructive ? 'text-destructive' : ''}`}>
        <Icon className="h-4 w-4" />
        {title}
      </h4>
      <div className="max-h-32 space-y-1 overflow-y-auto">
        {items.map((item, index) => (
          <div
            key={`${item}-${index}`}
            className={`rounded p-2 font-mono text-xs ${
              destructive ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
            }`}
          >
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function B3MonthlyImportModal({ portfolioId, onClose, onSuccess }) {
  const [files, setFiles] = useState([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const allReviewDetails = useMemo(() => (
    result?.files?.flatMap((file) => file.review_details || []) || []
  ), [result]);

  const allErrors = useMemo(() => {
    if (!result) return [];
    return [
      ...(result.errors || []),
      ...(result.files || []).flatMap((file) => file.errors || []),
    ];
  }, [result]);

  const handleImport = async () => {
    if (files.length === 0) return;

    setImporting(true);
    setError('');
    try {
      const res = await b3Api.monthlyImport({ portfolioId, files });
      setResult(res);

      if (res.imported_prices > 0 || res.imported_incomes > 0 || res.auto_events_created > 0) {
        toast.success('Importacao B3 concluida.');
      } else if (res.duplicates > 0 || res.review_count > 0 || res.errors?.length > 0) {
        toast.warning('Importacao B3 concluida sem novos dados aplicaveis.');
      } else {
        toast.info('Importacao B3 concluida.');
      }

      if (res.imported_prices > 0 || res.imported_incomes > 0 || res.auto_events_created > 0) {
        onSuccess?.();
      }
    } catch (err) {
      setError(err.message);
      toast.error(err.message || 'Falha na importacao B3.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open && !importing) onClose(); }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadCloud className="h-5 w-5" />
            Importar da B3
          </DialogTitle>
          {!result && (
            <DialogDescription>
              Selecione um ou mais arquivos mensais da B3 no padrao{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">YYYY-MM.xlsx</code>.
            </DialogDescription>
          )}
        </DialogHeader>

        {!result ? (
          <div className="space-y-4">
            <Input
              type="file"
              accept=".xlsx"
              multiple
              onChange={(event) => setFiles(Array.from(event.target.files || []))}
              className="cursor-pointer"
            />

            <Alert>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <AlertDescription>
                Os arquivos serao processados em ordem cronologica pelo nome. O backend valida o formato do nome e o conteudo da planilha.
              </AlertDescription>
            </Alert>

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={importing}>
                Cancelar
              </Button>
              <Button onClick={handleImport} disabled={files.length === 0 || importing}>
                {importing ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Importando...</>
                ) : (
                  <><FileSpreadsheet className="h-4 w-4" /> Iniciar Importacao</>
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <Alert className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              <AlertTitle className="mb-0">Importacao B3 concluida!</AlertTitle>
            </Alert>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="Arquivos" value={result.files_processed} />
              <StatCard label="Linhas" value={result.total_rows} />
              <StatCard label="Precos" value={result.imported_prices} className="text-emerald-500" />
              <StatCard label="Proventos" value={result.imported_incomes} className="text-emerald-500" />
              <StatCard label="Amortizacoes" value={result.auto_events_created} className="text-emerald-500" />
              <StatCard label="Duplicados" value={result.duplicates} className={result.duplicates > 0 ? 'text-amber-500' : ''} />
              <StatCard label="Revisoes" value={result.review_count} className={result.review_count > 0 ? 'text-amber-500' : ''} />
              <StatCard label="Erros" value={allErrors.length} className={allErrors.length > 0 ? 'text-destructive' : ''} />
            </div>

            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Arquivo</TableHead>
                    <TableHead>Mes</TableHead>
                    <TableHead className="text-right">Linhas</TableHead>
                    <TableHead className="text-right">Precos</TableHead>
                    <TableHead className="text-right">Proventos</TableHead>
                    <TableHead className="text-right">Amortizacoes</TableHead>
                    <TableHead className="text-right">Duplicados</TableHead>
                    <TableHead className="text-right">Revisoes</TableHead>
                    <TableHead className="text-right">Erros</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(result.files || []).map((file) => (
                    <TableRow key={`${file.filename}-${file.reference_month}`}>
                      <TableCell className="font-medium">{file.filename}</TableCell>
                      <TableCell>{file.reference_month}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{file.total_rows}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{file.imported_prices}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{file.imported_incomes}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{file.auto_events_created}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{file.duplicates}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{file.review_count}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{file.errors?.length || 0}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <DetailList title="Revisoes pendentes" icon={AlertTriangle} items={allReviewDetails} />
            <DetailList title="Detalhes dos erros" icon={AlertCircle} items={allErrors} destructive />

            <DialogFooter>
              <Button onClick={onClose} className="w-full sm:w-auto">Fechar</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
