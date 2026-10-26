# Acessibilidade (RNF-029, WCAG 2.1 nível AA)

Este documento diz como o Escambo web é auditado para a WCAG 2.1 AA, o que cada critério exige do app, como ele é atendido e **como isso é provado**: por teste automático, por revisão de código ou, quando nenhum dos dois basta, por uma verificação manual que ainda não foi feita. O roteiro dessa verificação está no fim.

**Situação na 1.46.0:** o que dá para provar automaticamente passa em desktop (1440 px) e celular (Pixel 7), e os problemas que a auditoria achou foram corrigidos (lista abaixo). **Não declaramos conformidade WCAG 2.1 AA**: onze critérios têm uma parte que depende de uma passada com leitor de tela, de zoom ou de espaçamento de texto que ainda não foi feita, e alguns pontos conhecidos ficam registrados como pendência (seção "O que fica fora").

## Método

A auditoria tem seis camadas. Cada critério da tabela aponta qual delas o prova.

1. **axe-core em todas as telas** (`apps/web/e2e/a11y.spec.ts` e `perfil.a11y.spec.ts`, com a regra em `a11y.helpers.ts`). Regras com etiqueta `wcag2a`, `wcag2aa`, `wcag21a` e `wcag21aa`, mais as de boa prática do axe só para relatório. Telas e estados cobertos:
   - públicas: login, login com erro, cadastro, esqueci a senha (formulário e enviado), redefinir senha (sem link, com link inválido, com link válido e com erro), confirmar e-mail (link válido e inválido), confirmar novo e-mail (antes e depois de confirmar), termos, privacidade e 404 (fora e dentro do app);
   - do menu: início com missões e uma proposta recebida, serviços, detalhe do serviço (do dono e de outra pessoa) com o modal de contratação, trocas com proposta recebida e enviada, ranking (geral, por categoria e "perto de mim"), carteira com ganhos (dois períodos, extrato em créditos) e o depósito PIX (valor e cobrança), notificações, perfil com o recorte da foto, perfil público com a galeria aberta, suporte com chamado aberto, a conversa e o modal de novo chamado;
   - sala da contratação: em andamento (freelancer), com o formulário de entrega com arquivo, entregue com arquivo na entrega e anexos de imagem e PDF no chat, a imagem ampliada, e concluída com o formulário de avaliação;
   - admin com dados em todos os relatórios (uso, financeiro, saúde da moderação), uma denúncia na fila, um chamado na fila e a conversa do chamado aberta;
   - verificação em duas etapas (desde a 1.48.0, `dois-fatores.smoke.spec.ts`): o cartão do perfil com o QR e a chave em texto, e o segundo passo do login;
   - página inicial pública, login e cadastro no visual da 1.49.0 (ADR 67): a página inteira e com as dúvidas abertas, a busca, a vitrine, as abas de "Como funciona" e a calculadora da torna (`landing.smoke.spec.ts`, com axe), além de todas as telas do app redesenhadas;
   - Admin redesenhado e gráficos novos da 1.50.0 (ADR 68): a faixa "Pede atenção agora", as filas em cartões (com itens e vazias), o Financeiro, o Uso e a saúde da moderação com os gráficos, e Meus ganhos nos três períodos.

   **Regra de reprovação:** qualquer violação de regra WCAG reprova o teste, seja qual for o impacto que o axe atribui (`critical`, `serious`, `moderate` ou `minor`). Até a 1.45.0 só `serious` e `critical` reprovavam. Não deixamos `minor` de fora: entre as regras com etiqueta WCAG quase nenhuma sai com esse impacto, e uma violação de critério é uma violação de critério, qualquer que seja o peso que a ferramenta lhe dá. Ficam **só no relatório** (anotação `axe` de cada teste): as regras de boa prática do axe, que não correspondem a um critério WCAG (por exemplo `heading-order`), e os itens que o axe não consegue decidir sozinho (`incomplete`, por exemplo contraste de texto sobre degradê). Esses últimos foram revistos à mão nesta versão (ver "Itens que o axe deixa para revisão").

2. **Auditoria de teclado** (`apps/web/e2e/teclado.smoke.spec.ts`, desktop e celular). Em início, serviços, detalhe do serviço, trocas, ranking, carteira, notificações, perfil, suporte, sala da contratação e admin, o Tab percorre a página inteira a partir do topo e o navegador registra cada parada no momento do foco. Reprova se:
   - a primeira parada não for o "Pular para o conteúdo";
   - alguma parada voltar para trás no documento, houver `tabindex` positivo, ou a navegação aparecer depois do conteúdo;
   - o foco cair em elemento invisível (tamanho zero, `visibility: hidden`, dentro de `aria-hidden` ou `inert`);
   - o elemento focado não tiver anel visível: contorno sólido de pelo menos 2 px com 3:1 contra o fundo em volta (calculado das cores do navegador), o anel padrão do navegador (`outline: auto`) ou sombra;
   - o Tab não chegar ao fim da página (armadilha) ou a URL mudar durante a passada (mudança de contexto ao receber foco).

   Também prova que o "pular" leva o foco ao `<main>` sem mudar a URL e que Shift+Tab volta à navegação; que cinco diálogos (depósito, novo chamado, contratação, galeria do portfólio e imagem do chat) abrem por Enter ou Espaço, prendem o Tab nos dois sentidos, fecham com Esc e devolvem o foco ao botão que abriu; que abas (Enter, Espaço, setas, Home e End), interruptor (Espaço), botão de alternância com `aria-pressed` (Enter) e a nota da avaliação (setas) respondem ao teclado; e que nenhuma tela tem controle com papel ARIA sobre elemento não nativo fora da lista conhecida (o recorte da foto e a galeria, cada um com teste próprio, e a região de tabela larga, que só rola). O pegar e soltar do portfólio pelo teclado continua em `portfolio-teclado.smoke.spec.ts` (ADR 53).

