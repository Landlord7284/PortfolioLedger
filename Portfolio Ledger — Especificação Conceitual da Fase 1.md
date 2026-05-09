# Portfolio Ledger

## Objetivo do projeto
Construir um sistema local de controle patrimonial de carteira de investimentos, baseado em ledger de eventos, capaz de registrar movimentações por ativo, recalcular posições históricas e atuais, apurar custo total, quantidade, preço médio e resultado realizado, servindo inicialmente como substituto estruturado da planilha de controle e como base para módulos futuros de mercado, proventos, rentabilidade, relatórios e dashboards.
## Stack
React, FastAPI, SQLite. App com módulos.
### Persistência numérica
- O SQLite não deve armazenar valores financeiros, quantidades, preços médios, custo total, resultado realizado ou taxas de câmbio como REAL/FLOAT.
- Valores decimais devem ser persistidos em formato textual canônico, usando ponto como separador decimal, e convertidos para Decimal na camada de domínio do backend.
- A interface pode aceitar e exibir valores conforme a localidade brasileira, com vírgula decimal e ponto de milhar, mas a persistência interna deve ser independente de localidade.
- O backend deve ser responsável por normalizar os valores antes de salvar e por formatá-los corretamente ao exibir ao usuário.
### Dados.xlsx
Na aba `Registro`, o cabeçalho da tabela é composto por: Classe (A1) `[Ação, BDR, Criptomoeda, Debênture, CRI, CRA, ETF, FII, FI-INFRA, Tesouro Direto, Stock, REIT]`, Ativo (B1), Evento (C1) atualmente com: `[Compra, Venda, Desdobramento, Grupamento, Amortização, Bonificação, Cisão, Resgate Antecipado, Resgate Vencimento]`, Data (D1), Quantidade (E1), Valor Evento (F1). 
Essa é a fonte de alimentação atual de uma planilha de controle de ativos em Excel, e aqui está sendo usada como exemplo para alimentar os cálculos iniciais do app. 
## Fase 1
Todas as marcações `TODO` serão implementadas em etapas futuras, portanto ignore-as agora. 
- Backend com motor de cálculo patrimonial.  
- Frontend simples apenas para cadastro/importação manual e validação dos cálculos.
- Gestão de carteiras. Possibilidade de múltiplas carteiras. Cada uma com toggle no menu de Perfil permitindo vincular à visão consolidada ou não. 
- Lançamento de eventos no sistema de forma manual tanto via cadastro de novo ativo como a possibilidade de lançar um evento a ativos existentes via GUI, por navegação em um "gerenciador de ativos" ou barra de busca. #TODO Permitir cadastro manual de proventos.
	-  #TODO Cadastro via importação de arquivo seguindo um modelo específico a definir. Preferencialmente aos moldes de dados.xlsx, procurando facilitar a migração e permitindo correções pontuais para cada ativo via GUI.
- Distinção de ativos nacionais e internacionais e suas respectivas moedas. 
	- Nacionais: BRL.
	- Internacionais: USD. O valor original da operação deve ser preservado na moeda do ativo. #TODO Implementar conversão para BRL por taxa de câmbio de fechamento, via importação de arquivo ou integração automática com fonte externa.
- Identificador único para cada ativo permitindo cadastro de troca de ticker em determinada data sem comprometer o histórico. Cada ativo deve possuir um `asset_id` interno, imutável, gerado pelo próprio sistema. Esse `asset_id` é a chave principal usada pelo ledger e nunca deve depender exclusivamente de ticker, nome, CNPJ ou código externo.
- Tickers, nomes e códigos de negociação devem ser tratados como identificadores auxiliares temporais, podendo variar ao longo do tempo sem alterar o `asset_id`.
- Em importações ou lançamentos por ticker, o backend deve resolver qual `asset_id` correspondia ao ticker informado na data do evento.
- O ledger deve registrar movimentações usando o `asset_id`, e não depender do ticker textual informado na planilha.
- Identificadores auxiliares:
	- Ações, BDR, FII, FI-INFRA e ETF nacional: CNPJ.
	- Stock, REIT e ETF internacional: usar ISIN quando disponível.
	- CRI, CRA, Debêntures: código do ativo/instrumento, quando disponível.
	- Tesouro Direto: usar o nome/tipo do título e data de vencimento.
