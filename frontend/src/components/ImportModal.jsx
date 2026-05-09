import { useState } from 'react';
import { importXlsx } from '../api/client';

export default function ImportModal({ portfolioId, onClose, onSuccess }) {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const handleImport = async () => {
    setImporting(true);
    setError('');
    try {
      const res = await importXlsx(portfolioId);
      setResult(res);
      if (res.imported > 0) {
        onSuccess?.();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Importar Dados.xlsx</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        {!result ? (
          <>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Importar o arquivo <code style={{ color: 'var(--text-accent)' }}>Dados.xlsx</code> para
              a carteira selecionada. Todos os eventos serão processados e as posições recalculadas.
            </p>

            <div className="alert alert-warning">
              ⚠️ Esta operação pode demorar alguns minutos dependendo da quantidade de eventos.
              Fórmulas Excel simples serão resolvidas automaticamente.
            </div>

            {error && <div className="alert alert-error">{error}</div>}

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={onClose} disabled={importing}>
                Cancelar
              </button>
              <button className="btn btn-primary" onClick={handleImport} disabled={importing}>
                {importing ? (
                  <><div className="spinner" /> Importando...</>
                ) : (
                  '🚀 Iniciar Importação'
                )}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="alert alert-success">
              ✅ Importação concluída!
            </div>

            <div className="summary-grid" style={{ marginBottom: '16px' }}>
              <div className="summary-card">
                <div className="label">Total de linhas</div>
                <div className="value">{result.total_rows}</div>
              </div>
              <div className="summary-card">
                <div className="label">Importados</div>
                <div className="value positive">{result.imported}</div>
              </div>
              <div className="summary-card">
                <div className="label">Ignorados</div>
                <div className="value" style={{ color: result.skipped > 0 ? 'var(--warning)' : 'inherit' }}>
                  {result.skipped}
                </div>
              </div>
            </div>

            {result.errors.length > 0 && (
              <div style={{ maxHeight: '200px', overflow: 'auto', marginBottom: '16px' }}>
                <h4 style={{ color: 'var(--danger)', marginBottom: '8px' }}>Erros:</h4>
                {result.errors.map((err, i) => (
                  <div key={i} className="alert alert-error" style={{ fontSize: '0.8rem', padding: '8px 12px' }}>
                    {err}
                  </div>
                ))}
              </div>
            )}

            <div className="modal-footer">
              <button className="btn btn-primary" onClick={onClose}>Fechar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
