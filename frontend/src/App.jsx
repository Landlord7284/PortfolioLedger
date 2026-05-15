import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect, createContext, Suspense, lazy } from 'react';
import Layout from './components/Layout';
import { portfolios as portfolioApi } from './api/client';
import { Loader2 } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toast } from 'sonner';

export const AppContext = createContext(null);

const Dashboard = lazy(() => import('./pages/Dashboard'));
const AssetDetail = lazy(() => import('./pages/AssetDetail'));
const AssetManagement = lazy(() => import('./pages/AssetManagement'));
const BrokerageNote = lazy(() => import('./pages/BrokerageNote'));
const AssetsAndRightsReport = lazy(() => import('./pages/AssetsAndRightsReport'));
const ReportPlaceholder = lazy(() => import('./pages/ReportPlaceholder'));
const Settings = lazy(() => import('./pages/Settings'));

const getStoredActivePortfolioId = () => {
  const storedId = Number(localStorage.getItem('activePortfolioId'));
  return Number.isInteger(storedId) && storedId > 0 ? storedId : null;
};

function RouteLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center gap-2 text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-sm">Carregando página...</span>
    </div>
  );
}

function App() {
  const [portfolioList, setPortfolioList] = useState([]);
  const [activePortfolioId, setActivePortfolioId] = useState(getStoredActivePortfolioId);
  const [loading, setLoading] = useState(true);
  const [hideValues, setHideValues] = useState(() => {
    return localStorage.getItem('hideValues') === 'true';
  });
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('theme') || 'dark';
  });

  useEffect(() => {
    localStorage.setItem('hideValues', hideValues);
  }, [hideValues]);

  useEffect(() => {
    const isDark = theme === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    if (activePortfolioId) {
      localStorage.setItem('activePortfolioId', activePortfolioId.toString());
    } else {
      localStorage.removeItem('activePortfolioId');
    }
  }, [activePortfolioId]);

  const refreshPortfolios = async () => {
    try {
      const list = await portfolioApi.list();
      setPortfolioList(list);
      setActivePortfolioId((currentActiveId) => {
        const candidateId = currentActiveId || getStoredActivePortfolioId();
        if (candidateId && list.some((portfolio) => portfolio.id === candidateId)) {
          return candidateId;
        }
        return list[0]?.id || null;
      });
    } catch (err) {
      console.error('Failed to load portfolios:', err);
      toast.error(err.message || 'Falha ao carregar carteiras.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshPortfolios();
  }, []);

  if (loading) {
    return (
      <>
        <div className="flex h-screen items-center justify-center gap-3 text-muted-foreground bg-background">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Carregando...</span>
        </div>
        <Toaster position="top-right" closeButton richColors />
      </>
    );
  }

  return (
    <AppContext.Provider value={{
      portfolioList,
      activePortfolioId,
      setActivePortfolioId,
      refreshPortfolios,
      hideValues,
      setHideValues,
      theme,
      setTheme,
    }}>
      <BrowserRouter>
        <TooltipProvider>
          <Layout>
            <Suspense fallback={<RouteLoading />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/asset-management" element={<AssetManagement />} />
                <Route path="/brokerage-note" element={<BrokerageNote />} />
                <Route path="/reports/assets-and-rights" element={<AssetsAndRightsReport />} />
                <Route path="/reports/income" element={<ReportPlaceholder title="Rendimentos" />} />
                <Route path="/reports/capital-gains" element={<ReportPlaceholder title="Ganho de Capital" />} />
                <Route path="/assets/:assetId" element={<AssetDetail />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </Layout>
        </TooltipProvider>
        <Toaster position="top-right" closeButton richColors />
      </BrowserRouter>
    </AppContext.Provider>
  );
}

export default App;
