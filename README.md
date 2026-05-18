# ledger

Aplicacao local de portfolio financeiro, com backend Python/FastAPI, frontend React/Vite e persistencia em SQLite.

## Funcionalidades

- Acompanhamento de posicoes e eventos do portfolio.
- Cadastro, matching e revisao de ativos.
- Importacao de eventos por XLSX e importacao mensal B3.
- Fluxo de `Rateio de Nota`.
- Relatorios fiscais, incluindo `Bens e Direitos` e proventos.

## Stack

- Backend: Python, FastAPI, SQLite, pytest e openpyxl.
- Frontend: React, Vite, Shadcn/ui, Tailwind CSS e Recharts.

## Como rodar

Backend:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload --port 8000
```

Frontend:

```powershell
cd frontend
npm.cmd run dev
```

Ou, dentro de `frontend/`, rode backend e frontend juntos:

```powershell
npm.cmd run dev:all
```

## Validacao

Backend:

```powershell
D:\codex\ledger\.venv\Scripts\python.exe -m pytest backend\tests
```

Frontend:

```powershell
cd frontend
npm.cmd run build
```

Lint opcional:

```powershell
npm.cmd run lint
```

O lint do frontend pode conter ruido preexistente; se for usado como gate, compare com o diff atual.

## Estrutura

- `backend/`: API, servicos, dominio, persistencia e testes.
- `frontend/`: aplicacao React/Vite.
- `backend/ledger.db`: banco SQLite local.
- `AGENTS.md`: guia operacional para agentes Codex neste repositorio.