3. **Verificações no navegador que o axe não faz** (`apps/web/e2e/estados.a11y.spec.ts`, desktop e celular):
   - títulos: 20 rotas (públicas, do menu, sala, perfil público e admin) têm título "Tela · Escambo", todos diferentes, `lang="pt-BR"` em todas, e a troca de tela sem recarregar é repetida pela região viva;
   - alvos de toque: em 12 telas, todo controle visível tem pelo menos 24 × 24 px, ou está no meio de um texto, ou um círculo de 24 px centrado nele não encosta em outro alvo (a exceção de espaçamento da 2.5.8);
   - contraste do sistema de design: uma amostra de cada componente (botões primário, secundário, fantasma, mini, perigo, link, de ícone, alternância desligada e ligada, abas, campo, lista, área de texto, interruptor) e o link do menu são medidos em repouso, hover, foco de teclado e desabilitado, nas cores calculadas pelo navegador (com a composição dos fundos semitransparentes e da opacidade). Texto exige 4,5:1, contorno de campo e anel de foco 3:1; desabilitado é medido e registrado, mas não reprova (é isento na 1.4.3);
   - tokens: lendo o próprio `styles.css`, 19 pares de tokens usados juntos (texto, texto secundário, botões, avisos, contorno de campo e anel de foco sobre cada superfície) com o mínimo de cada um; `outline: none` só nos três seletores que não são controle ou têm outro indicador; e nada reordena a tela por CSS (a única inversão é o par rótulo/número das estatísticas, que é texto);
   - erros de campo: senha com confirmação diferente, troca de e-mail com senha errada, telefone inválido e redefinir senha com senhas diferentes deixam o campo certo com `aria-invalid="true"`, o erro como descrição acessível do campo e, onde faz sentido, o foco nele; os campos pessoais têm `autocomplete`;
   - regiões vivas: a região educada dos avisos existe antes do primeiro aviso, o sucesso entra nela e o erro sai como `role="alert"`, fora dela;
   - movimento reduzido: com `prefers-reduced-motion: reduce`, esqueleto, pulso e aviso não animam (nem em laço), botões não têm transição, e o chat rola até a última mensagem sem animação (sem a preferência, rola suave).

4. **Texto maior e mais espaçado** (`apps/web/e2e/texto.a11y.spec.ts`, desktop e celular, desde a 1.47.0). Em 24 telas e estados (as públicas, as do menu, a sala com anexos de nome comprido, trocas com proposta, o perfil com um trabalho de título e link compridos, o perfil público com a galeria aberta e o admin com dados e uma denúncia de descrição comprida na fila), duas vezes:
   - 1.4.4: só o texto a 200% (a raiz em 32 px, como o tamanho de fonte do navegador; vale porque o CSS usa `rem`), na largura da tela;
   - 1.4.12: altura da linha 1,5, parágrafo com 2 em depois, letras a 0,12 em e palavras a 0,16 em.

   Reprova se a página rolar na horizontal, se uma caixa que corta (`overflow` hidden ou clip, reticências, corte de linhas) ficar menor que o texto dela, ou se a linha de um texto cruzar a de outro (cada linha medida pelo `Range`, só a parte que aparece, e com um diálogo aberto só o que está nele). Não contam como perda: a rolagem dentro de um contêiner (tabela, chat), o resumo marcado com `data-resumo` (a descrição do card de serviço, com o texto inteiro na página do serviço), o rótulo dentro de um gráfico `role="img"` (os números estão na tabela logo abaixo) e as iniciais decorativas do avatar.

5. **Testes de unidade** (Vitest, `npm run test:cov --workspace @escambo/web`): "pular para o conteúdo" (`components/ui/index.test.tsx` e `Shell.test.tsx`), setas nas abas, foco do diálogo com campo de foco automático, avisos em região educada e alerta (`lib/toast.test.tsx`), imagem do chat que prende o Tab e devolve o foco (`ChatAttachment.test.tsx`), `aria-pressed` e alerta no login, `aria-invalid` e descrição nos erros de senha, e-mail e redefinição, movimento reduzido (`lib/motion.test.ts`).

6. **Revisão de código**, para o que não tem como ser medido: textos de instrução, mensagens de erro com sugestão, confirmações antes de mexer em dinheiro, ausência de áudio, vídeo, piscadas e atalhos de uma tecla. Cada item está na tabela.

Para rodar a parte automática (com a API, o banco e o web no ar, ver `playwright.config.ts`):

