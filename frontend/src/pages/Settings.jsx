import { useCallback, useEffect, useMemo, useState, useContext } from 'react';
import { AppContext } from '../App';
import { portfolios as portfolioApi, tax as taxApi } from '../api/client';
import { formatMoney } from '@/lib/formatters';
import { Plus, Check, X, Trash2, Edit2, AlertTriangle, FolderOpen, Loader2, Wallet, FileText, RefreshCw, ChevronDown, ChevronRight, History, SlidersHorizontal } from 'lucide-react';
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from 'sonner';

const EMPTY_PARAMETER_FORM = {
  regime: '',
  valid_from: '',
  valid_until: '',
  tax_rate_percent: '',
  withholding_rate_percent: '',
  exemption_limit: '',
  darf_code: '',
  minimum_darf_amount: '10,00',
  loss_bucket: '',
  active: true,
  monthly_darf_enabled: true,
};

const EMPTY_SUCCESSOR_FORM = {
  valid_from: '',
  tax_rate_percent: '',
  withholding_rate_percent: '',
  exemption_limit: '',
  darf_code: '',
  minimum_darf_amount: '10,00',
  monthly_darf_enabled: true,
};

const SUPPORTED_TAX_REGIMES = [
  {
    code: 'B3_COMMON_15',
    label: 'Ações, ETF e BDR',
    description: 'Operações comuns B3 com regra de isenção mensal para ações brasileiras.',
  },
  {
    code: 'B3_FII_FIAGRO_20',
    label: 'FII e Fiagro',
    description: 'Apuração mensal de fundos imobiliários e Fiagro.',
  },
  {
    code: 'FI_INFRA_EXEMPT',
    label: 'FI-INFRA',
    description: 'Parâmetros vigentes definem se o regime opera como isento ou tributado.',
  },
  {
    code: 'CRYPTO_GCAP',
    label: 'Criptoativos',
    description: 'Regime acompanhado fora da DARF mensal padrão quando configurado assim.',
  },
  {
    code: 'FOREIGN_ASSETS_POST_2024',
    label: 'Exterior',
    description: 'Ativos no exterior como Stock, REIT e ETF de market = US. Parâmetro anual pós-2024, sem DARF mensal nacional.',
  },
];

const PARAMETER_PRESETS = {
  FI_INFRA_EXEMPT: {
    tax_rate_percent: '0',
    withholding_rate_percent: '0',
    exemption_limit: '',
    darf_code: '',
    minimum_darf_amount: '10,00',
    loss_bucket: '',
    monthly_darf_enabled: false,
  },
  FOREIGN_ASSETS_POST_2024: {
    tax_rate_percent: '15',
    withholding_rate_percent: '0',
    exemption_limit: '',
    darf_code: '',
    minimum_darf_amount: '0,00',
    loss_bucket: '',
    monthly_darf_enabled: false,
  },
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

function formatCurrencyValue(value) {
  return value ? `R$ ${formatMoney(value)}` : '-';
}

function formatBoolean(value) {
  return value ? 'Sim' : 'Não';
}

function isCurrentParameter(parameter, today) {
  return Boolean(
    parameter?.active &&
    parameter.valid_from <= today &&
    (!parameter.valid_until || parameter.valid_until >= today)
  );
}

function parameterStatus(parameter, today) {
  if (!parameter.active) return { label: 'Inativo', variant: 'outline' };
  if (parameter.valid_from > today) return { label: 'Futura', variant: 'secondary' };
  if (parameter.valid_until && parameter.valid_until < today) return { label: 'Histórica', variant: 'outline' };
  return { label: 'Atual', variant: 'default' };
}

function formatDate(value) {
  if (!value) return '-';
  const [year, month, day] = String(value).slice(0, 10).split('-');
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
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
    minimum_darf_amount: parameter.minimum_darf_amount || '10.00',
    loss_bucket: parameter.loss_bucket || '',
    active: Boolean(parameter.active),
    monthly_darf_enabled: Boolean(parameter.monthly_darf_enabled),
  };
}

