import { useState, useContext } from 'react';
import { AppContext } from '../App';
import { portfolios as portfolioApi } from '../api/client';
import { Plus, Check, X, Trash2, Edit2, AlertTriangle, FolderOpen, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

export default function Settings() {
  const { portfolioList, refreshPortfolios, activePortfolioId, setActivePortfolioId } = useContext(AppContext);

  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

  const [portfolioToDelete, setPortfolioToDelete] = useState(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

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

  const handleDeleteRequest = (p) => {
    setPortfolioToDelete(p);
    setDeleteConfirmText('');
  };

  const confirmDelete = async () => {
    if (!portfolioToDelete || deleteConfirmText !== portfolioToDelete.name) return;
    setDeleting(true);
    try {
      await portfolioApi.delete(portfolioToDelete.id);
      if (activePortfolioId === portfolioToDelete.id) {
        setActivePortfolioId(null);
      }
      setPortfolioToDelete(null);
      await refreshPortfolios();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Configurações</h2>
        <p className="text-muted-foreground text-sm mt-0.5">Gerencie suas carteiras e preferências.</p>
      </div>

      {error && (
        <div className="p-3 bg-destructive/10 text-destructive rounded-lg flex items-start gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {/* Create form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nova Carteira</CardTitle>
          <CardDescription>Crie uma nova carteira para segregar seus investimentos.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex gap-3 items-center">
            <Input
              className="flex-1"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nome da carteira..."
              required
            />
            <Button type="submit" disabled={creating}>
              {creating ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Criando...</>
              ) : (
                <><Plus className="w-4 h-4" /> Criar</>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Portfolio list */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold">Carteiras Cadastradas</h3>

        {portfolioList.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <FolderOpen className="w-10 h-10 text-muted-foreground/40 mb-3" />
              <h3 className="text-base font-medium mb-1">Nenhuma carteira cadastrada</h3>
              <p className="text-muted-foreground text-sm max-w-sm">Crie sua primeira carteira acima para começar.</p>
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">ID</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead className="w-28 text-center">Consolidada</TableHead>
                  <TableHead className="w-28">Criada em</TableHead>
                  <TableHead className="w-20 text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {portfolioList.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-muted-foreground font-mono text-xs">{p.id}</TableCell>
                    <TableCell>
                      {editingId === p.id ? (
                        <div className="flex gap-2 items-center">
                          <Input
                            className="h-8 text-sm w-full max-w-[200px]"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleRename(p.id)}
                            autoFocus
                          />
                          <Button size="icon-sm" variant="ghost" onClick={() => handleRename(p.id)}>
                            <Check className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="icon-sm" variant="ghost" onClick={() => setEditingId(null)}>
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <span className="font-medium">{p.name}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={p.consolidated}
                        onCheckedChange={() => handleToggleConsolidated(p.id, p.consolidated)}
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">{p.created_at?.slice(0, 10)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="icon-sm" variant="ghost" onClick={() => { setEditingId(p.id); setEditName(p.name); }}>
                          <Edit2 className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="icon-sm" variant="ghost" className="text-destructive" onClick={() => handleDeleteRequest(p)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!portfolioToDelete} onOpenChange={(v) => { if (!v) setPortfolioToDelete(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Excluir Carteira</DialogTitle>
            <DialogDescription>
              Esta ação excluirá a carteira <strong>{portfolioToDelete?.name}</strong> e <strong>todos os seus eventos</strong> definitivamente. Não há como reverter.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Para confirmar, digite o nome da carteira (<strong>{portfolioToDelete?.name}</strong>):
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={portfolioToDelete?.name}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPortfolioToDelete(null)} disabled={deleting}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteConfirmText !== portfolioToDelete?.name || deleting}
            >
              {deleting ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Excluindo...</>
              ) : (
                <><Trash2 className="w-4 h-4" /> Excluir</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
