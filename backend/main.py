"""
Portfolio Ledger — FastAPI application entry point.

Initialises the database on startup and mounts all API routers.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.database import init_db
from backend.routers import portfolios, assets, events, brokerage_notes, reports, tax, b3_imports
from backend.database import get_db
from backend.services.event_service import backfill_event_brl_conversions


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run database initialisation on startup."""
    init_db()
    with get_db() as conn:
        backfill_event_brl_conversions(conn)
    yield


app = FastAPI(
    title="Portfolio Ledger",
    description="Sistema local de controle patrimonial de carteira de investimentos",
    version="1.1.4",
    lifespan=lifespan,
)

# CORS — allow frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers
app.include_router(portfolios.router)
app.include_router(assets.router)
app.include_router(events.router)
app.include_router(brokerage_notes.router)
app.include_router(reports.router)
app.include_router(tax.router)
app.include_router(b3_imports.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
