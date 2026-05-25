import { useCallback, useEffect, useMemo, useState, useContext } from 'react';
import { AppContext } from '../App';
import { portfolios as portfolioApi, tax as taxApi } from '../api/client';
import { formatMoney } from '@/lib/formatters';
import { Plus, Check, X, Trash2, Edit2, AlertTriangle, FolderOpen, Loader2 } from 'lucide-react';
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from 'sonner';

const EMPTY_PARAMETER_FORM = {
  regime: '',
  valid_from: '',
  valid_until: '',
  tax_rate_percent: '',
  withholding_rate_percent: '',
  exemption_limit: '',
  darf_code: '',
  loss_bucket: '',
  active: true,
  monthly_darf_enabled: true,
};

function todayIso() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeNumberInput(value) {
  return String(value || '').trim().replace(/\./g, '').replace(',', '.');
}

function decimalToPercentInput(value) {
  if (value === null || value === undefined || value === '') return '';
  const parsed = Number(value) * 100;
  if (!Number.isFinite(parsed)) return '';
  return parsed.toLocaleString('pt-BR', { maximumFractionDigits: 6 });
}

function percentInputToBackend(value) {
  if (!String(value || '').trim()) return '0';
  const parsed = Number(normalizeNumberInput(value)) / 100;
  if (!Number.isFinite(parsed)) return '0';
  return String(parsed);
}

function decimalInputToBackend(value) {
  const normalized = normalizeNumberInput(value);
  return normalized || null;
}

function formatPercent(value) {
  const parsed = Number(value) * 100;
  if (!Number.isFinite(parsed)) return '-';
  return `${parsed.toLocaleString('pt-BR', { maximumFractionDigits: 6 })}%`;
}

function parameterStatus(parameter, today) {
  if (!parameter.active) return { label: 'Inativo', variant: 'outline' };
  if (parameter.valid_from > today) return { label: 'Futuro', variant: 'secondary' };
  if (parameter.valid_until && parameter.valid_until < today) return { label: 'Expirado', variant: 'outline' };
  return { label: 'Vigente', variant: 'default' };
}

