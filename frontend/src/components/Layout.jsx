import { NavLink, useLocation } from 'react-router-dom';
import { useContext } from 'react';
import { AppContext } from '../App';
import { LayoutDashboard, Settings as SettingsIcon, Eye, EyeOff, Briefcase, Wallet } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export default function Layout({ children }) {
  const { portfolioList, activePortfolioId, setActivePortfolioId, hideValues, setHideValues } = useContext(AppContext);
  const location = useLocation();

  const pageTitle = () => {
    if (location.pathname === '/settings') return 'Configurações';
    if (location.pathname.startsWith('/assets/')) return 'Detalhe do Ativo';
    return 'Dashboard';
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="fixed top-0 left-0 z-40 w-64 h-screen border-r border-sidebar-border bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="flex h-14 items-center gap-2 px-5 border-b border-sidebar-border">
          <Briefcase className="w-5 h-5 text-sidebar-primary" />
          <div>
            <h1 className="text-sm font-semibold leading-none">Portfolio Ledger</h1>
            <p className="text-[11px] text-sidebar-foreground/50 mt-0.5">Controle Patrimonial</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-1">
          <NavLink
            to="/"
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive && location.pathname === '/'
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              }`
            }
          >
            <LayoutDashboard className="w-4 h-4" />
            Dashboard
          </NavLink>

          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              }`
            }
          >
            <SettingsIcon className="w-4 h-4" />
            Carteiras
          </NavLink>
        </nav>

        <div className="p-4 border-t border-sidebar-border">
          <p className="text-[10px] text-sidebar-foreground/40 uppercase tracking-wider font-medium">
            Versão 1.0.3
          </p>
        </div>
      </aside>

      {/* Main content */}
      <div className="ml-64 flex-1 flex flex-col min-h-screen">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 px-6 border-b border-border bg-background/95 backdrop-blur-sm">
          <h2 className="text-sm font-semibold">{pageTitle()}</h2>

          <div className="flex items-center gap-3">
            {portfolioList.length > 0 && (
              <>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Wallet className="w-3.5 h-3.5" />
                  <span>Carteira</span>
                </div>
                <Select
                  value={activePortfolioId?.toString() || ''}
                  onValueChange={(val) => setActivePortfolioId(Number(val))}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Selecione..." />
                  </SelectTrigger>
                  <SelectContent>
                    {portfolioList.map((p) => (
                      <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Separator orientation="vertical" className="h-6" />

                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setHideValues(!hideValues)}
                  title={hideValues ? "Mostrar valores" : "Ocultar valores"}
                >
                  {hideValues ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </>
            )}
          </div>
        </header>

        <main className="flex-1 p-6">
          <div className="mx-auto max-w-6xl">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
