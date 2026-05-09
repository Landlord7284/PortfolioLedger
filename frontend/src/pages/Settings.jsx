import { useState, useContext } from 'react';
import { AppContext } from '../App';
import { portfolios as portfolioApi } from '../api/client';

export default function Settings() {
  const { portfolioList, refreshPortfolios, activePortfolioId, setActivePortfolioId } = useContext(AppContext);

  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError('');
    try {
      const p = await portfolioApi.create({ name: newName.trim(), consolidated: true });
      setNewName('');
      await refreshPortfolios();
      if (!activePortfolioId) {
        setActivePortfolioId(p.id);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleToggleConsolidated = async (id, current) => {
    try {
      await portfolioApi.update(id, { consolidated: !current });
      await refreshPortfolios();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRename = async (id) => {
    if (!editName.trim()) return;
    try {
      await portfolioApi.update(id, { name: editName.trim() });
      setEditingId(null);
      await refreshPortfolios();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Tem certeza que deseja excluir esta carteira?')) return;
    try {
      await portfolioApi.delete(id);
      if (activePortfolioId === id) {
        setActivePortfolioId(null);
      }
      await refreshPortfolios();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      <h2 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '24px' }}>
        Gerenciar Carteiras
      </h2>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Create form */}
      <div className="card mb-24">
        <div className="card-title mb-16">Nova Carteira</div>
        <form onSubmit={handleCreate} className="flex gap-12 items-center">
          <input
            className="form-input"
            style={{ flex: 1 }}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Nome da carteira..."
            required
          />
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? 'Criando...' : '+ Criar'}
          </button>
        </form>
      </div>

      {/* Portfolio list */}
      {portfolioList.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📁</div>
          <h3>Nenhuma carteira cadastrada</h3>
          <p>Crie sua primeira carteira para começar a registrar eventos.</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Nome</th>
                <th>Consolidada</th>
                <th>Criada em</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {portfolioList.map((p) => (
                <tr key={p.id}>
                  <td className="text-muted mono">{p.id}</td>
                  <td>
                    {editingId === p.id ? (
                      <div className="flex gap-8">
                        <input
                          className="form-input"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleRename(p.id)}
                          autoFocus
                          style={{ padding: '4px 8px', fontSize: '0.85rem' }}
                        />
                        <button className="btn btn-sm btn-primary" onClick={() => handleRename(p.id)}>✓</button>
                        <button className="btn btn-sm btn-secondary" onClick={() => setEditingId(null)}>✕</button>
                      </div>
                    ) : (
                      <strong>{p.name}</strong>
                    )}
                  </td>
                  <td>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={p.consolidated}
                        onChange={() => handleToggleConsolidated(p.id, p.consolidated)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                  </td>
                  <td className="text-muted">{p.created_at?.slice(0, 10)}</td>
                  <td>
                    <div className="flex gap-8">
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => { setEditingId(p.id); setEditName(p.name); }}
                      >
                        ✏️
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDelete(p.id)}
                      >
                        🗑️
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
