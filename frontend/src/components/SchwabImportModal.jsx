import { useState } from 'react';
import { schwab as schwabApi } from '../api/client';
import { AlertCircle, AlertTriangle, CheckCircle2, FileJson, Info, Loader2, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import FileDropzone from './FileDropzone';

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
    <div className="flex flex-col gap-2">
      <h4 className={`flex items-center gap-1 text-sm font-medium ${destructive ? 'text-destructive' : ''}`}>
        <Icon className="h-4 w-4" />
        {title}
      </h4>
      <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
        {items.map((item, index) => (
          <div
            key={`${title}-${index}`}
            className={`rounded p-2 font-mono text-xs ${destructive ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}
          >
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

function isJsonFile(file) {
  return file?.name?.toLowerCase().endsWith('.json');
}

export default function SchwabImportModal({ portfolioId, onClose, onSuccess }) {
  const [files, setFiles] = useState([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const handleFilesChange = (selectedFiles) => {
    const nextFiles = Array.from(selectedFiles || []);
    const jsonFiles = nextFiles.filter(isJsonFile);

    if (nextFiles.length > 0 && jsonFiles.length !== nextFiles.length) {
      toast.warning('Apenas arquivos .json da Schwab/TDA serão selecionados.');
    }

    setFiles(jsonFiles);
    if (jsonFiles.length > 0) setError('');
  };

  const handleImport = async () => {
    if (importing) return;
    if (files.length === 0) {
      const message = 'Selecione ao menos um arquivo .json da Schwab/TDA.';
      setError(message);
      toast.warning(message);
      return;
    }

    setImporting(true);
    setError('');
    try {
      const res = await schwabApi.importJson({
        portfolioId,
        files,
      });
      setResult(res);
      setFiles([]);

      if (res.imported_ledger_events > 0 || res.imported_foreign_events > 0) {
        toast.success('Importação Schwab concluída.');
      } else if (res.duplicates > 0 || res.review_count > 0 || res.warning_count > 0 || res.errors?.length > 0) {
        toast.warning('Importação Schwab concluída sem novos eventos no ledger.');
      } else {
        toast.info('Importação Schwab concluída.');
      }

      onSuccess?.();
    } catch (err) {
      setError(err.message);
      toast.error(err.message || 'Falha na importação Schwab.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open && !importing) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadCloud className="h-5 w-5" />
            Importar Schwab
          </DialogTitle>
          {!result && (
            <DialogDescription>
              Selecione um ou mais arquivos .json exportados da Schwab/TDA.
            </DialogDescription>
          )}
        </DialogHeader>

        {!result ? (
          <div className="flex flex-col gap-4">
            <FileDropzone
              files={files}
              accept=".json"
              multiple
              onFilesChange={handleFilesChange}
              disabled={importing}
              title="Arraste os arquivos JSON aqui"
              description="Use arquivos .json da Schwab/TDA para importar transações internacionais."
              browseLabel="Selecionar arquivos"
            />

            <Alert>
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <AlertDescription>Cash In Lieu entra no ledger como V. Fração.</AlertDescription>
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
                  <><FileJson className="h-4 w-4" /> Iniciar Importação</>
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Alert className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              <AlertTitle className="mb-0">Importação Schwab concluída!</AlertTitle>
            </Alert>

            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Arquivos" value={result.files_processed} />
              <StatCard label="Linhas" value={result.total_rows} />
              <StatCard label="Ledger" value={result.imported_ledger_events} className="text-emerald-500" />
              <StatCard label="Exterior" value={result.imported_foreign_events} className="text-emerald-500" />
              <StatCard label="Duplicados" value={result.duplicates} className={result.duplicates > 0 ? 'text-amber-500' : ''} />
              <StatCard label="Revisões" value={result.review_count} className={result.review_count > 0 ? 'text-amber-500' : ''} />
              <StatCard label="Avisos" value={result.warning_count} className={result.warning_count > 0 ? 'text-amber-500' : ''} />
              <StatCard label="Erros" value={result.errors?.length || 0} className={result.errors?.length > 0 ? 'text-destructive' : ''} />
            </div>

            <Alert>
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <AlertDescription>Cash In Lieu entra no ledger como V. Fração.</AlertDescription>
            </Alert>

            <DetailList title="Duplicados" icon={AlertTriangle} items={result.files?.flatMap((file) => file.duplicate_details || [])} />
            <DetailList title="Revisões" icon={AlertTriangle} items={result.files?.flatMap((file) => file.review_details || [])} />
            <DetailList title="Avisos" icon={AlertTriangle} items={result.files?.flatMap((file) => file.warnings || [])} />
            <DetailList title="Erros" icon={AlertCircle} items={result.errors || []} destructive />

            <DialogFooter>
              <Button onClick={onClose} className="w-full sm:w-auto">Fechar</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
