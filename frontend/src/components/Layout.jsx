import { NavLink, useLocation } from 'react-router-dom';
import { useContext } from 'react';
import { AppContext } from '../App';

export default function Layout({ children }) {
  const { portfolioList, activePortfolioId, setActivePortfolioId } = useContext(AppContext);
  const location = useLocation();

  const pageTitle = () => {
    if (location.pathname === '/settings') return 'Configurações';
    if (location.pathname.startsWith('/assets/')) return 'Detalhe do Ativo';
    return 'Dashboard';
  };

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h1>Portfolio Ledger</h1>
          <p>Controle Patrimonial</p>
        </div>

        <nav className="sidebar-nav">
          <NavLink
            to="/"
            className={({ isActive }) => `nav-item ${isActive && location.pathname === '/' ? 'active' : ''}`}
          >
            <span className="nav-icon">📊</span>
            Dashboard
          </NavLink>

          <NavLink
            to="/settings"
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <span className="nav-icon">⚙️</span>
            Carteiras
          </NavLink>
        </nav>

        <div style={{ padding: '16px 12px', borderTop: '1px solid var(--border-primary)' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Versão 0.1.0 — Fase 1
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="main-area">
        <header className="topbar">
          <span className="topbar-title">{pageTitle()}</span>

          <div className="topbar-right">
            {/* Portfolio selector */}
            {portfolioList.length > 0 && (
              <div className="portfolio-selector">
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Carteira:</span>
                <select
                  value={activePortfolioId || ''}
                  onChange={(e) => setActivePortfolioId(Number(e.target.value))}
                >
                  {portfolioList.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </header>

        <main className="content">
          {children}
        </main>
      </div>
    </div>
  );
}
