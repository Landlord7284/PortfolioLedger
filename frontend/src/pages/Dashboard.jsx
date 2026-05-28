import { useState, useEffect, useContext, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AppContext } from '../App';
import { positions as posApi } from '../api/client';
import EventForm from '../components/EventForm';
import B3MonthlyImportModal from '../components/B3MonthlyImportModal';
import ImportModal from '../components/ImportModal';
import { Search, Plus, Download, FolderOpen, Inbox, AlertCircle, Loader2, ArrowDown, ArrowUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from 'sonner';
import { formatMoney, formatQuantity } from '@/lib/formatters';

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

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'pt-BR', {
    numeric: true,
    sensitivity: 'base',
  });
}

function comparePositions(a, b, key) {
  if (key === 'ticker') return compareText(getAssetLabel(a), getAssetLabel(b));
  if (key === 'total_cost') return toNumber(a.total_cost) - toNumber(b.total_cost);
  if (key === 'realized_result') return toNumber(a.realized_result) - toNumber(b.realized_result);
  if (key === 'category_share') return a.category_share - b.category_share;
  if (key === 'portfolio_share') return a.portfolio_share - b.portfolio_share;
  return 0;
}

function SortableHead({ sortKey, sort, onSort, children, align = 'left' }) {
  const active = sort.key === sortKey;
  const Icon = sort.direction === 'asc' ? ArrowUp : ArrowDown;
  const alignmentClass = align === 'right' ? 'ml-auto -mr-2' : '-ml-3';

  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <Button
        variant="ghost"
        size="sm"
        className={`${alignmentClass} h-8 px-2 text-xs font-medium text-muted-foreground hover:text-foreground`}
        onClick={() => onSort(sortKey)}
      >
        {children}
        {active && <Icon className="ml-1 h-3.5 w-3.5" />}
      </Button>
    </TableHead>
  );
}

export default function Dashboard() {
  const { activePortfolioId, portfolioList, hideValues } = useContext(AppContext);
  const [positionList, setPositionList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showEventForm, setShowEventForm] = useState(false);
  const [showB3Import, setShowB3Import] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [filterClass, setFilterClass] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useState({ key: 'ticker', direction: 'asc' });
  const [isLargeModal, setIsLargeModal] = useState(false);
  const [showRedeemed, setShowRedeemed] = useState(() => {
    return localStorage.getItem('showRedeemed') === 'true';
  });
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') === 'assets' ? 'assets' : 'dashboard';

  const handleTabChange = (value) => {
    setSearchParams(value === 'assets' ? { tab: 'assets' } : {}, { replace: true });
  };

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

  const handleSort = (key) => {
    setSort((current) => (
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    ));
  };

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

    return [...visible].sort((a, b) => {
      const direction = sort.direction === 'asc' ? 1 : -1;
      const result = comparePositions(a, b, sort.key);
      return result === 0 ? compareText(getAssetLabel(a), getAssetLabel(b)) : result * direction;
    });
  }, [positionsWithShare, showRedeemed, filterClass, searchQuery, sort]);

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
    <div className="-mt-3 space-y-6">
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col gap-5">
        {/* Action bar */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="overflow-x-auto pb-1">
            <TabsList className="min-w-max justify-start">
              <TabsTrigger value="dashboard" className="h-9 flex-none px-3">
                Dashboard
              </TabsTrigger>
              <TabsTrigger value="assets" className="h-9 flex-none px-3">
                Ativos
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-8 w-[240px]"
                placeholder="Buscar ticker ou nome..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Button variant="outline" onClick={() => setShowB3Import(true)}>
              <Download className="w-4 h-4" />
              Importar da B3
            </Button>
            <Button variant="outline" onClick={() => setShowImport(true)}>
              <Download className="w-4 h-4" />
              Importar Posições
            </Button>
            <Button onClick={() => setShowEventForm(true)}>
              <Plus className="w-4 h-4" />
              Novo Evento
            </Button>
          </div>
        </div>

        <TabsContent value="dashboard" className="flex flex-col gap-4">
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
        </TabsContent>

        <TabsContent value="assets" className="flex flex-col gap-5">
          {/* Filter & Toggles */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {classes.length > 1 && (
                <>
                  <Button
                    variant={!filterClass ? "default" : "outline"}
                    size="sm"
                    className="text-sm"
                    onClick={() => setFilterClass('')}
                  >
                    Todos
                  </Button>
                  {classes.map((c) => (
                    <Button
                    key={c}
                    variant={filterClass === c ? "default" : "outline"}
                    size="sm"
                    className="text-sm"
                    onClick={() => setFilterClass(c)}
                  >
                    {c}
                    </Button>
                  ))}
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
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
              <div className="max-h-[calc(100vh-18rem)] overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow>
                      <SortableHead sortKey="ticker" sort={sort} onSort={handleSort}>Ticker</SortableHead>
                      <TableHead>Classe</TableHead>
                      <TableHead className="text-right">Quantidade</TableHead>
                      <SortableHead sortKey="total_cost" sort={sort} onSort={handleSort} align="right">Custo Total</SortableHead>
                      <TableHead className="text-right">Preço Médio</TableHead>
                      <SortableHead sortKey="realized_result" sort={sort} onSort={handleSort} align="right">Resultado</SortableHead>
                      <SortableHead sortKey="category_share" sort={sort} onSort={handleSort} align="right">% Categoria</SortableHead>
                      <SortableHead sortKey="portfolio_share" sort={sort} onSort={handleSort} align="right">% Carteira</SortableHead>
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
                          <TableCell className="text-right font-mono text-sm">{displayMoney(pos.total_cost)}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{displayMoney(pos.average_price)}</TableCell>
                          <TableCell className={`text-right font-mono text-sm ${!hideValues && realized > 0 ? 'text-emerald-500' : !hideValues && realized < 0 ? 'text-red-500' : ''}`}>
                            {displayMoney(pos.realized_result)}
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
        </TabsContent>
      </Tabs>

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

      {/* B3 import modal */}
      {showB3Import && (
        <B3MonthlyImportModal
          portfolioId={activePortfolioId}
          onClose={() => setShowB3Import(false)}
          onSuccess={loadPositions}
        />
      )}

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
