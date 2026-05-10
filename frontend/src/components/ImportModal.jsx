import { useState } from 'react';
import { importXlsx } from '../api/client';
import { UploadCloud, FileSpreadsheet, Loader2, AlertTriangle, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from 'sonner';

export default function ImportModal({ portfolioId, onClose, onSuccess }) {
  const [file, setFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const handleImport = async () => {
    if (!file) return;
    setImporting(true);
    setError('');
    try {
      const res = await importXlsx(portfolioId, file);
      setResult(res);
      if (res.imported > 0) {
        toast.success(`Importação concluída: ${res.imported} evento(s) importado(s).`);
      } else if (res.duplicates > 0 || res.skipped > 0) {
        toast.warning('Importação concluída sem novos eventos.');
      } else {
        toast.info('Importação concluída.');
      }
      if (res.imported > 0) {
        onSuccess?.();
      }
    } catch (err) {
      setError(err.message);
      toast.error(err.message || 'Falha na importação da planilha.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(v) => { if (!v && !importing) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadCloud className="w-5 h-5" />
            Importar Eventos
          </DialogTitle>
          {!result && (
            <DialogDescription>
              Selecione uma planilha <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">.xlsx</code> para a carteira selecionada.
            </DialogDescription>
          )}
        </DialogHeader>

        {!result ? (
          <div className="space-y-4">
            <Input
              type="file"
              accept=".xlsx"
              onChange={(e) => setFile(e.target.files[0])}
              className="cursor-pointer"
            />

            <Alert>
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <AlertDescription>Eventos já existentes serão ignorados e marcados com flag de duplicação para revisão.</AlertDescription>
            </Alert>

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={importing}>
                Cancelar
              </Button>
              <Button onClick={handleImport} disabled={!file || importing}>
                {importing ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Importando...</>
                ) : (
                  <><FileSpreadsheet className="w-4 h-4" /> Iniciar Importação</>
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <Alert className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-5 h-5 shrink-0" />
              <AlertTitle className="mb-0">Importação concluída!</AlertTitle>
            </Alert>

            <div className="grid grid-cols-2 gap-3">
              <Card>
                <CardContent className="p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Total de linhas</p>
                  <p className="text-xl font-bold font-mono">{result.total_rows}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Importados</p>
                  <p className="text-xl font-bold font-mono text-emerald-500">{result.imported}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Duplicados</p>
                  <p className={`text-xl font-bold font-mono ${result.duplicates > 0 ? 'text-amber-500' : ''}`}>{result.duplicates}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Erros</p>
                  <p className={`text-xl font-bold font-mono ${result.skipped > 0 ? 'text-destructive' : ''}`}>{result.skipped}</p>
                </CardContent>
              </Card>
            </div>

            {result.duplicates > 0 && (
              <Alert>
                <AlertDescription>
                  <strong>{result.duplicates} eventos duplicados</strong> foram ignorados, mas adicionamos uma flag nos ativos/eventos correspondentes para sua revisão.
                </AlertDescription>
              </Alert>
            )}

            {result.errors.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-destructive font-medium text-sm flex items-center gap-1">
                  <AlertCircle className="w-4 h-4" /> Detalhes dos erros:
                </h4>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {result.errors.map((err, i) => (
                    <div key={i} className="p-2 bg-destructive/10 text-destructive rounded text-xs font-mono">
                      {err}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button onClick={onClose} className="w-full sm:w-auto">Fechar</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