- Ativos com vencimento. Debênture, CRI, CRA e Tesouro Direto possuem vencimento. O sistema deve permitir alerta antes do prazo e baixa assistida no ledger. A baixa por vencimento deve gerar evento de Resgate Vencimento, pendente de confirmação do usuário. A baixa antecipada deve gerar evento de Resgate Antecipado. A baixa não deve ser tratada como exclusão.
## Motor de cálculo
- Os eventos devem ser processados por:  
	1. data econômica do evento em ordem crescente;  
	2. ordem de lançamento/importação como critério de desempate estável.
### Precisão, cálculo e exibição
- Valores financeiros informados em eventos devem ser registrados com 2 casas decimais.  
- Quantidades devem aceitar até 8 casas decimais, especialmente para criptomoedas, Tesouro Direto e ativos fracionários.  
- Cálculos internos devem usar Decimal com alta precisão.  
- Valores monetários exibidos ao usuário devem ser truncados para 2 casas decimais.  
- Quantidades não devem ser truncadas para 2 casas decimais. A exibição de quantidade deve preservar a precisão necessária conforme a classe do ativo.  
- Preço médio, custo total, quantidade e resultado realizado devem manter precisão interna suficiente para recálculos posteriores, sem truncamento intermediário.
### Ledger, estado consolidado e recálculo
- O ledger de eventos é a fonte da verdade do sistema.
- A aplicação deve manter uma posição consolidada atual por ativo e carteira como estado derivado do ledger. Essa posição consolidada funciona como cache materializado confiável para leitura rápida pelo frontend, mas nunca substitui o ledger como fonte de verdade.
- A posição consolidada deve ser atualizada de forma transacional após a inclusão de novos eventos válidos.
- Qualquer correção histórica, estorno ou inserção de evento em data passada deve invalidar e reconstruir a posição consolidada daquele `asset_id` e `portfolio_id`.
- Relatórios históricos, conferências e reconstruções de posição devem poder ser recalculados a partir do ledger quando necessário.
#### Fluxo de processamento de novo evento:  
1. O usuário insere um evento.  
2. O backend valida o evento.  
3. O evento é salvo no ledger.  
4. O motor recalcula a posição daquele `asset_id` e `portfolio_id`.  
5. A posição consolidada atual é atualizada de forma transacional.  
6. O frontend lê a posição consolidada para exibir a carteira.  
#### Fluxo para evento histórico, correção ou estorno:  
1. O novo evento histórico, evento de estorno ou evento corrigido é salvo no ledger.  
2. A posição consolidada daquele ativo e carteira é invalidada.  
3. O motor reprocessa todos os eventos daquele `asset_id` e `portfolio_id` em ordem.  
4. A posição consolidada atual é regravada.  
5. Estados calculados por evento podem ser regravados, se essa estrutura existir.
### Correções e estornos
- Eventos são registros históricos. Não devem ser editados, sobrescritos ou apagados silenciosamente após salvos.  
- Correções devem preservar a trilha de auditoria por meio de estorno lógico e novo evento corrigido.
- Um evento lançado incorretamente deve ser anulado por um evento de estorno vinculado ao evento original.
- O evento de estorno não deve ser tratado como uma movimentação econômica comum na data em que foi criado. Ele deve funcionar como uma marcação de invalidação lógica do evento original.
- No recálculo patrimonial, o motor deve desconsiderar o evento original estornado e o próprio evento de estorno como movimentos econômicos.
- O lançamento correto deve ser registrado como um novo evento, vinculado ao evento original corrigido, usando a data econômica correta do evento.
  
