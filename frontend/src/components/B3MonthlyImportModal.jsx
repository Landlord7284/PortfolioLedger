import { Fragment, useMemo, useState } from 'react';
import { b3 as b3Api } from '../api/client';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  Loader2,
  UploadCloud,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import FileDropzone from './FileDropzone';

function StatCard({ label, value, className = '' }) {
  return (
    <Card>
      <CardContent className="px-3 py-1.5">
        <p className="text-[10px] font-medium uppercase tracking-wider leading-tight text-muted-foreground">{label}</p>
        <p className={`font-mono text-base font-bold leading-tight ${className}`}>{value ?? 0}</p>
      </CardContent>
    </Card>
  );
}

function DetailList({ title, icon: Icon, items, destructive = false }) {
  if (!items?.length) return null;

  return (
    <div className="min-w-0 space-y-2">
      <h4 className={`flex items-center gap-1 text-sm font-medium ${destructive ? 'text-destructive' : ''}`}>
        <Icon className="h-4 w-4" />
        {title}
      </h4>
      <div className="flex max-h-36 flex-col gap-1 overflow-y-auto overflow-x-hidden">
        {items.map((item, index) => (
          <div
            key={`${item}-${index}`}
            className={`whitespace-pre-wrap break-words rounded p-2 font-mono text-xs ${
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

function fileKey(file) {
  return `${file.filename}-${file.reference_month}`;
}

function hasFileLogs(file) {
  return Boolean(file?.duplicate_details?.length || file?.review_details?.length || file?.errors?.length);
}

export default function B3MonthlyImportModal({ portfolioId, onClose, onSuccess }) {
  const [files, setFiles] = useState([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [expandedFiles, setExpandedFiles] = useState(() => new Set());

  const allErrors = useMemo(() => {
    if (!result) return [];
    return result.errors || [];
  }, [result]);

  const toggleFile = (file) => {
    if (!hasFileLogs(file)) return;
    const key = fileKey(file);
    setExpandedFiles((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

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
      <DialogContent className="grid max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-5xl">
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
          <div className="flex flex-col gap-4">
            <FileDropzone
              files={files}
              accept=".xlsx"
              multiple
              onFilesChange={setFiles}
              disabled={importing}
              title="Arraste os arquivos mensais aqui"
              description="Use arquivos .xlsx da B3 no padrao YYYY-MM.xlsx."
              browseLabel="Selecionar arquivos"
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
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
            <Alert className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              <AlertTitle className="mb-0">Importacao B3 concluida!</AlertTitle>
            </Alert>

            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
              <StatCard label="Arquivos" value={result.files_processed} />
              <StatCard label="Linhas" value={result.total_rows} />
              <StatCard label="Precos" value={result.imported_prices} className="text-emerald-500" />
              <StatCard label="Proventos" value={result.imported_incomes} className="text-emerald-500" />
              <StatCard label="Amortizacoes" value={result.auto_events_created} className="text-emerald-500" />
              <StatCard label="Duplicados" value={result.duplicates} className={result.duplicates > 0 ? 'text-amber-500' : ''} />
              <StatCard label="Revisoes" value={result.review_count} className={result.review_count > 0 ? 'text-amber-500' : ''} />
              <StatCard label="Erros" value={allErrors.length} className={allErrors.length > 0 ? 'text-destructive' : ''} />
            </div>

            <div className="min-h-0 flex-1 overflow-auto rounded-md border">
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
                  {(result.files || []).map((file) => {
                    const key = fileKey(file);
                    const expandable = hasFileLogs(file);
                    const expanded = expandedFiles.has(key);
                    const ArrowIcon = expanded ? ChevronDown : ChevronRight;

                    return (
                      <Fragment key={key}>
                        <TableRow
                          className={expandable ? 'cursor-pointer hover:bg-muted/50' : ''}
                          onClick={() => toggleFile(file)}
                        >
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              {expandable ? (
                                <ArrowIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                              ) : (
                                <span className="h-4 w-4 shrink-0" />
                              )}
                              <span>{file.filename}</span>
                            </div>
                          </TableCell>
                          <TableCell>{file.reference_month}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{file.total_rows}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{file.imported_prices}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{file.imported_incomes}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{file.auto_events_created}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{file.duplicates}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{file.review_count}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{file.errors?.length || 0}</TableCell>
                        </TableRow>
                        {expanded && (
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell colSpan={9} className="p-4">
                              <div className="flex w-full flex-col gap-4">
                                <DetailList title="Duplicados" icon={AlertTriangle} items={file.duplicate_details || []} />
                                <DetailList title="Revisoes" icon={AlertTriangle} items={file.review_details || []} />
                                <DetailList title="Erros" icon={AlertCircle} items={file.errors || []} destructive />
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none border-t-0 bg-transparent p-0 pt-1 sm:justify-end">
              <Button onClick={onClose} className="w-full sm:w-auto">Fechar</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
