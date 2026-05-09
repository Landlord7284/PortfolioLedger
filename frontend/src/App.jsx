import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect, createContext } from 'react';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import AssetDetail from './pages/AssetDetail';
import Settings from './pages/Settings';
import { portfolios as portfolioApi } from './api/client';

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
      <div className="loading-container" style={{ height: '100vh' }}>
        <div className="spinner" />
        <span>Carregando...</span>
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
