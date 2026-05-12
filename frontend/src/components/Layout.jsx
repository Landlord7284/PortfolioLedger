import { NavLink, useLocation } from 'react-router-dom';
import { useContext } from 'react';
import { AppContext } from '../App';
import { LayoutDashboard, Settings as SettingsIcon, Eye, EyeOff, Briefcase, Wallet, Layers3, ReceiptText } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export default function Layout({ children }) {
  const { portfolioList, activePortfolioId, setActivePortfolioId, hideValues, setHideValues } = useContext(AppContext);
  const location = useLocation();
  const isDashboard = location.pathname === '/';
  const isSettings = location.pathname === '/settings';
  const isAssetManagement = location.pathname === '/asset-management';
  const isBrokerageNote = location.pathname === '/brokerage-note';

  const pageTitle = () => {
    if (location.pathname === '/settings') return 'Configurações';
    if (location.pathname === '/asset-management') return 'Gestão de Ativos';
    if (location.pathname === '/brokerage-note') return 'Rateio de Nota';
    if (location.pathname.startsWith('/assets/')) return 'Detalhe do Ativo';
    return 'Dashboard';
  };

  return (
    <SidebarProvider>
      <Sidebar className="border-r border-sidebar-border">
        <SidebarHeader className="border-b border-sidebar-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Briefcase className="w-5 h-5 text-sidebar-primary" />
            <div>
              <h1 className="text-sm font-semibold leading-none">Portfolio Ledger</h1>
              <p className="text-[11px] text-sidebar-foreground/50 mt-0.5">Controle Patrimonial</p>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent className="px-3 py-3">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={isDashboard}>
                <NavLink to="/">
                  <LayoutDashboard className="w-4 h-4" />
                  <span>Dashboard</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={isAssetManagement}>
                <NavLink to="/asset-management">
                  <Layers3 className="w-4 h-4" />
                  <span>Gestão de Ativos</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={isBrokerageNote}>
                <NavLink to="/brokerage-note">
                  <ReceiptText className="w-4 h-4" />
                  <span>Rateio de Nota</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={isSettings}>
                <NavLink to="/settings">
                  <SettingsIcon className="w-4 h-4" />
                  <span>Carteiras</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border p-4">
          <p className="text-[10px] text-sidebar-foreground/40 uppercase tracking-wider font-medium">
            Versão 1.1.4
          </p>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 px-4 sm:px-6 border-b border-border bg-background/95 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <h2 className="text-sm font-semibold">{pageTitle()}</h2>
          </div>

          <div className="flex items-center gap-3">
            {portfolioList.length > 0 && (
              <>
                <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
                  <Wallet className="w-3.5 h-3.5" />
                  <span>Carteira</span>
                </div>
                <Select
                  value={activePortfolioId?.toString() || ''}
                  onValueChange={(val) => setActivePortfolioId(Number(val))}
                >
                  <SelectTrigger className="w-[150px] sm:w-[180px]">
                    <SelectValue placeholder="Selecione..." />
                  </SelectTrigger>
                  <SelectContent>
                    {portfolioList.map((p) => (
                      <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Separator orientation="vertical" className="h-6 hidden sm:block" />

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
      </SidebarInset>
    </SidebarProvider>
  );
}