function parameterToSuccessorForm(parameter) {
  if (!parameter) return EMPTY_SUCCESSOR_FORM;
  return {
    ...EMPTY_SUCCESSOR_FORM,
    tax_rate_percent: decimalToPercentInput(parameter.tax_rate),
    withholding_rate_percent: decimalToPercentInput(parameter.withholding_rate),
    exemption_limit: parameter.exemption_limit || '',
    darf_code: parameter.darf_code || '',
    minimum_darf_amount: parameter.minimum_darf_amount || '10.00',
    monthly_darf_enabled: Boolean(parameter.monthly_darf_enabled),
  };
}

export default function Settings() {
  const { portfolioList, portfolioLoadError, refreshPortfolios, activePortfolioId, setActivePortfolioId } = useContext(AppContext);

  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

  const [portfolioToDelete, setPortfolioToDelete] = useState(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const [parameters, setParameters] = useState([]);
  const [loadingParameters, setLoadingParameters] = useState(false);
  const [parameterLoadError, setParameterLoadError] = useState('');
  const [parameterDialogOpen, setParameterDialogOpen] = useState(false);
  const [editingParameter, setEditingParameter] = useState(null);
  const [parameterForm, setParameterForm] = useState(EMPTY_PARAMETER_FORM);
  const [savingParameter, setSavingParameter] = useState(false);
  const [successorDialogOpen, setSuccessorDialogOpen] = useState(false);
  const [successorBaseParameter, setSuccessorBaseParameter] = useState(null);
  const [successorForm, setSuccessorForm] = useState(EMPTY_SUCCESSOR_FORM);
  const [savingSuccessor, setSavingSuccessor] = useState(false);
  const [expandedRegimes, setExpandedRegimes] = useState(new Set());

  const currentDate = useMemo(() => todayIso(), []);
  const regimeGroups = useMemo(() => {
    return SUPPORTED_TAX_REGIMES.map((regime) => {
      const rows = parameters
        .filter((parameter) => parameter.regime === regime.code)
        .sort((a, b) => {
          if (a.valid_from !== b.valid_from) return b.valid_from.localeCompare(a.valid_from);
          return b.id - a.id;
        });
      return {
        ...regime,
        rows,
        current: rows.find((parameter) => isCurrentParameter(parameter, currentDate)) || null,
      };
    });
  }, [parameters, currentDate]);

  const loadParameters = useCallback(async () => {
    setLoadingParameters(true);
    setParameterLoadError('');
    try {
      const data = await taxApi.parameters();
      setParameters(data);
    } catch (err) {
      const message = err.message || 'Falha ao carregar parâmetros fiscais.';
      setParameterLoadError(message);
      toast.error(message);
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
    setActionError('');
    try {
      const p = await portfolioApi.create({ name: newName.trim(), consolidated: true });
      setNewName('');
      setActionError('');
      await refreshPortfolios();
      if (!activePortfolioId) {
        setActivePortfolioId(p.id);
      }
      toast.success('Carteira criada com sucesso.');
    } catch (err) {
      setActionError(err.message);
      toast.error(err.message || 'Falha ao criar carteira.');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleConsolidated = async (id, current) => {
    try {
      await portfolioApi.update(id, { consolidated: !current });
      setActionError('');
      await refreshPortfolios();
      toast.success('Status de consolidação atualizado.');
    } catch (err) {
      setActionError(err.message);
      toast.error(err.message || 'Falha ao atualizar carteira.');
    }
  };

  const handleRename = async (id) => {
    if (!editName.trim()) return;
    try {
      await portfolioApi.update(id, { name: editName.trim() });
      setEditingId(null);
      setActionError('');
      await refreshPortfolios();
      toast.success('Nome da carteira atualizado.');
    } catch (err) {
      setActionError(err.message);
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
      setDeleteConfirmText('');
      setActionError('');
      await refreshPortfolios();
      toast.success('Carteira excluída com sucesso.');
    } catch (err) {
      setActionError(err.message);
      toast.error(err.message || 'Falha ao excluir carteira.');
    } finally {
      setDeleting(false);
    }
  };

  const openCreateParameter = () => {
    setEditingParameter(null);
    setParameterForm({ ...EMPTY_PARAMETER_FORM, regime: SUPPORTED_TAX_REGIMES[0].code });
    setParameterDialogOpen(true);
  };

  const openEditParameter = (parameter) => {
    setEditingParameter(parameter);
    setParameterForm(parameterToForm(parameter));
    setParameterDialogOpen(true);
  };

  const openCreateSuccessor = (parameter) => {
    setSuccessorBaseParameter(parameter);
    setSuccessorForm(parameterToSuccessorForm(parameter));
    setSuccessorDialogOpen(true);
  };

  const updateParameterForm = (field, value) => {
    setParameterForm((current) => {
      if (field === 'regime' && !editingParameter) {
        const normalized = String(value || '').trim().toUpperCase();
        const preset = PARAMETER_PRESETS[normalized];
        if (preset) return { ...current, ...preset, regime: normalized };
      }
      return { ...current, [field]: value };
    });
  };

  const updateSuccessorForm = (field, value) => {
    setSuccessorForm((current) => ({ ...current, [field]: value }));
  };

  const toggleRegimeHistory = (regime) => {
    setExpandedRegimes((current) => {
      const next = new Set(current);
      if (next.has(regime)) {
        next.delete(regime);
      } else {
        next.add(regime);
      }
      return next;
    });
  };

  const parameterPayload = () => ({
    regime: parameterForm.regime.trim(),
    valid_from: parameterForm.valid_from,
    valid_until: parameterForm.valid_until || null,
    tax_rate: percentInputToBackend(parameterForm.tax_rate_percent),
    withholding_rate: percentInputToBackend(parameterForm.withholding_rate_percent),
    exemption_limit: decimalInputToBackend(parameterForm.exemption_limit),
    darf_code: parameterForm.darf_code.trim() || null,
    minimum_darf_amount: decimalInputToBackend(parameterForm.minimum_darf_amount) || '0',
    loss_bucket: parameterForm.loss_bucket.trim() || null,
    active: parameterForm.active,
    monthly_darf_enabled: parameterForm.monthly_darf_enabled,
  });

  const successorPayload = () => ({
    valid_from: successorForm.valid_from,
    tax_rate: percentInputToBackend(successorForm.tax_rate_percent),
    withholding_rate: percentInputToBackend(successorForm.withholding_rate_percent),
    exemption_limit: decimalInputToBackend(successorForm.exemption_limit),
    darf_code: successorForm.darf_code.trim() || null,
    minimum_darf_amount: decimalInputToBackend(successorForm.minimum_darf_amount) || '0',
    monthly_darf_enabled: successorForm.monthly_darf_enabled,
  });

  const saveParameter = async (e) => {
    e.preventDefault();
    setSavingParameter(true);
    setActionError('');
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
      setActionError('');
      await loadParameters();
    } catch (err) {
      setActionError(err.message);
      toast.error(err.message || 'Falha ao salvar parâmetro fiscal.');
    } finally {
      setSavingParameter(false);
    }
  };

  const saveSuccessor = async (e) => {
    e.preventDefault();
    if (!successorBaseParameter) return;
    setSavingSuccessor(true);
    setActionError('');
    try {
      await taxApi.createParameterSuccessor(successorBaseParameter.id, successorPayload());
      setSuccessorDialogOpen(false);
      setSuccessorBaseParameter(null);
      setActionError('');
      await loadParameters();
      toast.success('Nova vigência fiscal criada.');
    } catch (err) {
      setActionError(err.message);
      toast.error(err.message || 'Falha ao criar nova vigência fiscal.');
    } finally {
      setSavingSuccessor(false);
    }
  };

  return (
    <div className="flex w-full max-w-7xl flex-col gap-6">
      {actionError && (
        <Alert variant="destructive">
          <AlertTriangle className="shrink-0" />
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="portfolios" className="flex flex-col gap-5">
        <div className="overflow-x-auto pb-1">
          <TabsList className="min-w-max justify-start">
            <TabsTrigger value="portfolios" className="h-9 flex-none px-3">
              <Wallet data-icon="inline-start" />
              Carteiras
            </TabsTrigger>
            <TabsTrigger value="tax-parameters" className="h-9 flex-none px-3">
              <FileText data-icon="inline-start" />
              Parâmetros fiscais
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="portfolios" className="flex flex-col gap-6">
          {portfolioLoadError && (
            <Alert variant="destructive" className="items-center">
              <AlertTriangle className="shrink-0" />
              <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>{portfolioLoadError}</span>
                <Button type="button" variant="outline" size="sm" onClick={refreshPortfolios}>
                  <RefreshCw data-icon="inline-start" />
                  Tentar novamente
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Nova carteira</CardTitle>
              <CardDescription>Crie uma nova carteira para segregar seus investimentos.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreate} className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Input
                  className="sm:flex-1"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Nome da carteira"
                  required
                />
                <Button type="submit" disabled={creating || !newName.trim()}>
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
            <div>
              <h3 className="text-base font-semibold">Carteiras cadastradas</h3>
              <p className="text-sm text-muted-foreground">Renomeie, consolide ou exclua carteiras existentes.</p>
            </div>
            {portfolioLoadError ? (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <AlertTriangle className="mb-3 text-destructive" />
                  <h3 className="mb-1 text-base font-medium">Carteiras indisponíveis</h3>
                  <p className="max-w-sm text-sm text-muted-foreground">Não foi possível carregar as carteiras do backend.</p>
                </CardContent>
              </Card>
            ) : portfolioList.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <FolderOpen className="mb-3 text-muted-foreground" />
                  <h3 className="mb-1 text-base font-medium">Nenhuma carteira cadastrada</h3>
                  <p className="max-w-sm text-sm text-muted-foreground">Crie sua primeira carteira acima para começar.</p>
                </CardContent>
              </Card>
            ) : (
              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">ID</TableHead>
                        <TableHead>Nome</TableHead>
                        <TableHead className="w-24">Status</TableHead>
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
                                  className="h-8 min-w-0 text-sm"
                                  value={editName}
                                  onChange={(e) => setEditName(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleRename(p.id);
                                    if (e.key === 'Escape') setEditingId(null);
                                  }}
                                  autoFocus
                                />
                                <Button size="icon-sm" variant="ghost" onClick={() => handleRename(p.id)} aria-label="Salvar nome">
                                  <Check />
                                </Button>
                                <Button size="icon-sm" variant="ghost" onClick={() => setEditingId(null)} aria-label="Cancelar edição">
                                  <X />
                                </Button>
                              </div>
                            ) : (
                              <span className="block truncate font-medium" title={p.name}>{p.name}</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {activePortfolioId === p.id ? <Badge>Ativa</Badge> : <Badge variant="outline">Disponível</Badge>}
                          </TableCell>
                          <TableCell className="text-center">
                            <Switch
                              checked={p.consolidated}
                              onCheckedChange={() => handleToggleConsolidated(p.id, p.consolidated)}
                            />
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{formatDate(p.created_at)}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button size="icon-sm" variant="ghost" onClick={() => { setEditingId(p.id); setEditName(p.name); }} aria-label="Renomear carteira">
                                <Edit2 />
                              </Button>
                              <Button size="icon-sm" variant="ghost" className="text-destructive" onClick={() => handleDeleteRequest(p)} aria-label="Excluir carteira">
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
          {parameterLoadError && (
            <Alert variant="destructive" className="items-center">
              <AlertTriangle className="shrink-0" />
              <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>{parameterLoadError}</span>
                <Button type="button" variant="outline" size="sm" onClick={loadParameters} disabled={loadingParameters}>
                  {loadingParameters ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <RefreshCw data-icon="inline-start" />
                  )}
                  Tentar novamente
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <Tabs defaultValue="regimes" className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="overflow-x-auto pb-1">
                <TabsList className="min-w-max justify-start">
                  <TabsTrigger value="regimes" className="h-9 flex-none px-3">
                    <History data-icon="inline-start" />
                    Regimes fiscais
                  </TabsTrigger>
                  <TabsTrigger value="advanced" className="h-9 flex-none px-3">
                    <SlidersHorizontal data-icon="inline-start" />
                    Modo avançado
                  </TabsTrigger>
                </TabsList>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={loadParameters} disabled={loadingParameters}>
                {loadingParameters ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <RefreshCw data-icon="inline-start" />
                )}
                Atualizar
              </Button>
            </div>

            <TabsContent value="regimes" className="flex flex-col gap-4">
              {loadingParameters ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <Card key={index}>
                    <CardHeader>
                      <Skeleton className="h-5 w-48" />
                      <Skeleton className="h-4 w-72" />
                    </CardHeader>
                    <CardContent>
                      <Skeleton className="h-28" />
                    </CardContent>
                  </Card>
                ))
              ) : parameterLoadError ? (
                <Card className="border-dashed">
                  <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                    <AlertTriangle className="mb-3 text-destructive" />
                    <h3 className="mb-1 text-base font-medium">Parâmetros fiscais indisponíveis</h3>
                    <p className="max-w-sm text-sm text-muted-foreground">Não foi possível carregar as regras fiscais do backend.</p>
                  </CardContent>
                </Card>
              ) : (
                regimeGroups.map((group) => {
                  const current = group.current;
                  const historyOpen = expandedRegimes.has(group.code);
                  const isForeignRegime = group.code === 'FOREIGN_ASSETS_POST_2024';
                  return (
                    <Card key={group.code} className="overflow-hidden">
                      <CardHeader>
                        <div className="flex min-w-0 flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <CardTitle className="text-lg">{group.label}</CardTitle>
                            {current ? <Badge>Atual</Badge> : <Badge variant="outline">Sem vigente</Badge>}
                          </div>
                          <CardDescription>{group.description}</CardDescription>
                          <span className="font-mono text-xs text-muted-foreground">Código técnico: {group.code}</span>
                        </div>
                        <CardAction className="col-span-full row-start-auto justify-self-start sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:justify-self-end">
                          <Button
                            className="h-auto min-h-8 whitespace-normal text-left sm:h-8 sm:whitespace-nowrap"
                            onClick={() => openCreateSuccessor(current)}
                            disabled={!current}
                          >
                            <Plus data-icon="inline-start" />
                            Alterar regra a partir de uma data
                          </Button>
                        </CardAction>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-4">
                        {current ? (
                          isForeignRegime ? (
                            <div className="grid gap-3 sm:grid-cols-2">
                              <div className="rounded-md border p-3">
                                <p className="text-xs text-muted-foreground">Alíquota</p>
                                <p className="font-mono text-sm font-medium">{formatPercent(current.tax_rate)}</p>
                              </div>
                              <div className="rounded-md border p-3">
                                <p className="text-xs text-muted-foreground">Vigência</p>
                                <p className="font-mono text-sm font-medium">
                                  Desde {formatDate(current.valid_from)}
                                  {current.valid_until ? ` até ${formatDate(current.valid_until)}` : ''}
                                </p>
                              </div>
                            </div>
                          ) : (
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                              <div className="rounded-md border p-3">
                                <p className="text-xs text-muted-foreground">Alíquota</p>
                                <p className="font-mono text-sm font-medium">{formatPercent(current.tax_rate)}</p>
                              </div>
                              <div className="rounded-md border p-3">
                                <p className="text-xs text-muted-foreground">IRRF teórico</p>
                                <p className="font-mono text-sm font-medium">{formatPercent(current.withholding_rate)}</p>
                              </div>
                              <div className="rounded-md border p-3">
                                <p className="text-xs text-muted-foreground">Limite de isenção</p>
                                <p className="font-mono text-sm font-medium">{formatCurrencyValue(current.exemption_limit)}</p>
                              </div>
                              <div className="rounded-md border p-3">
                                <p className="text-xs text-muted-foreground">DARF mensal</p>
                                <p className="text-sm font-medium">{formatBoolean(current.monthly_darf_enabled)}</p>
                              </div>
                              <div className="rounded-md border p-3">
                                <p className="text-xs text-muted-foreground">Código DARF</p>
                                <p className="font-mono text-sm font-medium">{current.darf_code || '-'}</p>
                              </div>
                              <div className="rounded-md border p-3">
                                <p className="text-xs text-muted-foreground">DARF mínima</p>
                                <p className="font-mono text-sm font-medium">{formatCurrencyValue(current.minimum_darf_amount)}</p>
                              </div>
                              <div className="rounded-md border p-3 sm:col-span-2">
                                <p className="text-xs text-muted-foreground">Vigência</p>
                                <p className="font-mono text-sm font-medium">
                                  Desde {formatDate(current.valid_from)}
                                  {current.valid_until ? ` até ${formatDate(current.valid_until)}` : ''}
                                </p>
                              </div>
                            </div>
                          )
                        ) : (
                          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                            Este regime não tem uma configuração ativa para a data atual. Use o modo avançado para criar ou reparar a vigência.
                          </div>
                        )}

                        <div className="flex items-center justify-between gap-3 border-t pt-4">
                          <div>
                            <h4 className="text-sm font-medium">Histórico de vigências</h4>
                            <p className="text-xs text-muted-foreground">{group.rows.length} registro(s) fiscal(is) neste regime.</p>
                          </div>
                          <Button type="button" variant="outline" size="sm" onClick={() => toggleRegimeHistory(group.code)}>
                            {historyOpen ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
                            {historyOpen ? 'Ocultar histórico' : 'Ver histórico'}
                          </Button>
                        </div>

                        {historyOpen && (
                          <div className="overflow-hidden rounded-md border">
                            {group.rows.length === 0 ? (
                              <div className="p-4 text-sm text-muted-foreground">Nenhuma vigência cadastrada para este regime.</div>
                            ) : (
                              <div className="divide-y">
                                {group.rows.map((parameter) => {
                                  const status = parameterStatus(parameter, currentDate);
                                  return (
                                    <div key={parameter.id} className="grid gap-3 p-4 md:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]">
                                      <div className="flex flex-col gap-2">
                                        <Badge variant={status.variant} className="w-fit">{status.label}</Badge>
                                        <span className="font-mono text-xs text-muted-foreground">
                                          {formatDate(parameter.valid_from)} até {formatDate(parameter.valid_until)}
                                        </span>
                                      </div>
                                      <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                                        <span>Alíquota: <span className="font-mono">{formatPercent(parameter.tax_rate)}</span></span>
                                        {isForeignRegime ? (
                                          <span>Vigência: <span className="font-mono">{formatDate(parameter.valid_from)} até {formatDate(parameter.valid_until)}</span></span>
                                        ) : (
                                          <>
                                            <span>IRRF: <span className="font-mono">{formatPercent(parameter.withholding_rate)}</span></span>
                                            <span>DARF mensal: {formatBoolean(parameter.monthly_darf_enabled)}</span>
                                            <span>Código DARF: <span className="font-mono">{parameter.darf_code || '-'}</span></span>
                                          </>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </TabsContent>

            <TabsContent value="advanced" className="flex flex-col gap-4">
              <Alert>
                <AlertTriangle className="shrink-0" />
                <AlertDescription>
                  Alterações avançadas podem afetar relatórios históricos, compensação de prejuízo, cálculo mensal de imposto e sugestão de DARF.
                </AlertDescription>
              </Alert>

              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Registros fiscais reais</CardTitle>
                  <CardDescription>Edição direta das linhas persistidas em parâmetros fiscais.</CardDescription>
                  <CardAction className="col-span-full row-start-auto justify-self-start sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:justify-self-end">
                    <Button onClick={openCreateParameter}>
                      <Plus data-icon="inline-start" />
                      Novo registro avançado
                    </Button>
                  </CardAction>
                </CardHeader>
                <div className="overflow-x-auto">
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-44">Regime</TableHead>
                        <TableHead className="w-28">Início</TableHead>
                        <TableHead className="w-28">Fim</TableHead>
                        <TableHead className="w-24 text-right">Alíquota</TableHead>
                        <TableHead className="w-24 text-right">IRRF</TableHead>
                        <TableHead className="w-32 text-right">Isenção</TableHead>
                        <TableHead className="w-20">DARF</TableHead>
                        <TableHead className="w-28 text-right">Mínima</TableHead>
                        <TableHead className="w-24">Mensal</TableHead>
                        <TableHead className="w-40">Compensação</TableHead>
                        <TableHead className="w-24">Status</TableHead>
                        <TableHead className="w-16 text-right">Ações</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {loadingParameters ? (
                        Array.from({ length: 4 }).map((_, index) => (
                          <TableRow key={index}>
                            <TableCell colSpan={12}><Skeleton className="h-9" /></TableCell>
                          </TableRow>
                        ))
                      ) : parameterLoadError ? (
                        <TableRow>
                          <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                            Parâmetros fiscais indisponíveis.
                          </TableCell>
                        </TableRow>
                      ) : parameters.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                            Nenhum parâmetro fiscal cadastrado.
                          </TableCell>
                        </TableRow>
                      ) : (
                        parameters.map((parameter) => {
                          const status = parameterStatus(parameter, currentDate);
                          return (
                            <TableRow key={parameter.id}>
                              <TableCell className="truncate font-medium" title={parameter.regime}>{parameter.regime}</TableCell>
                              <TableCell className="font-mono text-xs">{formatDate(parameter.valid_from)}</TableCell>
                              <TableCell className="font-mono text-xs">{formatDate(parameter.valid_until)}</TableCell>
                              <TableCell className="text-right font-mono">{formatPercent(parameter.tax_rate)}</TableCell>
                              <TableCell className="text-right font-mono">{formatPercent(parameter.withholding_rate)}</TableCell>
                              <TableCell className="text-right font-mono">{formatCurrencyValue(parameter.exemption_limit)}</TableCell>
                              <TableCell className="font-mono">{parameter.darf_code || '-'}</TableCell>
                              <TableCell className="text-right font-mono">{formatCurrencyValue(parameter.minimum_darf_amount)}</TableCell>
                              <TableCell>{formatBoolean(parameter.monthly_darf_enabled)}</TableCell>
                              <TableCell className="truncate" title={parameter.loss_bucket || '-'}>{parameter.loss_bucket || '-'}</TableCell>
                              <TableCell>
                                <Badge variant={status.variant}>{status.label}</Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                <Button size="icon-sm" variant="ghost" onClick={() => openEditParameter(parameter)} aria-label="Editar registro fiscal">
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
        </TabsContent>
      </Tabs>

      <Dialog
        open={successorDialogOpen}
        onOpenChange={(open) => {
          setSuccessorDialogOpen(open);
          if (!open) {
            setSuccessorBaseParameter(null);
            setSuccessorForm(EMPTY_SUCCESSOR_FORM);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Alterar regra a partir de uma data</DialogTitle>
            <DialogDescription>
              A nova vigência será criada a partir da configuração vigente e a regra anterior será encerrada automaticamente.
            </DialogDescription>
          </DialogHeader>

          {successorBaseParameter && (
            <form onSubmit={saveSuccessor} className="flex flex-col gap-5">
              <div className="rounded-md border p-3">
                <p className="text-sm font-medium">
                  {SUPPORTED_TAX_REGIMES.find((regime) => regime.code === successorBaseParameter.regime)?.label || successorBaseParameter.regime}
                </p>
                <p className="font-mono text-xs text-muted-foreground">Código técnico: {successorBaseParameter.regime}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Vigência atual: {formatDate(successorBaseParameter.valid_from)}
                  {successorBaseParameter.valid_until ? ` até ${formatDate(successorBaseParameter.valid_until)}` : ' em diante'}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Data inicial da nova regra
                  <Input
                    type="date"
                    value={successorForm.valid_from}
                    onChange={(e) => updateSuccessorForm('valid_from', e.target.value)}
                    required
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Alíquota (%)
                  <Input
                    value={successorForm.tax_rate_percent}
                    onChange={(e) => updateSuccessorForm('tax_rate_percent', e.target.value)}
                    placeholder="15"
                    inputMode="decimal"
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  IRRF (%)
                  <Input
                    value={successorForm.withholding_rate_percent}
                    onChange={(e) => updateSuccessorForm('withholding_rate_percent', e.target.value)}
                    placeholder="0,005"
                    inputMode="decimal"
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Limite isenção
                  <Input
                    value={successorForm.exemption_limit}
                    onChange={(e) => updateSuccessorForm('exemption_limit', e.target.value)}
                    placeholder="20000"
                    inputMode="decimal"
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Código DARF
                  <Input
                    value={successorForm.darf_code}
                    onChange={(e) => updateSuccessorForm('darf_code', e.target.value)}
                    placeholder="6015"
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  DARF mínima
                  <Input
                    value={successorForm.minimum_darf_amount}
                    onChange={(e) => updateSuccessorForm('minimum_darf_amount', e.target.value)}
                    placeholder="10,00"
                    inputMode="decimal"
                  />
                </label>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">DARF mensal</p>
                  <p className="text-xs text-muted-foreground">Habilita cálculo mensal quando aplicável.</p>
                </div>
                <Switch
                  checked={successorForm.monthly_darf_enabled}
                  onCheckedChange={(value) => updateSuccessorForm('monthly_darf_enabled', value)}
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setSuccessorDialogOpen(false)} disabled={savingSuccessor}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={savingSuccessor}>
                  {savingSuccessor ? (
                    <><Loader2 data-icon="inline-start" className="animate-spin" /> Salvando...</>
                  ) : (
                    <><Check data-icon="inline-start" /> Criar nova vigência</>
                  )}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={parameterDialogOpen} onOpenChange={setParameterDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editingParameter ? 'Editar registro fiscal avançado' : 'Novo registro fiscal avançado'}</DialogTitle>
            <DialogDescription>
              Edição direta da tabela fiscal. A vigência ativa não pode sobrepor outro registro ativo do mesmo regime.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={saveParameter} className="flex flex-col gap-5">
            <div className="flex flex-col gap-3">
              <div>
                <h4 className="text-sm font-medium">Identificação</h4>
                <p className="text-xs text-muted-foreground">Regime fiscal e bucket usado para compensação de prejuízos.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Regime
                  <Select value={parameterForm.regime} onValueChange={(value) => updateParameterForm('regime', value)}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Selecione o regime" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {SUPPORTED_TAX_REGIMES.map((regime) => (
                          <SelectItem key={regime.code} value={regime.code}>
                            {regime.label} · {regime.code}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Regra de compensação
                  <Input
                    value={parameterForm.loss_bucket}
                    onChange={(e) => updateParameterForm('loss_bucket', e.target.value)}
                    placeholder="B3_COMMON"
                  />
                </label>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <h4 className="text-sm font-medium">Vigência</h4>
                <p className="text-xs text-muted-foreground">Período em que o parâmetro pode ser escolhido pelo backend.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
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
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <h4 className="text-sm font-medium">Cálculo e DARF</h4>
                <p className="text-xs text-muted-foreground">Valores percentuais são convertidos para decimal antes de enviar à API.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
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
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  DARF mínima
                  <Input
                    value={parameterForm.minimum_darf_amount}
                    onChange={(e) => updateParameterForm('minimum_darf_amount', e.target.value)}
                    placeholder="10,00"
                    inputMode="decimal"
                  />
                </label>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">Ativo</p>
                  <p className="text-xs text-muted-foreground">Registros inativos não entram na escolha temporal.</p>
                </div>
                <Switch
                  checked={parameterForm.active}
                  onCheckedChange={(value) => updateParameterForm('active', value)}
                />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">DARF mensal</p>
                  <p className="text-xs text-muted-foreground">Habilita emissão mensal quando aplicável.</p>
                </div>
                <Switch
                  checked={parameterForm.monthly_darf_enabled}
                  onCheckedChange={(value) => updateParameterForm('monthly_darf_enabled', value)}
                />
              </div>
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

      <AlertDialog open={!!portfolioToDelete} onOpenChange={(open) => { if (!open) { setPortfolioToDelete(null); setDeleteConfirmText(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <AlertTriangle />
            </AlertDialogMedia>
            <AlertDialogTitle>Excluir carteira</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação excluirá a carteira <strong>{portfolioToDelete?.name}</strong> e <strong>todos os seus eventos</strong> definitivamente. Não há como reverter.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Para confirmar, digite o nome da carteira (<strong>{portfolioToDelete?.name}</strong>):
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={portfolioToDelete?.name}
              disabled={deleting}
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting} onClick={() => setDeleteConfirmText('')}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteConfirmText !== portfolioToDelete?.name || deleting}
            >
              {deleting ? (
                <><Loader2 data-icon="inline-start" className="animate-spin" /> Excluindo...</>
              ) : (
                <><Trash2 data-icon="inline-start" /> Excluir</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