```bash
cd apps/web
npx playwright test --project=desktop --project=mobile e2e/a11y.spec.ts e2e/perfil.a11y.spec.ts e2e/estados.a11y.spec.ts e2e/texto.a11y.spec.ts e2e/teclado.smoke.spec.ts e2e/portfolio-teclado.smoke.spec.ts
```

No CI esses arquivos já rodam no `npm run e2e` (projetos desktop e mobile).

## O que a auditoria encontrou e foi corrigido na 1.46.0

| Problema | Critério | Correção | Prova |
|---|---|---|---|
| Anel de foco dos botões em verde a 30%: 1,6:1 contra o fundo | 2.4.7, 1.4.11 | Token `--focus`, contorno sólido de 2 px (7:1 ou mais sobre as superfícies claras) | `teclado.smoke`, `estados.a11y` |
| Foco de campo só com um halo de 1,6:1, e o da área de texto praticamente invisível (halo verde-claro) | 2.4.7, 1.4.11 | Campos, listas e áreas de texto com o mesmo anel sólido | idem |
| Contorno dos campos a 1,5:1 e trilho do interruptor desligado a 1,2:1 sobre o cartão | 1.4.11 | Token `--border-input` (3,6:1 sobre o cartão, 3,2:1 sobre o verde-claro) | `estados.a11y` (amostra e tokens) |
| Nenhum "pular para o conteúdo": nove links de menu antes do conteúdo em toda tela | 2.4.1 | `SkipLink` no shell, primeiro Tab de toda tela, levando o foco ao `<main id="conteudo">` sem mexer na URL | `teclado.smoke`, `Shell.test`, `index.test` |
| Imagem ampliada do chat: o Tab saía para a página atrás e, ao fechar, o foco ia para o `<body>` | 2.4.3, 2.1.2 | Foco de diálogo extraído do `Modal` (`useDialogFocus`) e usado também aqui | `teclado.smoke` (diálogos), `ChatAttachment.test` |
| `Modal` com campo de foco automático devolvia o foco a esse campo (que já saiu da tela) em vez de a quem abriu | 2.4.3 | Quem abriu é lido no primeiro render, antes do `autoFocus` | `index.test` |
| Aviso de erro (toast) na mesma região educada do sucesso: lido só depois de o leitor terminar o que estava lendo | 4.1.3 | Sucesso e informação numa região `role="status"` que existe desde o início; erro como `role="alert"`, fora dela | `estados.a11y`, `toast.test` |
| Erros do login, de "esqueci a senha" e de "redefinir senha" só visuais; confirmações das páginas públicas sem região viva | 4.1.3, 3.3.1 | `role="alert"` nos erros, `role="status"` nas confirmações | `a11y.spec` (login com erro), testes de unidade |
| Erro de campo sem `aria-invalid` (senha, troca de e-mail, redefinir senha); redefinir senha nem ligava o erro ao campo | 3.3.1, 4.1.2 | Só o campo a corrigir fica inválido, com o erro em `aria-describedby` | `estados.a11y`, `SenhaCard.test`, `EmailCard.test`, `AccountViews.test` |
| "Entrar" e "Criar conta": o modo escolhido só aparecia na cor | 4.1.2, 1.4.1 | `aria-pressed` nos dois botões, num grupo com nome | `LoginForm.test` |
| Páginas públicas pequenas (senha, e-mail) sem `h1` | 1.3.1, 2.4.6 | O título do cartão vira o `h1` | `a11y.spec` |
| Cartão de arquivo (entrega e chat) com nome "Baixar x.pdf", sem o tamanho que está escrito nele (axe `label-content-name-mismatch`, serious) | 2.5.3 | O nome vem do texto do cartão, com "Baixar" só para o leitor de tela | `a11y.spec` (sala com entrega), `ChatAttachment.test` |
| Tamanho do arquivo na bolha da própria pessoa a 4,0:1 (axe `color-contrast`, serious) | 1.4.3 | Branco a 90% (4,8:1) | `a11y.spec` |
| No celular, as tabelas do admin, da carteira e do início rolam na horizontal dentro do cartão, mas a área de rolagem não recebia foco: sem mouse não dava para ver as colunas da direita (axe `scrollable-region-focusable`, serious, só no projeto mobile) | 2.1.1 | Componente `TableWrap`: região com nome que entra no Tab e rola com as setas, com anel de foco por dentro | `a11y.spec` (mobile), `index.test` |
| Destaques da tela de login a 4,0:1 no ponto mais claro do degradê (o axe deixa para revisão) | 1.4.3 | Texto a 95% (4,9:1) | conta na seção seguinte |
| Ao abrir a Sala, a rolagem do chat rolava a página inteira até o fim: a tela pulava para o chat e o primeiro Tab caía no campo de mensagem | 2.4.3 | Só a lista do chat rola | `teclado.smoke` (sala), `SalaContratoView.test` |
| Sala e detalhe do serviço com o mesmo título na aba | 2.4.2 | Sala vira "Contratação: …" | `estados.a11y` (títulos) |
| Abas (`role="tab"`) sem setas, Home e End | 4.1.2 (padrão ARIA de abas), 2.1.1 | `onTablistKeyDown` nas oito listas de abas | `teclado.smoke`, `index.test` |
| Movimento reduzido: as animações em laço (esqueleto, pulso) continuavam em laço, e a rolagem do chat era sempre suave | 2.3.3 (AAA, aplicado mesmo assim) | `animation-iteration-count: 1`, `scroll-behavior: auto` e `scrollBehavior()` no código | `estados.a11y`, `motion.test` |
| Nome, cidade e UF do perfil sem `autocomplete` | 1.3.5 | `name`, `address-level2`, `address-level1` | `estados.a11y` |
| No celular, o elemento focado perto do fim podia ficar atrás da barra de navegação fixa | 2.4.7 (e 2.4.11 da WCAG 2.2) | `scroll-padding-bottom` do tamanho da barra | `teclado.smoke` (mobile) |

