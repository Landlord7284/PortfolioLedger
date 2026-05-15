# AGENTS.md

Guia para agentes Codex trabalhando neste repositorio. O objetivo principal e economizar contexto: leia isto antes de explorar o projeto inteiro.

## Projeto

Este repo e o `ledger`, uma aplicacao de portfolio financeiro com:

- Backend Python/FastAPI em `backend/`.
- Frontend Vite/React em `frontend/`.
- SQLite local em `backend/ledger.db`.
- Componentes de UI seguindo o stack existente de Shadcn/ui.

Em tarefas financeiras, trate o backend como fonte de verdade para calculos. A UI deve refletir formulas e estados derivados do backend, nao reinventar regra de negocio.

## Fluxo eficiente para novas tarefas

1. Comece pela pergunta concreta do usuario, nao por uma varredura ampla.
2. Antes de editar, trace o caminho real: componente frontend -> API client/rota -> router backend -> service -> persistencia ou replay.
3. Use buscas direcionadas com `rg` e leituras pequenas. Broad scans podem falhar neste ambiente Windows.
4. Preserve padroes existentes. Nao introduza nova arquitetura se houver service/router/componente reaproveitavel.
5. Se a tarefa parece ja ter sido discutida em sessoes anteriores, consulte memoria primeiro e depois verifique apenas o que pode ter mudado.
6. Antes de afirmar que algo e "baseline" ou "pre-existente", confirme com `git status --short`, diff atual e, quando aplicavel, comando de validacao.

## Comandos conhecidos

Backend:

```powershell
D:\codex\ledger\.venv\Scripts\python.exe -m pytest backend\tests
```

Frontend:

```powershell
cd frontend
npm.cmd run build
npm.cmd run lint
```

Use `npm.cmd`, nao `npm`, porque o PowerShell pode bloquear `npm.ps1` por politica de execucao.

Servidor frontend, quando precisar validar manualmente:

```powershell
cd frontend
npm.cmd run dev -- --host 127.0.0.1
```

## Validacao

- Para mudancas backend ou de calculo financeiro, rode os testes Python quando viavel.
- Para mudancas frontend, rode `npm.cmd run build`.
- O lint do frontend pode nao estar limpo globalmente. Se lint for relevante, separe regressao atual de ruido pre-existente.
- Se validacao visual local falhar por bloqueio do navegador, use build/test/API checks e reporte o bloqueio claramente.

## Regras de dominio importantes

- Valores financeiros sao persistidos no SQLite como strings decimais canonicas em campos `TEXT`; alguns fluxos arredondam dinheiro para centavos antes de persistir quando a regra do fluxo exige.
- Evite recriar banco ou alterar schema se o dado pode ser derivado por replay do ledger ou por campos ja expostos pela API.
- Para `Rateio de Nota`, use exatamente essa terminologia na UI e nas explicacoes. As regras devem seguir a semantica de planilha informada pelo usuario, como `D/C`, valor bruto e reconciliacao.
- Para respostas sobre telas financeiras, explique a formula/caminho real em vez de descrever apenas o que aparece visualmente.

## Pontos de codigo recorrentes

- Dashboard principal: `frontend/src/pages/Dashboard.jsx`.
- Formulario de eventos: `frontend/src/components/EventForm.jsx`.
- Detalhe de ativo: `frontend/src/pages/AssetDetail.jsx`.
- Date picker compartilhado: `frontend/src/components/ui/date-picker.jsx`.
- Fluxo de Rateio de Nota: `frontend/src/pages/BrokerageNote.jsx`, `backend/services/brokerage_note_service.py`, `backend/routers/brokerage_notes.py`.
- Importacao/reuso de pipeline: `backend/services/import_service.py`.
- Eventos, posicoes e replay: procure em `backend/services/event_service.py` e `backend/domain/`.
- Ativos e matching/review: `backend/services/asset_service.py`.

## Padroes frontend

- Preserve Shadcn/ui e componentes existentes.
- Nao troque Select/Switch/DatePicker por outro stack sem necessidade.
- O DatePicker compartilhado aceita digitacao `DD/MM/YYYY`, emite `yyyy-MM-dd` e deve preservar `onChange("")` quando limpo.
- Evite espelhar props em state por `useEffect` quando o valor pode ser derivado diretamente, especialmente em componentes compartilhados.

## Padroes backend

- Prefira enriquecer respostas existentes ou reutilizar services antes de criar rotas paralelas.
- Novos fluxos de importacao devem tentar reaproveitar `import_events_to_ledger(...)` para manter matching, duplicidade, review queue, criacao de eventos e recalculo de posicoes consistentes.
- Em testes backend, prefira bancos temporarios com `tmp_path`, `init_db(...)` e `get_db(...)` quando o teste tocar persistencia.

## Git e seguranca

- Nao reverta alteracoes que ja estavam no worktree.
- Antes de editar arquivos ja modificados, leia o diff e preserve trabalho do usuario.
- Mantenha patches pequenos e focados. Em arquivos grandes ou com encoding sensivel, prefira alteracoes localizadas.
- Nao use comandos destrutivos como `git reset --hard` ou remocao recursiva sem pedido explicito.

## Como responder ao usuario

- Seja direto e cite arquivos/linhas quando explicar comportamento.
- Quando houver incerteza, separe fato verificado de inferencia.
- Em tarefas grandes, implemente ate o fim quando o pedido ja for executivo; nao pare em plano sem necessidade.
- Se algo nao foi validado, diga qual comando faltou e por que.
