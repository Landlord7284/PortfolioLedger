import { NavLink, useLocation } from 'react-router-dom';
import { useContext } from 'react';
import { AppContext } from '../App';
import { Check, ChevronsUpDown, LayoutDashboard, Settings as SettingsIcon, Eye, EyeOff, Wallet, Layers3, ReceiptText, Moon, Sun, FileText, HandCoins } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export default function Layout({ children }) {
  const { portfolioList, activePortfolioId, setActivePortfolioId, hideValues, setHideValues, theme, setTheme } = useContext(AppContext);
  const location = useLocation();
  const isDashboard = location.pathname === '/';
  const isProventos = location.pathname === '/proventos';
  const isSettings = location.pathname === '/settings';
  const isAssetManagement = location.pathname === '/asset-management';
  const isBrokerageNote = location.pathname === '/brokerage-note';
  const isReports = location.pathname.startsWith('/reports/');
  const activePortfolio = portfolioList.find((portfolio) => portfolio.id === activePortfolioId);

  const pageTitle = () => {
    if (location.pathname === '/settings') return 'Configurações';
    if (location.pathname === '/asset-management') return 'Gestão de Ativos';
    if (location.pathname === '/proventos') return 'Proventos';
    if (location.pathname === '/brokerage-note') return 'Rateio de Nota';
    if (location.pathname === '/reports/assets-and-rights') return 'Bens e Direitos';
    if (location.pathname === '/reports/income') return 'Rendimentos';
    if (location.pathname === '/reports/capital-gains') return 'Ganho de Capital';
    if (location.pathname.startsWith('/assets/')) return 'Detalhe do Ativo';
    return 'Dashboard';
  };

  return (
    <SidebarProvider>
      <Sidebar className="border-r border-sidebar-border">
        <SidebarHeader className="px-3 py-3">
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild disabled={portfolioList.length === 0}>
                  <SidebarMenuButton
                    size="lg"
                    className="h-14 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                      <Wallet className="size-4" />
                    </div>
                    <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-semibold">
                        {activePortfolio?.name || 'Nenhuma carteira'}
                      </span>
                      <span className="truncate text-xs text-sidebar-foreground/60">
                        Carteira ativa
                      </span>
                    </div>
                    <ChevronsUpDown className="ml-auto size-4 text-sidebar-foreground/60" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="right"
                  align="start"
                  className="min-w-56"
                >
                  {portfolioList.map((portfolio) => (
                    <DropdownMenuItem
                      key={portfolio.id}
                      onSelect={() => setActivePortfolioId(Number(portfolio.id))}
                      className="gap-2"
                    >
                      <Wallet className="size-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{portfolio.name}</span>
                      {portfolio.id === activePortfolioId && <Check className="size-4" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
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
              <SidebarMenuButton asChild isActive={isProventos}>
                <NavLink to="/proventos">
                  <HandCoins className="w-4 h-4" />
                  <span>Proventos</span>
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
              <SidebarMenuButton isActive={isReports}>
                <FileText className="w-4 h-4" />
                <span>Relatórios</span>
              </SidebarMenuButton>
              <SidebarMenuSub>
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton asChild isActive={location.pathname === '/reports/assets-and-rights'}>
                    <NavLink to="/reports/assets-and-rights">
                      <span>Bens e Direitos</span>
                    </NavLink>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton asChild isActive={location.pathname === '/reports/income'}>
                    <NavLink to="/reports/income">
                      <span>Rendimentos</span>
                    </NavLink>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton asChild isActive={location.pathname === '/reports/capital-gains'}>
                    <NavLink to="/reports/capital-gains">
                      <span>Ganho de Capital</span>
                    </NavLink>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              </SidebarMenuSub>
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

        <SidebarFooter className="border-t border-sidebar-border p-3">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                tooltip={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
              >
                {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
                <span>{theme === 'dark' ? 'Tema claro' : 'Tema escuro'}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => setHideValues(!hideValues)}
                tooltip={hideValues ? 'Mostrar valores' : 'Ocultar valores'}
              >
                {hideValues ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                <span>{hideValues ? 'Mostrar valores' : 'Ocultar valores'}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>

          <p className="text-[10px] text-sidebar-foreground/40 uppercase tracking-wider font-medium">
            Versão 1.1.4
          </p>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-30 flex h-14 items-center gap-4 px-4 sm:px-6 bg-background/95 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <h2 className="text-sm font-semibold">{pageTitle()}</h2>
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