O axe, estendido às telas que faltavam e ao celular, achou três violações, todas `serious`: duas na sala com entrega e anexos (nome do cartão de arquivo e contraste do tamanho) e uma só no celular (tabelas que rolam sem foco). Nenhuma `moderate` ou `minor`. As demais linhas da tabela vieram da auditoria de teclado, das medições no navegador e da revisão.

### Corrigido na 1.47.0 (texto maior e mais espaçado)

| Problema | Critério | Correção | Prova |
|---|---|---|---|
| Nome da conta no menu cortado com reticências a 125 px em toda tela (o e-mail, para quem não tem nome) | 1.4.4, 1.4.12 | O nome quebra a linha, e o e-mail quebra em qualquer ponto | `texto.a11y` |
| Aviso de saque bloqueado na carteira: o e-mail longo alargava o cartão e a página rolava na horizontal | 1.4.4, 1.4.12 | O texto encolhe com o cartão e quebra em qualquer ponto | `texto.a11y` |
| Valores dos indicadores (início, carteira, admin) e do resumo financeiro e de uso invadiam o cartão vizinho com o texto a 200% | 1.4.4 | Colunas com mínimo em `rem` (13rem nos indicadores, até 4 por linha): com o texto maior cabem menos por linha. As demais grades de cartões também passaram de px para rem (o mesmo mínimo com a raiz de 16 px; 6% menor abaixo de 1440 px de tela, onde a raiz é de 15 px). O valor do indicador quebra a linha em último caso | `texto.a11y` |
| Tamanho base da fonte fixo em `15px`: o tamanho de fonte escolhido nas configurações do navegador não tinha efeito | 1.4.4 | `93.75%` (16 px a partir de 1440 px de tela): os mesmos 15 px no padrão | Revisão de `styles.css` |
| E-mail de acesso no perfil invadia o cartão do telefone com o texto a 200% | 1.4.4 | Quebra em qualquer ponto | `texto.a11y` |
| Nome no pódio do ranking, títulos da troca, nome do anexo, link do portfólio e título da galeria cortados com reticências | 1.4.4, 1.4.12 | Quebram a linha em vez de cortar | `texto.a11y` (a mutação que devolve as reticências reprova) |
| Admin: descrição da denúncia, trecho denunciado, nota da decisão, descrição da disputa e motivo do pedido de exclusão cortados em duas linhas, sem o texto inteiro em outro lugar | 1.4.4, 1.4.12 (e perda de conteúdo mesmo no tamanho normal) | O corte saiu: o texto aparece inteiro | `texto.a11y` (com uma denúncia de descrição comprida na fila) |
| Desistências e remoções no admin: com o texto a 200% no celular, o título passava por cima do botão "Não contar" | 1.4.4 | A linha quebra: o texto fica com pelo menos 14rem e os botões descem | `texto.a11y` (rodado depois da suíte inteira) |
| Iniciais do avatar no ranking lidas pelo leitor de tela e cortadas no círculo com o texto maior | 1.1.1, 1.4.4 | `aria-hidden`, como no componente `Avatar`: o nome vem ao lado | `texto.a11y` |

### Verificado na 1.49.0 (visual novo, ADR 67)

- **Cobertura:** a página inicial, o login e o cadastro entraram no axe, no teste de títulos, nos alvos de 24 px, no texto a 200% e no espaçamento (com as dúvidas abertas), nos 320 e 768 px e na passada de teclado (pular, Tab completo, `<details>` com Enter e Espaço, abas com setas, Home e End). O teste de tokens passou a medir 63 pares de cor.
- **Fundos escuros e fotos:** texto nunca fica direto sobre degradê ou foto. Onde há brilho decorativo, ele fica numa camada à parte (`aria-hidden`), e o contraste foi medido ponto a ponto sob cada linha: topo da página inicial com 8,54:1 no pior ponto (6,42:1 no celular), chamada final 10,17:1 (5,88:1), seção da troca 7,54:1, painel do login 6,04:1 em texto grande. As fotos são decorativas (`alt=""`) e os nomes das categorias ficam numa faixa sólida.
- **Corrigido no caminho:** texto cortado ou sobreposto a 200% na faixa de boas-vindas do Início, no cartão de saldo da Carteira, no recibo da Sala e no pódio do Ranking; rolagem lateral no Perfil a 200%; atalhos de seção do Admin trocados de `<nav>` solto por lista com nome.
- **Movimento:** os avisos que entram na página inicial e o brilho do topo param com `prefers-reduced-motion`.

