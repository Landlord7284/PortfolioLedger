import { useState } from 'react';
import { FileJson, Info, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import FileDropzone from './FileDropzone';

function isJsonFile(file) {
  return file?.name?.toLowerCase().endsWith('.json');
}

export default function SchwabImportModal({ onClose }) {
  const [accountKey, setAccountKey] = useState('');
  const [files, setFiles] = useState([]);

  const handleFilesChange = (selectedFiles) => {
    const nextFiles = Array.from(selectedFiles || []);
    const jsonFiles = nextFiles.filter(isJsonFile);

    if (nextFiles.length > 0 && jsonFiles.length !== nextFiles.length) {
      toast.warning('Apenas arquivos .json da Schwab/TDA serão selecionados.');
    }

    setFiles(jsonFiles);
  };

  const handleImport = () => {
    if (files.length === 0) return;
    toast.info('Importação Schwab ainda não conectada ao backend.');
  };

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadCloud className="h-5 w-5" />
            Importar Schwab
          </DialogTitle>
          <DialogDescription>
            Selecione um ou mais arquivos .json exportados da Schwab/TDA.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="schwab-account-key" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Conta / account_key
            </Label>
            <Input
              id="schwab-account-key"
              value={accountKey}
              onChange={(event) => setAccountKey(event.target.value)}
              placeholder="Opcional"
            />
          </div>

          <FileDropzone
            files={files}
            accept=".json"
            multiple
            onFilesChange={handleFilesChange}
            title="Arraste os arquivos JSON aqui"
            description="Use arquivos .json da Schwab/TDA para importar transações internacionais."
            browseLabel="Selecionar arquivos"
          />

          <Alert>
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <AlertDescription>Cash In Lieu entra no ledger como V. Fração.</AlertDescription>
          </Alert>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={handleImport} disabled={files.length === 0}>
              <FileJson className="h-4 w-4" />
              Iniciar Importação
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
