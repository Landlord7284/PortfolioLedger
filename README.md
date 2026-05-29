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

## Desenvolvimento

No primeiro startup do backend, o SQLite local e criado automaticamente em `backend/ledger.db`, incluindo o schema e os parametros fiscais padrao.

Para subir backend e frontend juntos:

```bash
cd frontend
npm run dev:all
```

O script `dev:backend` escolhe o Python da `.venv` de forma cross-platform: `.venv/Scripts/python.exe` no Windows e `.venv/bin/python` em macOS/Linux. Se a `.venv` nao existir, ele tenta `PYTHON`, `python3` e `python`.

## Estrutura

- `backend/`: API, servicos, dominio, persistencia e testes.
- `frontend/`: aplicacao React/Vite.
- `backend/ledger.db`: banco SQLite local.