### Verificado na 1.50.0 (marca, gráficos e Admin, ADR 68)

- **Gráficos:** cada gráfico é uma figura com `role="img"` e um resumo em texto (o maior valor, o total e o período), a legenda fica fora do desenho e uma tabela traz os mesmos números. A dica aparece também ao tocar e com o ponteiro, e os rótulos do eixo são em `rem`, então acompanham o texto a 200% (rareiam em vez de se sobrepor). A cor nunca é a única pista: a série principal tem o valor escrito no pico, e no empilhado o número vai dentro do segmento.
- **Contraste das marcas de dado (1.4.11):** as séries ficam acima de 3:1 sobre o cartão e o bloco claro. O cinza de contexto (`--viz-muted`, 2,15:1) fica abaixo de propósito, porque não carrega informação sozinho: o número dentro dele tem 8,3:1, e a legenda e a tabela repetem o valor. O teste de tokens passou de 67 para 82 pares, incluindo o símbolo da marca sobre o branco, o fundo e o papel.
- **Marca:** o símbolo é decorativo onde o nome "Escambo" já está escrito ao lado (`aria-hidden`), e o âmbar dele (`--brand-amber`, 3,3:1) só aparece em forma, nunca em texto.
- **Corrigido no caminho:** as filas do Admin vazias mostravam o cabeçalho de uma tabela sem linhas, que o leitor de tela anunciava como tabela vazia; agora mostram o estado vazio com texto.

### Itens que o axe deixa para revisão

O axe marca como `incomplete` o que não consegue medir. Foram revistos assim:

- **Tela de login, texto sobre o degradê** (`linear-gradient` de `#073622` a `#11704a`): conta feita no ponto mais claro (`#11704a`) — título e marca em branco 6,1:1; "Evolua." em `#f6b73c` 3,4:1 (texto grande, mínimo 3:1); frase de abertura a 86% 5,0:1; título dos destaques 5,3:1 e descrição (agora a 95%) 4,9:1 sobre o fundo do cartão de destaque.
- **Aviso de saque bloqueado na carteira** (sobreposição com o ícone): `--amber-ink` sobre `--amber-soft`, 6,7:1.
- **Texto do modal de novo chamado** (o modal rola): `--muted` sobre branco, 5,9:1.
- **Rótulos dos gráficos do admin** (texto dentro de SVG): `--muted` sobre branco, 5,9:1, e `--amber-ink` sobre branco. São pequenos (9 unidades do `viewBox`, escalados com o gráfico); cada gráfico tem `role="img"` com um resumo em texto, e os números estão também nas tabelas.
- **Tabelas do admin sem linhas** (`th-has-data-cells`): fila de disputas, de saques e de exclusões vazias. O cabeçalho sem dados não engana o leitor de tela, mas o ideal é trocar a tabela vazia por um estado vazio (pendência pequena, sem critério violado).

## Critérios WCAG 2.1 A e AA

Situação: **Atende (teste)** quando há teste automático que reprova se o critério quebrar; **Atende (revisão)** quando a prova é a leitura do código; **Manual pendente** quando só uma pessoa com a tecnologia assistiva pode confirmar (o que existe de automático está dito); **Não se aplica** quando o app não tem o tipo de conteúdo.

