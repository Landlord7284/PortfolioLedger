import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect, createContext } from 'react';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import AssetDetail from './pages/AssetDetail';
import Settings from './pages/Settings';
import { portfolios as portfolioApi } from './api/client';
import { Loader2 } from 'lucide-react';

export const AppContext = createContext(null);

function App() {
  const [portfolioList, setPortfolioList] = useState([]);
  const [activePortfolioId, setActivePortfolioId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hideValues, setHideValues] = useState(() => {
    return localStorage.getItem('hideValues') === 'true';
  });

  useEffect(() => {
    localStorage.setItem('hideValues', hideValues);
  }, [hideValues]);

  const refreshPortfolios = async () => {
    try {
      const list = await portfolioApi.list();
      setPortfolioList(list);
      if (list.length > 0 && !activePortfolioId) {
        setActivePortfolioId(list[0].id);
      }
    } catch (err) {
      console.error('Failed to load portfolios:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshPortfolios();
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center gap-3 text-muted-foreground bg-background">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Carregando...</span>
      </div>
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
    }}>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/assets/:assetId" element={<AssetDetail />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </AppContext.Provider>
  );
}

export default App;
