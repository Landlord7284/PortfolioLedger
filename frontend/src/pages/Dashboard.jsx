import { useState, useEffect, useContext, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../App';
import { positions as posApi } from '../api/client';
import EventForm from '../components/EventForm';
import ImportModal from '../components/ImportModal';
import { Search, Plus, Download, FolderOpen, Inbox, AlertCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from 'sonner';
import { formatMoney, formatQuantity } from '@/lib/formatters';

const SORT_OPTIONS = [
  { value: 'asset-asc', label: 'Ativo A-Z' },
  { value: 'asset-desc', label: 'Ativo Z-A' },
  { value: 'balance-asc', label: 'Menor Saldo' },
  { value: 'balance-desc', label: 'Maior Saldo' },
  { value: 'share-asc', label: 'Menor Participação' },
  { value: 'share-desc', label: 'Maior Participação' },
];

function toNumber(value) {
  const parsed = parseFloat(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getAssetLabel(position) {
  return position.current_ticker || `#${position.asset_id}`;
}

function formatPercent(value, hideValues = false) {
  if (hideValues) return "•••••";
  if (!Number.isFinite(value)) return "—";
  return `${value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

export default function Dashboard() {
  const { activePortfolioId, portfolioList, hideValues } = useContext(AppContext);
  const [positionList, setPositionList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showEventForm, setShowEventForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [filterClass, setFilterClass] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('asset-asc');
  const [isLargeModal, setIsLargeModal] = useState(false);
  const [showRedeemed, setShowRedeemed] = useState(() => {
    return localStorage.getItem('showRedeemed') === 'true';
  });
  const navigate = useNavigate();

  useEffect(() => {
    localStorage.setItem('showRedeemed', showRedeemed);
  }, [showRedeemed]);

  const loadPositions = useCallback(async () => {
    if (!activePortfolioId) {
      setPositionList([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await posApi.list(activePortfolioId);
      setPositionList(data);
    } catch (err) {
      console.error('Failed to load positions:', err);
      toast.error(err.message || 'Falha ao carregar posições.');
    } finally {
      setLoading(false);
    }
  }, [activePortfolioId]);

  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  const positionsWithShare = useMemo(() => {
    const allocationBase = positionList.filter((p) => showRedeemed || toNumber(p.quantity) !== 0);
    const portfolioTotal = allocationBase.reduce((sum, p) => sum + Math.max(toNumber(p.total_cost), 0), 0);
    const classTotals = allocationBase.reduce((totals, p) => {
      const assetClass = p.asset_class || 'Sem classe';
      totals[assetClass] = (totals[assetClass] || 0) + Math.max(toNumber(p.total_cost), 0);
      return totals;
    }, {});

    return positionList.map((p) => {
      const totalCost = Math.max(toNumber(p.total_cost), 0);
      const classTotal = classTotals[p.asset_class || 'Sem classe'] || 0;

      return {
        ...p,
        category_share: classTotal > 0 ? (totalCost / classTotal) * 100 : 0,
        portfolio_share: portfolioTotal > 0 ? (totalCost / portfolioTotal) * 100 : 0,
      };
    });
  }, [positionList, showRedeemed]);

  const filtered = useMemo(() => {
    const visible = positionsWithShare.filter((p) => {
      if (!showRedeemed && toNumber(p.quantity) === 0) return false;
      if (filterClass && p.asset_class !== filterClass) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const ticker = (p.current_ticker || '').toLowerCase();
        const name = (p.name || '').toLowerCase();
        return ticker.includes(q) || name.includes(q);
      }
      return true;
    });

    const compareByAsset = (a, b) => getAssetLabel(a).localeCompare(getAssetLabel(b), 'pt-BR', {
      numeric: true,
      sensitivity: 'base',
    });

    return [...visible].sort((a, b) => {
      switch (sortBy) {
        case 'asset-desc':
          return compareByAsset(b, a);
        case 'balance-asc':
          return toNumber(a.total_cost) - toNumber(b.total_cost) || compareByAsset(a, b);
        case 'balance-desc':
          return toNumber(b.total_cost) - toNumber(a.total_cost) || compareByAsset(a, b);
        case 'share-asc':
          return a.portfolio_share - b.portfolio_share || compareByAsset(a, b);
        case 'share-desc':
          return b.portfolio_share - a.portfolio_share || compareByAsset(a, b);
        default:
          return compareByAsset(a, b);
      }
    });
  }, [positionsWithShare, showRedeemed, filterClass, searchQuery, sortBy]);

  const displayMoney = (val) => formatMoney(val, hideValues);
  const displayQuantity = (val, assetClass) => formatQuantity(val, assetClass, hideValues);

  const totalCost = positionList.reduce((s, p) => s + toNumber(p.total_cost), 0);
  const totalRealized = positionList.reduce((s, p) => s + toNumber(p.realized_result), 0);
  const activeAssets = positionList.filter((p) => toNumber(p.quantity) > 0).length;

  const classes = [...new Set(positionList.map((p) => p.asset_class))].sort();

  if (!activePortfolioId) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <FolderOpen className="w-12 h-12 text-muted-foreground/30 mb-4" />
        <h3 className="text-lg font-semibold mb-2">Nenhuma carteira selecionada</h3>
        <p className="text-sm text-muted-foreground max-w-sm">Crie uma carteira em Configurações para começar.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Action bar */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Posições Consolidadas</h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            {portfolioList.find((p) => p.id === activePortfolioId)?.name || ''}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-8 w-[240px]"
              placeholder="Buscar ticker ou nome..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Button variant="outline" onClick={() => setShowImport(true)}>
            <Download className="w-4 h-4" />
            Importar
          </Button>
          <Button onClick={() => setShowEventForm(true)}>
            <Plus className="w-4 h-4" />
            Novo Evento
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Custo Total</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {hideValues ? '•••••' : `R$ ${formatMoney(totalCost)}`}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Resultado Realizado</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold tabular-nums ${!hideValues && totalRealized >= 0 ? 'text-emerald-500' : !hideValues ? 'text-red-500' : ''}`}>
              {hideValues ? '•••••' : `R$ ${formatMoney(totalRealized)}`}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Ativos em Carteira</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeAssets}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total de Ativos</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{positionList.length}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filter & Toggles */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {classes.length > 1 && (
            <>
              <span className="text-xs font-medium text-muted-foreground mr-1">Filtrar:</span>
              <Button
                variant={!filterClass ? "default" : "outline"}
                size="xs"
                onClick={() => setFilterClass('')}
              >
                Todos
              </Button>
              {classes.map((c) => (
                <Button
                  key={c}
                  variant={filterClass === c ? "default" : "outline"}
                  size="xs"
                  onClick={() => setFilterClass(c)}
                >
                  {c}
                </Button>
              ))}
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="w-[190px]" aria-label="Ordenar posições">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label htmlFor="show-redeemed" className="text-sm text-muted-foreground cursor-pointer font-normal">
            Exibir resgatados
          </Label>
          <Switch
            id="show-redeemed"
            checked={showRedeemed}
            onCheckedChange={setShowRedeemed}
          />
        </div>
      </div>

      {/* Positions table */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mb-3" />
          <span className="text-sm">Carregando posições...</span>
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Inbox className="w-10 h-10 text-muted-foreground/40 mb-3" />
            <h3 className="text-base font-medium mb-1">Nenhuma posição encontrada</h3>
            <p className="text-muted-foreground text-sm max-w-sm">Lance um evento ou importe os dados para começar.</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ticker</TableHead>
                  <TableHead>Classe</TableHead>
                  <TableHead className="text-right">Quantidade</TableHead>
                  <TableHead className="text-right">Custo Total</TableHead>
                  <TableHead className="text-right">Preço Médio</TableHead>
                  <TableHead className="text-right">Resultado</TableHead>
                  <TableHead className="text-right">% Categoria</TableHead>
                  <TableHead className="text-right">% Carteira</TableHead>
                  <TableHead>Último Evento</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((pos) => {
                  const realized = toNumber(pos.realized_result);
                  const qty = toNumber(pos.quantity);
                  return (
                    <TableRow
                      key={`${pos.portfolio_id}-${pos.asset_id}`}
                      className="cursor-pointer"
                      onClick={() => navigate(`/assets/${pos.asset_id}`)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {pos.current_ticker || `#${pos.asset_id}`}
                          </span>
                          {pos.duplicate_flag && (
                            <AlertCircle className="w-3.5 h-3.5 text-amber-500" title="Duplicado pendente de análise" />
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{pos.asset_class}</Badge>
                      </TableCell>
                      <TableCell className={`text-right font-mono text-sm ${qty === 0 ? 'text-muted-foreground/50' : ''}`}>
                        {displayQuantity(pos.quantity, pos.asset_class)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">R$ {displayMoney(pos.total_cost)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">R$ {displayMoney(pos.average_price)}</TableCell>
                      <TableCell className={`text-right font-mono text-sm ${!hideValues && realized > 0 ? 'text-emerald-500' : !hideValues && realized < 0 ? 'text-red-500' : ''}`}>
                        R$ {displayMoney(pos.realized_result)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatPercent(pos.category_share, hideValues)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatPercent(pos.portfolio_share, hideValues)}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">{pos.last_event_date || '—'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {/* Event form dialog */}
      <Dialog open={showEventForm} onOpenChange={setShowEventForm}>
        <DialogContent className={isLargeModal ? 'sm:max-w-4xl' : 'sm:max-w-xl'}>
          <DialogHeader>
            <DialogTitle>Novo Evento</DialogTitle>
          </DialogHeader>
          <EventForm
            onSuccess={() => { setShowEventForm(false); loadPositions(); }}
            onCancel={() => setShowEventForm(false)}
            onModeChange={setIsLargeModal}
          />
        </DialogContent>
      </Dialog>

      {/* Import modal */}
      {showImport && (
        <ImportModal
          portfolioId={activePortfolioId}
          onClose={() => setShowImport(false)}
          onSuccess={loadPositions}
        />
      )}
    </div>
  );
}