| Critério | Nível | Situação | Como é atendido | Prova |
|---|---|---|---|---|
| 1.1.1 Conteúdo não textual | A | Atende (teste) e manual pendente | Fotos com `alt` (nome da pessoa, título do trabalho, nome do anexo); ícones decorativos com `aria-hidden` (padrão do lucide e explícito); botões só de ícone com `aria-label`; gráficos com `role="img"` e resumo em texto | axe `image-alt`, `svg-img-alt`, `role-img-alt`, `button-name`; a qualidade dos textos alternativos é do roteiro manual |
| 1.2.1 Somente áudio e somente vídeo | A | Não se aplica | O app não tem áudio nem vídeo próprios | — |
| 1.2.2 Legendas (pré-gravado) | A | Não se aplica | Idem | — |
| 1.2.3 Audiodescrição ou mídia alternativa | A | Não se aplica | Idem | — |
| 1.2.4 Legendas (ao vivo) | AA | Não se aplica | Idem | — |
| 1.2.5 Audiodescrição (pré-gravado) | AA | Não se aplica | Idem | — |
| 1.3.1 Informações e relações | A | Atende (teste) e manual pendente | Marcação semântica: cabeçalhos, listas, tabelas com `th`, rótulos com `<label>`, grupos com `fieldset`/`legend` ou `role="group"`, regiões com nome | axe `list`, `listitem`, `label`, `th-has-data-cells`, `aria-required-*`, `definition-list`; a hierarquia dos títulos é do roteiro manual (ver `heading-order` em "O que fica fora") |
| 1.3.2 Sequência significativa | A | Atende (teste) | Ordem do documento = ordem visual: nada é reordenado por CSS | `estados.a11y` (CSS sem `order`/`-reverse`), `teclado.smoke` (ordem do Tab segue o documento) |
| 1.3.3 Características sensoriais | A | Atende (revisão) | Instruções não dependem de forma, cor ou posição ("o botão verde", "à direita"): citam o nome do controle | Revisão dos textos de ajuda e avisos |
| 1.3.4 Orientação | AA | Atende (teste) | Nenhuma tela trava retrato ou paisagem | axe `css-orientation-lock`; `responsivo.spec.ts` |
| 1.3.5 Identificar o propósito da entrada | AA | Atende (teste) | `autocomplete` em e-mail, senhas, telefone, nome, cidade e UF | axe `autocomplete-valid`; `estados.a11y` |
| 1.4.1 Uso de cor | A | Atende (teste e revisão) | Links dentro de texto sublinhados; status com texto (pílulas), erro com ícone e texto, aba e alternância com estado em ARIA | axe `link-in-text-block`; revisão |
| 1.4.2 Controle de áudio | A | Não se aplica | Nada toca sozinho | — |
| 1.4.3 Contraste (mínimo) | AA | Atende (teste) | Tokens com 4,5:1 nos pares usados; texto sobre degradê conferido à mão | axe `color-contrast`; `estados.a11y` (tokens e estados); contas da seção anterior |
| 1.4.4 Redimensionar texto | AA | Atende (teste) | Tamanhos em `rem`, layout fluido, grades com mínimo em `rem`; nada corta texto com reticências fora dos resumos com o texto inteiro em outra página | `texto.a11y` (texto a 200% em 24 telas, desktop e celular); `responsivo.spec.ts` a 320 px (o zoom da página inteira) |
| 1.4.5 Imagens de texto | AA | Atende (revisão) | A marca é texto; não há texto em imagem gerada pelo app | Revisão |
| 1.4.10 Refluxo | AA | Atende (teste) | Uma coluna a 320 px, sem rolagem horizontal da página; tabelas largas rolam no próprio contêiner | `responsivo.spec.ts` |
| 1.4.11 Contraste não textual | AA | Atende (teste) | Contorno de campo, trilho do interruptor e anel de foco com 3:1 ou mais | `estados.a11y` (tokens e amostra), `teclado.smoke` (anel de cada parada) |
| 1.4.12 Espaçamento de texto | AA | Atende (teste) | Sem altura fixa em caixas de texto; nenhum espaçamento inline com `!important` | `texto.a11y` (o espaçamento do critério em 24 telas, desktop e celular); axe `avoid-inline-spacing` |
| 1.4.13 Conteúdo em hover ou foco | AA | Atende (revisão) | O app não cria conteúdo que aparece no hover ou foco; as dicas são o `title` nativo do navegador | Revisão (sem tooltip próprio no código) |
| 2.1.1 Teclado | A | Atende (teste) | Tudo é botão, link ou campo nativo; os controles próprios (recorte, galeria, ordenar portfólio, abas) têm teclas; tabela que rola na horizontal recebe foco | `teclado.smoke`, `portfolio-teclado.smoke`, axe `scrollable-region-focusable`, testes de unidade do recorte e da galeria |
| 2.1.2 Sem armadilha de teclado | A | Atende (teste) | O Tab chega ao fim de cada tela; diálogos prendem o foco de propósito e fecham com Esc | `teclado.smoke` |
| 2.1.4 Atalhos de teclado por caractere | A | Atende (revisão) | As teclas de uma letra ou símbolo (`+`, `-`, `0` no zoom) só valem com o foco na galeria ou no recorte | Revisão de `PortfolioGallery` e `AvatarCropper` |
| 2.2.1 Tempo ajustável | A | Atende (teste) | A sessão se renova sozinha (refresh token); a cobrança PIX vence em 30 min, mas outra pode ser gerada; prazos de contratação são regra de negócio em dias. Os avisos de erro ficam até a pessoa fechar; os de sucesso e informação saem em 6 s, mas o relógio para com o mouse em cima ou o foco dentro, e todos têm o botão "Fechar aviso" | `toast.test` |
| 2.2.2 Pausar, parar, ocultar | A | Atende (revisão) e manual pendente | Esqueleto e pulso só enquanto carrega (e param com movimento reduzido); o "expira em" das missões muda uma vez por minuto | `estados.a11y` (movimento reduzido); o contador de minutos é do roteiro |
| 2.3.1 Três flashes | A | Atende (revisão) | Nada pisca | Revisão |
| 2.4.1 Ignorar blocos | A | Atende (teste) | "Pular para o conteúdo" e regiões `nav` e `main` | `teclado.smoke`, axe `bypass` |
| 2.4.2 Página com título | A | Atende (teste) | `usePageTitle` em cada tela, títulos diferentes entre rotas | `estados.a11y`, axe `document-title` |
| 2.4.3 Ordem do foco | A | Atende (teste) | Ordem do documento, sem `tabindex` positivo; diálogos recebem e devolvem o foco | `teclado.smoke` |
| 2.4.4 Finalidade do link (em contexto) | A | Atende (teste) e manual pendente | Todo link tem nome; os "Abrir" das notificações estão dentro do item da notificação | axe `link-name`; a leitura em contexto é do roteiro |
| 2.4.5 Várias formas | AA | Atende (revisão) | Menu principal, busca de serviços, links das notificações e do início | Revisão |
| 2.4.6 Cabeçalhos e rótulos | AA | Atende (revisão) e manual pendente | Toda tela tem `h1`; cartões com título; campos com rótulo visível | `estados.a11y` (h1 em 20 rotas), axe `label`; clareza é do roteiro |
| 2.4.7 Foco visível | AA | Atende (teste) | Anel sólido de 2 px em botões e campos, anel do navegador em links | `teclado.smoke` (todas as paradas das telas principais), `estados.a11y` |
| 2.5.1 Gestos de acionamento | A | Atende (revisão) | Deslizar e pinçar na galeria têm botões; arrastar no portfólio tem setas e pegar e soltar pelo teclado (ADR 49 e 53); arrastar no recorte tem setas e zoom por botão | Revisão e testes de unidade dos componentes |
| 2.5.2 Cancelamento do acionamento | A | Atende (revisão) | Ações no clique (soltar o ponteiro) de controles nativos; o arraste do portfólio só grava ao soltar e Esc cancela | Revisão, `portfolio-teclado.smoke` |
| 2.5.3 Rótulo no nome | A | Atende (teste) | O nome acessível contém o texto visível (corrigido no cartão de arquivo) | axe `label-content-name-mismatch` |
| 2.5.4 Acionamento por movimento | A | Não se aplica | Nada responde a sacudir ou inclinar o aparelho | — |
| 3.1.1 Idioma da página | A | Atende (teste) | `<html lang="pt-BR">` | `estados.a11y`, axe `html-has-lang`, `html-lang-valid` |
| 3.1.2 Idioma das partes | AA | Atende (revisão) | Não há trechos em outro idioma além de nomes próprios e termos correntes | Revisão |
| 3.2.1 Em foco | A | Atende (teste) | Receber foco não navega nem abre nada | `teclado.smoke` (URL igual do início ao fim da passada) |
| 3.2.2 Em entrada | A | Atende (revisão) | Filtros que atualizam a lista ao mudar (categoria do ranking, situação do suporte) mudam conteúdo, não contexto; envio de formulário só no botão | Revisão |
| 3.2.3 Navegação consistente | AA | Atende (teste) | O mesmo menu, na mesma ordem, em todas as telas do app | `Shell.test`, `responsivo.spec.ts` |
| 3.2.4 Identificação consistente | AA | Atende (revisão) | Mesmos rótulos e ícones para a mesma função (Baixar, Fechar, Depositar) | Revisão |
| 3.3.1 Identificação do erro | A | Atende (teste) | Erro em texto, anunciado (`role="alert"`) e, quando é de um campo, marcado nele | `estados.a11y`, testes de unidade dos formulários |
| 3.3.2 Rótulos ou instruções | A | Atende (teste) | Rótulo visível em todo campo; formato pedido na dica (telefone com DDD, mínimo de 8 caracteres) | axe `label`, `select-name`; revisão |
| 3.3.3 Sugestão de erro | AA | Atende (revisão) | As mensagens dizem o que corrigir ("As senhas não conferem", "A nova senha precisa ser diferente da atual", o motivo da API) | Revisão |
| 3.3.4 Prevenção de erros (financeiros) | AA | Atende (revisão) e manual pendente | Contratação revisada no modal antes de enviar; cancelamento mostra o valor antes (ADR 57); sair da negociação pede confirmação; saque aguardando pode ser cancelado; depósito só movimenta quando a pessoa paga o PIX | Revisão; o roteiro passa por cada fluxo |
| 4.1.1 Análise sintática | A | Atende (teste) | React gera HTML bem formado; ids únicos por `useId` | axe `duplicate-id-aria` (o critério é obsoleto na WCAG 2.2) |
| 4.1.2 Nome, função, valor | A | Atende (teste) e manual pendente | Controles nativos; estados em `aria-pressed`, `aria-selected`, `aria-checked`, `aria-invalid`; diálogos com `aria-modal` e nome | axe `aria-*`, `button-name`, `nested-interactive`; testes de unidade; o que o leitor anuncia é do roteiro |
| 4.1.3 Mensagens de status | AA | Atende (teste) e manual pendente | Avisos em região viva educada ou alerta; troca de tela anunciada; carregamento com `role="status"` | `estados.a11y`, `toast.test`, `title.test`; se o NVDA lê cada um é do roteiro |

