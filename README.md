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

## Estrutura

- `backend/`: API, servicos, dominio, persistencia e testes.
- `frontend/`: aplicacao React/Vite.
- `backend/ledger.db`: banco SQLite local.
