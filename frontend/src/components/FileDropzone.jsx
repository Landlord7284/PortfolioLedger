import { useId, useState } from 'react';
import { FileSpreadsheet, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

function formatFileSize(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FileDropzone({
  files = [],
  onFilesChange,
  accept,
  multiple = false,
  disabled = false,
  title = 'Arraste arquivos aqui',
  description = 'Solte os arquivos nesta area ou selecione pelo computador.',
  browseLabel = 'Selecionar arquivo',
}) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  const [inputKey, setInputKey] = useState(0);

  const selectedFiles = Array.isArray(files) ? files : [];

  const updateFiles = (fileList) => {
    const nextFiles = Array.from(fileList || []);
    const normalizedFiles = multiple ? nextFiles : nextFiles.slice(0, 1);
    if (normalizedFiles.length === 0) return;

    onFilesChange?.(normalizedFiles);
    setInputKey((key) => key + 1);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    if (disabled) return;
    updateFiles(event.dataTransfer.files);
  };

  const handleDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!disabled) setDragging(true);
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDragging(false);
  };

  const clearFiles = () => {
    onFilesChange?.([]);
    setInputKey((key) => key + 1);
  };

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={inputId}
        className={cn(
          'flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
          disabled && 'pointer-events-none cursor-not-allowed opacity-60'
        )}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Input
          key={inputKey}
          id={inputId}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          className="sr-only"
          onChange={(event) => updateFiles(event.target.files)}
        />
        <UploadCloud className="mb-3 h-10 w-10 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</span>
        <span className="mt-4 rounded-md border bg-background px-3 py-1.5 text-sm font-medium shadow-sm">
          {browseLabel}
        </span>
      </label>

      {selectedFiles.length > 0 && (
        <div className="rounded-md border bg-background p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {selectedFiles.length === 1 ? 'Arquivo selecionado' : `${selectedFiles.length} arquivos selecionados`}
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={clearFiles} disabled={disabled}>
              Limpar
            </Button>
          </div>
          <div className="mt-2 flex max-h-32 flex-col gap-1 overflow-y-auto">
            {selectedFiles.map((selectedFile, index) => (
              <div key={`${selectedFile.name}-${selectedFile.size}-${index}`} className="flex items-center gap-2 rounded bg-muted px-2 py-1.5 text-sm">
                <FileSpreadsheet className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{selectedFile.name}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatFileSize(selectedFile.size)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