function parameterToForm(parameter) {
  if (!parameter) return EMPTY_PARAMETER_FORM;
  return {
    regime: parameter.regime || '',
    valid_from: parameter.valid_from || '',
    valid_until: parameter.valid_until || '',
    tax_rate_percent: decimalToPercentInput(parameter.tax_rate),
    withholding_rate_percent: decimalToPercentInput(parameter.withholding_rate),
    exemption_limit: parameter.exemption_limit || '',
    darf_code: parameter.darf_code || '',
    loss_bucket: parameter.loss_bucket || '',
    active: Boolean(parameter.active),
    monthly_darf_enabled: Boolean(parameter.monthly_darf_enabled),
  };
}

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

  const [parameters, setParameters] = useState([]);
  const [loadingParameters, setLoadingParameters] = useState(false);
  const [parameterDialogOpen, setParameterDialogOpen] = useState(false);
  const [editingParameter, setEditingParameter] = useState(null);
  const [parameterForm, setParameterForm] = useState(EMPTY_PARAMETER_FORM);
  const [savingParameter, setSavingParameter] = useState(false);

  const currentDate = useMemo(() => todayIso(), []);

  const loadParameters = useCallback(async () => {
    setLoadingParameters(true);
    try {
      const data = await taxApi.parameters();
      setParameters(data);
    } catch (err) {
      setError(err.message);
      toast.error(err.message || 'Falha ao carregar parâmetros fiscais.');
    } finally {
      setLoadingParameters(false);
    }
  }, []);

  useEffect(() => {
    loadParameters();
  }, [loadParameters]);

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
      toast.success('Carteira criada com sucesso.');
    } catch (err) {
      setError(err.message);
      toast.error(err.message || 'Falha ao criar carteira.');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleConsolidated = async (id, current) => {
    try {
      await portfolioApi.update(id, { consolidated: !current });
      await refreshPortfolios();
      toast.success('Status de consolidação atualizado.');
    } catch (err) {
      setError(err.message);
      toast.error(err.message || 'Falha ao atualizar carteira.');
    }
  };

  const handleRename = async (id) => {
    if (!editName.trim()) return;
    try {
      await portfolioApi.update(id, { name: editName.trim() });
      setEditingId(null);
      await refreshPortfolios();
      toast.success('Nome da carteira atualizado.');
    } catch (err) {
      setError(err.message);
      toast.error(err.message || 'Falha ao renomear carteira.');
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
      toast.success('Carteira excluída com sucesso.');
    } catch (err) {
      setError(err.message);
      toast.error(err.message || 'Falha ao excluir carteira.');
    } finally {
      setDeleting(false);
    }
  };

  const openCreateParameter = () => {
    setEditingParameter(null);
    setParameterForm(EMPTY_PARAMETER_FORM);
    setParameterDialogOpen(true);
  };

  const openEditParameter = (parameter) => {
    setEditingParameter(parameter);
    setParameterForm(parameterToForm(parameter));
    setParameterDialogOpen(true);
  };

  const updateParameterForm = (field, value) => {
    setParameterForm((current) => ({ ...current, [field]: value }));
  };

  const parameterPayload = () => ({
    regime: parameterForm.regime.trim(),
    valid_from: parameterForm.valid_from,
    valid_until: parameterForm.valid_until || null,
    tax_rate: percentInputToBackend(parameterForm.tax_rate_percent),
    withholding_rate: percentInputToBackend(parameterForm.withholding_rate_percent),
    exemption_limit: decimalInputToBackend(parameterForm.exemption_limit),
    darf_code: parameterForm.darf_code.trim() || null,
    loss_bucket: parameterForm.loss_bucket.trim() || null,
    active: parameterForm.active,
    monthly_darf_enabled: parameterForm.monthly_darf_enabled,
  });

  const saveParameter = async (e) => {
    e.preventDefault();
    setSavingParameter(true);
    setError('');
    try {
      const payload = parameterPayload();
      if (editingParameter) {
        await taxApi.updateParameter(editingParameter.id, payload);
        toast.success('Parâmetro fiscal atualizado.');
      } else {
        await taxApi.createParameter(payload);
        toast.success('Parâmetro fiscal criado.');
      }
      setParameterDialogOpen(false);
      await loadParameters();
    } catch (err) {
      setError(err.message);
      toast.error(err.message || 'Falha ao salvar parâmetro fiscal.');
    } finally {
      setSavingParameter(false);
    }
  };

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Configurações</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">Gerencie carteiras e parâmetros fiscais temporais.</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="shrink-0" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="portfolios" className="gap-5">
        <TabsList>
          <TabsTrigger value="portfolios">Carteiras</TabsTrigger>
          <TabsTrigger value="tax-parameters">Parâmetros fiscais</TabsTrigger>
        </TabsList>

        <TabsContent value="portfolios" className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Nova Carteira</CardTitle>
              <CardDescription>Crie uma nova carteira para segregar seus investimentos.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreate} className="flex items-center gap-3">
                <Input
                  className="flex-1"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Nome da carteira..."
                  required
                />
                <Button type="submit" disabled={creating}>
                  {creating ? (
                    <><Loader2 data-icon="inline-start" className="animate-spin" /> Criando...</>
                  ) : (
                    <><Plus data-icon="inline-start" /> Criar</>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">Carteiras Cadastradas</h3>

            {portfolioList.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <FolderOpen className="mb-3 text-muted-foreground/40" />
                  <h3 className="mb-1 text-base font-medium">Nenhuma carteira cadastrada</h3>
                  <p className="max-w-sm text-sm text-muted-foreground">Crie sua primeira carteira acima para começar.</p>
                </CardContent>
              </Card>
            ) : (
              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
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
                          <TableCell className="font-mono text-xs text-muted-foreground">{p.id}</TableCell>
                          <TableCell>
                            {editingId === p.id ? (
                              <div className="flex items-center gap-2">
                                <Input
                                  className="h-8 w-full max-w-[200px] text-sm"
                                  value={editName}
                                  onChange={(e) => setEditName(e.target.value)}
                                  onKeyDown={(e) => e.key === 'Enter' && handleRename(p.id)}
                                  autoFocus
                                />
                                <Button size="icon-sm" variant="ghost" onClick={() => handleRename(p.id)}>
                                  <Check />
                                </Button>
                                <Button size="icon-sm" variant="ghost" onClick={() => setEditingId(null)}>
                                  <X />
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
                          <TableCell className="text-sm text-muted-foreground">{p.created_at?.slice(0, 10)}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button size="icon-sm" variant="ghost" onClick={() => { setEditingId(p.id); setEditName(p.name); }}>
                                <Edit2 />
                              </Button>
                              <Button size="icon-sm" variant="ghost" className="text-destructive" onClick={() => handleDeleteRequest(p)}>
                                <Trash2 />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="tax-parameters" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Parâmetros fiscais</h3>
              <p className="text-sm text-muted-foreground">Vigências usadas pelo backend na apuração por data do fato gerador.</p>
            </div>
            <Button onClick={openCreateParameter}>
              <Plus data-icon="inline-start" />
              Novo parâmetro
            </Button>
          </div>

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Regime</TableHead>
                    <TableHead>Vigência inicial</TableHead>
                    <TableHead>Vigência final</TableHead>
                    <TableHead className="text-right">Alíquota</TableHead>
                    <TableHead className="text-right">IRRF</TableHead>
                    <TableHead className="text-right">Limite isenção</TableHead>
                    <TableHead>DARF</TableHead>
                    <TableHead>Regra de compensação</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadingParameters ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                        Carregando parâmetros fiscais...
                      </TableCell>
                    </TableRow>
                  ) : parameters.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                        Nenhum parâmetro fiscal cadastrado.
                      </TableCell>
                    </TableRow>
                  ) : (
                    parameters.map((parameter) => {
                      const status = parameterStatus(parameter, currentDate);
                      return (
                        <TableRow key={parameter.id}>
                          <TableCell className="font-medium">{parameter.regime}</TableCell>
                          <TableCell className="font-mono text-xs">{parameter.valid_from}</TableCell>
                          <TableCell className="font-mono text-xs">{parameter.valid_until || '-'}</TableCell>
                          <TableCell className="text-right font-mono">{formatPercent(parameter.tax_rate)}</TableCell>
                          <TableCell className="text-right font-mono">{formatPercent(parameter.withholding_rate)}</TableCell>
                          <TableCell className="text-right font-mono">
                            {parameter.exemption_limit ? `R$ ${formatMoney(parameter.exemption_limit)}` : '-'}
                          </TableCell>
                          <TableCell className="font-mono">{parameter.darf_code || '-'}</TableCell>
                          <TableCell>{parameter.loss_bucket || '-'}</TableCell>
                          <TableCell>
                            <Badge variant={status.variant}>{status.label}</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button size="icon-sm" variant="ghost" onClick={() => openEditParameter(parameter)}>
                              <Edit2 />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={parameterDialogOpen} onOpenChange={setParameterDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingParameter ? 'Editar parâmetro fiscal' : 'Novo parâmetro fiscal'}</DialogTitle>
            <DialogDescription>
              A vigência ativa não pode sobrepor outro registro ativo do mesmo regime.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={saveParameter} className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Regime
                <Input
                  value={parameterForm.regime}
                  onChange={(e) => updateParameterForm('regime', e.target.value)}
                  placeholder="B3_COMMON_15"
                  required
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Regra de compensação
                <Input
                  value={parameterForm.loss_bucket}
                  onChange={(e) => updateParameterForm('loss_bucket', e.target.value)}
                  placeholder="B3_COMMON"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Vigência inicial
                <Input
                  type="date"
                  value={parameterForm.valid_from}
                  onChange={(e) => updateParameterForm('valid_from', e.target.value)}
                  required
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Vigência final
                <Input
                  type="date"
                  value={parameterForm.valid_until}
                  onChange={(e) => updateParameterForm('valid_until', e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Alíquota (%)
                <Input
                  value={parameterForm.tax_rate_percent}
                  onChange={(e) => updateParameterForm('tax_rate_percent', e.target.value)}
                  placeholder="15"
                  inputMode="decimal"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                IRRF (%)
                <Input
                  value={parameterForm.withholding_rate_percent}
                  onChange={(e) => updateParameterForm('withholding_rate_percent', e.target.value)}
                  placeholder="0,005"
                  inputMode="decimal"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Limite isenção
                <Input
                  value={parameterForm.exemption_limit}
                  onChange={(e) => updateParameterForm('exemption_limit', e.target.value)}
                  placeholder="20000"
                  inputMode="decimal"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                DARF
                <Input
                  value={parameterForm.darf_code}
                  onChange={(e) => updateParameterForm('darf_code', e.target.value)}
                  placeholder="6015"
                />
              </label>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Ativo</p>
                <p className="text-xs text-muted-foreground">Registros inativos não entram na escolha temporal do cálculo.</p>
              </div>
              <Switch
                checked={parameterForm.active}
                onCheckedChange={(value) => updateParameterForm('active', value)}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setParameterDialogOpen(false)} disabled={savingParameter}>
                Cancelar
              </Button>
              <Button type="submit" disabled={savingParameter}>
                {savingParameter ? (
                  <><Loader2 data-icon="inline-start" className="animate-spin" /> Salvando...</>
                ) : (
                  <><Check data-icon="inline-start" /> Salvar</>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!portfolioToDelete} onOpenChange={(v) => { if (!v) setPortfolioToDelete(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Excluir Carteira</DialogTitle>
            <DialogDescription>
              Esta ação excluirá a carteira <strong>{portfolioToDelete?.name}</strong> e <strong>todos os seus eventos</strong> definitivamente. Não há como reverter.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
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
                <><Loader2 data-icon="inline-start" className="animate-spin" /> Excluindo...</>
              ) : (
                <><Trash2 data-icon="inline-start" /> Excluir</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