Resumo: 50 critérios (30 de nível A e 20 de nível AA). Sete não se aplicam (áudio, vídeo e movimento do aparelho). Dos 43 que se aplicam, 28 têm prova automática (cinco deles com um complemento manual: 1.1.1, 1.3.1, 2.4.4, 4.1.2 e 4.1.3) e 15 têm prova por revisão de código (três com complemento manual: 2.2.2, 2.4.6 e 3.3.4). Nenhum depende só de verificação manual desde a 1.47.0; os oito complementos com leitor de tela seguem no roteiro.

## O que fica fora

- **Leitor de tela de verdade.** Nenhum teste automático garante o que o NVDA, o JAWS ou o VoiceOver anunciam. O roteiro abaixo é o aceite que falta; até ele ser feito, os critérios marcados com "manual pendente" não estão provados por inteiro.
- **Hierarquia dos títulos.** As telas têm `h1` e os cartões usam `h3` (o componente `Card`), pulando o `h2`. Não é violação de critério (o axe registra como boa prática, `heading-order`), mas atrapalha um pouco quem navega por títulos. Corrigir pede passar os cartões para `h2` em todas as telas, com os testes que dependem do nível.
- **Avisos que somem.** Resolvido na 1.46.0 (2.2.1): o aviso de erro fica até ser fechado, e o de sucesso para o relógio com o mouse em cima ou o foco dentro.
- **Zoom e espaçamento de texto** (1.4.4 e 1.4.12): resolvido na 1.47.0, com teste. O teste mede corte, sobreposição e rolagem; a legibilidade (uma palavra quebrada no meio, por exemplo) fica para o roteiro.
- **Conteúdo enviado pelas pessoas**: PDFs e imagens de entregas e anexos, e o texto alternativo das fotos (que é o nome ou o título) não são auditados.
- **E-mails transacionais**: o HTML dos e-mails não passa pelo axe.
- **Estados desabilitados**: isentos de contraste pela 1.4.3; medidos e registrados no teste (texto entre 2,1:1 e 3,4:1 com a opacidade de 50%).
- **WCAG 2.2**: fora do escopo do RNF-029. Mesmo assim, os alvos de 24 px (2.5.8) são testados, o foco não fica escondido pela barra do celular (2.4.11) e arrastar sempre tem alternativa (2.5.7).