Exemplo conceitual:
- Evento 10: Compra lançada incorretamente.
- Evento 11: Estorno lógico do Evento 10.
- Evento 12: Compra corrigida, vinculada ao Evento 10 como correção, usando a data econômica correta.
- No recálculo, o Evento 10 e o Evento 11 são ignorados como movimentos econômicos; o Evento 12 passa a representar a movimentação válida.
### Eventos
- **Compra** aumenta a quantidade em carteira pela quantidade informada, aumenta o custo total pelo valor da operação e recalcula o preço médio dividindo o novo custo total pela nova quantidade. 
- **Venda** reduz a quantidade em carteira pela quantidade vendida. O custo total é reduzido pelo custo médio anterior multiplicado pela quantidade vendida, ou seja, baixa do estoque o custo proporcional das cotas/ações vendidas. O preço médio é recalculado com base no custo remanescente e na quantidade restante; se a posição for zerada, o preço médio passa a zero. A venda gera resultado realizado pela diferença entre o valor recebido na venda e o custo médio anterior da quantidade vendida. 
- **Resgate Antecipado** reduz a quantidade em carteira, baixa o custo proporcional da posição e calcula resultado realizado usando a mesma lógica matemática da Venda. Deve ser usado quando o encerramento da posição ocorrer antes do vencimento natural do ativo.
- **Resgate Vencimento** reduz a quantidade em carteira, baixa o custo proporcional da posição e calcula resultado realizado usando a mesma lógica matemática da Venda. Deve ser usado quando o encerramento da posição ocorrer pelo vencimento natural do ativo.
- **Resgate Vencimento** deve ser usado preferencialmente para baixa de ativos com vencimento na data prevista, enquanto Resgate Antecipado deve ser usado para encerramentos antes do vencimento.
- **Desdobramento** aumenta a quantidade em carteira pela quantidade informada, mas não altera o custo total. Como o custo permanece o mesmo e a quantidade aumenta, o preço médio é reduzido proporcionalmente. Não gera resultado realizado nem altera o fluxo econômico, exceto pelo ajuste da quantidade.
- **Grupamento** reduz a quantidade em carteira pela quantidade informada, mas não altera o custo total. Como o custo permanece o mesmo e a quantidade diminui, o preço médio aumenta proporcionalmente. Não gera resultado realizado nem altera o fluxo econômico, exceto pelo ajuste da quantidade.
- **Bonificação** aumenta a quantidade em carteira pela quantidade recebida e aumenta o custo total pelo valor atribuído à bonificação. O preço médio é recalculado considerando a nova quantidade e o novo custo total. Na prática, a bonificação é tratada como um acréscimo de posição com custo fiscal/contábil informado. Não gera resultado realizado.
- **Amortização** não altera a quantidade em carteira, mas reduz o custo total pelo valor amortizado. Como a quantidade permanece igual e o custo diminui, o preço médio é reduzido. No fluxo de caixa, a amortização entra como entrada positiva, pois representa valor recebido. Não gera resultado realizado de venda. 
- **Cisão** não altera a quantidade em carteira, mas reduz o custo total pelo valor informado. Diferente da amortização, o fluxo de caixa é tratado como zero, pois a cisão é considerada uma reorganização patrimonial, não um recebimento financeiro direto. Como o custo diminui e a quantidade permanece igual, o preço médio é reduzido. Não gera resultado realizado.
- **Resultado realizado** é calculado em eventos de saída econômica da posição, como Venda, Resgate Antecipado e Resgate Vencimento. Ele compara o valor recebido no evento com o custo médio anterior da quantidade baixada. Os demais eventos não geram resultado realizado nessa lógica.
#### Valor Evento
- Valor Evento sempre representa o valor total do evento, não o preço unitário.
- Para Compra, Venda, Resgate Antecipado e Resgate Vencimento, Valor Evento = valor financeiro total da operação.
- Para Bonificação, Valor Evento = custo total atribuído à bonificação.
- Para Amortização, Valor Evento = valor total amortizado.
- Para Cisão, Valor Evento = custo total transferido/reduzido.
- Para Desdobramento e Grupamento, Valor Evento deve ser zero ou ignorado.
- Na Fase 1, Quantidade em Desdobramento e Grupamento representa a variação líquida de quantidade, não a proporção do evento. #TODO Acrescentar opção de proporção.
### Validações
- Quantidade deve ser positiva para todos os eventos que movimentam quantidade.  
- Valor Evento deve ser positivo quando representar valor financeiro ou custo atribuído.  
- Venda, Resgate Antecipado e Resgate Vencimento não podem deixar quantidade negativa.
- Amortização e Cisão não podem reduzir o custo total abaixo de zero, salvo regra explícita futura.  
- Ativo precisa existir antes de receber evento, exceto no cadastro inicial por Compra.  
- Desdobramento, Grupamento, Bonificação, Amortização e Cisão exigem que exista quantidade positiva em carteira na data econômica do evento, considerando o histórico reconstruído até aquela data.
- Se a posição estiver zerada na data econômica do evento, o lançamento deve ser rejeitado. O usuário deve registrar o evento com a data econômica correta, anterior à baixa total da posição, quando aplicável.
- Data do evento é obrigatória.

--- 
## Exemplos de teste
### Caso 1 — Compra simples  
Entrada:  
- Compra 10 cotas por Valor Evento 1000  
Resultado esperado:  
- quantidade = 10  
- custo_total = 1000  
- preco_medio = 100  
- resultado_realizado = 0  
### Caso 2 — Compra + compra  
Entrada:  
- Compra 10 por 1000  
- Compra 10 por 2000  
Resultado esperado:  
- quantidade = 20  
- custo_total = 3000  
- preco_medio = 150
### Caso 3 — Venda parcial com lucro  
Entrada:  
- Compra 10 por 1000  
- Venda 4 por 600  
Resultado esperado:  
- quantidade = 6  
- custo_total = 600  
- preco_medio = 100  
- resultado_realizado_evento = 200  
- resultado_realizado_acumulado = 200

---

## Backlog futuro - não implementar na Fase 1
Não implemente itens do Backlog Futuro. Apenas deixe a arquitetura preparada para extensões futuras quando isso não aumentar a complexidade da Fase 1.
- API para obter e armazenar cotações. Uso em dashboard.  
- Cadastro histórico e futuro de proventos.
### Eventos
- Compra. #TODO (TIR) No fluxo de caixa, a compra entra como saída de caixa, ou seja, valor negativo. Não gera resultado realizado. #TODO preço médio ajustado também é recalculado considerando o custo líquido dos proventos acumulados. 
- Venda. #TODO (TIR) No fluxo de caixa, a venda entra como entrada positiva. Venda não pode deixar a posição negativa. Venda total deve zerar PM e custo. #TODO Zera o total de proventos do ciclo.
- Amortização. #TODO O preço médio ajustado também é recalculado com base no novo custo líquido. Se amortização exceder o custo total, zerar custo e tratar o excedente como resultado realizado/ganho tributável, conforme regra fiscal aplicável.
--- 
- #TODO **Provento** não altera a quantidade em carteira nem o custo total. O valor recebido é acumulado como provento, desde que exista posição anterior. Esse total acumulado reduz o preço médio ajustado, pois representa retorno recebido sobre o investimento. No fluxo de caixa, o provento entra como entrada positiva. Também é calculado o yield do evento, comparando o valor recebido com o custo anterior da posição, e o yield acumulado, comparando os proventos acumulados com o custo atual.
- #TODO **Preço médio ajustado** considera o custo total reduzido pelos proventos acumulados, dividido pela quantidade atual. Ele mostra um custo econômico líquido da posição, considerando os valores já recebidos ao longo do tempo.
- #TODO **Fluxo de caixa** considera compras como saídas negativas, vendas, amortizações e proventos como entradas positivas, e cisões como evento neutro de caixa. Eventos patrimoniais sem pagamento direto apenas ajustam quantidade ou custo, conforme o caso.
- #TODO **Yield do evento** só é calculado para proventos. Ele mede quanto aquele provento representa em relação ao custo da posição antes do recebimento.
- #TODO **Yield acumulado** mede quanto o total de proventos acumulados representa em relação ao custo atual da posição. Ele é recalculado a cada linha, desde que exista custo positivo.