## Roteiro de verificação manual (NVDA no Windows)

Quem for fazer: NVDA atualizado com Chrome e com Firefox, a stack de demonstração com `npm run demo:seed`, uma conta de cliente, uma de freelancer e uma de admin. Anote em cada passo o que o NVDA falou; qualquer coisa diferente do esperado é um defeito.

1. **Navegação geral (2.4.1, 2.4.2, 4.1.3).** Abra `/` logado. Com Tab, o primeiro item deve ser "Pular para o conteúdo, link"; Enter deve levar o foco ao conteúdo. Use o menu: a cada tela, o NVDA deve anunciar o título novo ("Carteira · Escambo"). Com `D` (marcos) devem aparecer "navegação Principal" e "principal".
2. **Títulos e regiões (1.3.1, 2.4.6).** Em cada tela, `H` e `1` levam ao `h1`; a lista de títulos (NVDA+F7) deve fazer sentido como sumário da tela.
3. **Formulários (1.3.1, 3.3.1, 3.3.2, 4.1.2).** No login, em modo de foco, o NVDA deve ler "Entrar, botão de alternância, pressionado". Erre a senha: "E-mail ou senha incorretos" deve ser lido sem mover o foco. No perfil, troque a senha com confirmação diferente: o foco vai para "Confirmar nova senha", lido como "inválido" e com "As senhas não conferem".
4. **Avisos (4.1.3).** Salve o telefone: "Telefone salvo." deve ser lido. Provoque um erro de rede (DevTools, Network, Offline) e clique em "Reenviar e-mail" na faixa de confirmação: o erro deve ser lido na hora, interrompendo a leitura.
5. **Diálogos (2.4.3, 4.1.2).** Abra Depositar, Contratar, Novo chamado, a galeria do perfil público e uma imagem do chat. Ao abrir, o NVDA lê "diálogo" e o título; Tab não sai do diálogo; Esc fecha e o foco volta ao botão que abriu.
6. **Abas e alternâncias (4.1.2).** Na carteira, "Reais, aba, selecionado, 1 de 2"; setas trocam a aba. No ranking, "Perto de mim, botão de alternância, não pressionado".
7. **Sala da contratação (1.1.1, 2.5.3, 4.1.3).** Abra uma contratação com entrega e anexos: o cartão de arquivo deve ser lido como "Baixar manual.pdf 120 B, botão". Mande uma mensagem pelo outro lado: a mensagem nova deve aparecer sem a página pular.
8. **Nota da avaliação (4.1.2).** Em contratação concluída, "Nota, agrupamento", e as setas escolhem "3 estrelas", etc.
9. **Pegar e soltar do portfólio (ADR 53).** Em modo de foco, Espaço pega, setas movem com anúncio da posição, Espaço solta; em modo de navegação, nada fica preso.
10. **Gráficos (1.1.1).** Na carteira e no admin, o gráfico deve ser lido como imagem com o resumo em texto.
11. **Zoom de 200% (1.4.4).** Coberto pelo `texto.a11y` desde a 1.47.0. Na passada manual, Chrome em 1280 × 800, Ctrl e + até 200%: confira se a leitura continua confortável.
12. **Espaçamento de texto (1.4.12).** Coberto pelo `texto.a11y` desde a 1.47.0. Na passada manual, aplique o CSS do critério por extensão e confira os botões, pílulas e abas de telas que o teste não abre.
13. **Tempo (2.2.1, 2.2.2).** Confira com o NVDA que o aviso é lido inteiro antes de sair e que "Fechar aviso" é anunciado. Veja se o "expira em" das missões incomoda a leitura.
14. **Dinheiro (3.3.4).** Contratar, cancelar, sair da negociação, sacar e cancelar o saque: em todos deve haver revisão antes ou como desfazer depois.

Repita os passos 1, 3, 5 e 7 com o VoiceOver no iPhone (Safari) e o TalkBack no Android (Chrome), que usam a barra inferior.
