# Catálogo de Materiais — Códigos SAP e Referências Cruzadas

Sistema **compartilhado pela equipe** para concentrar em um só lugar os códigos
SAP internos, referências de fabricantes, fotos e localizações de materiais que
hoje estão espalhados em cadernos, grupos de WhatsApp e catálogos físicos/online.

**O que ele faz:**

- 🔍 **Busca inteligente** — por código SAP, referência de fabricante, descrição
  ou equipamento; ignora acentos e pontuação (`W9507` encontra `W950/7`).
- ☁️ **Base compartilhada na nuvem** (Supabase) — todo mundo vê o mesmo catálogo,
  com atualização **em tempo real** entre os aparelhos.
- 🔐 **Login com aprovação** — colegas criam conta e um administrador aprova o
  acesso na aba *Equipe*.
- 📷 **Fotos dos materiais** — tire foto pelo celular na hora do cadastro
  (comprimidas automaticamente).
- 📱 **Leitor de código de barras/QR** — escaneie a etiqueta da prateleira para
  achar o material ou preencher o código SAP no cadastro.
- 🏷️ **Impressão de etiquetas QR** — gere etiquetas com QR + código SAP +
  descrição + localização para colar nas prateleiras.
- 📥📤 **Importação/exportação CSV** (Excel) e backup JSON.
- 📡 **Modo offline de leitura** — sem internet, mostra a última cópia salva no
  aparelho.

## Como usar

O sistema é um site estático (`index.html` + `css/` + `js/`) que conversa com a
base no Supabase. Para a equipe usar no celular, publique no GitHub Pages:

1. Neste repositório, vá em **Settings → Pages**.
2. Em *Source*, escolha **Deploy from a branch**, selecione a branch principal
   e a pasta `/ (root)`.
3. Em ~1 minuto o sistema estará em `https://SEU-USUARIO.github.io/Catalogo/` —
   salve na tela inicial do celular e use como aplicativo.

> ⚠️ O **leitor de câmera só funciona em HTTPS** (o GitHub Pages já é HTTPS).
> Abrir o `index.html` direto do arquivo funciona para buscar/cadastrar, mas a
> câmera fica bloqueada pelo navegador.

### Primeiro acesso

- **Jefferson**: sua conta `jeffersonpm16@gmail.com` já está criada como
  **administrador aprovado** (é a mesma senha que você já usa nos apps deste
  projeto Supabase; se não lembrar, use “Esqueci minha senha”).
- **Colegas**: clicam em **Criar conta** na tela de entrada. A conta nasce
  “pendente” — um admin aprova na aba **👥 Equipe** (o botão fica com um aviso
  vermelho quando há gente esperando).

### Configuração recomendada no painel do Supabase (uma vez só)

No [painel do Supabase](https://supabase.com/dashboard), projeto **Rastrear**:

1. **Authentication → URL Configuration → Site URL**: coloque a URL do GitHub
   Pages (ex.: `https://seu-usuario.github.io/Catalogo/`). Isso faz os links de
   confirmação de e-mail e recuperação de senha voltarem para o app.
2. *(Opcional)* **Authentication → Sign In / Up → Leaked password protection**:
   ative para bloquear senhas vazadas conhecidas.

## Onde os dados ficam

| O quê | Onde |
|---|---|
| Materiais e equipe | Projeto Supabase **Rastrear** (`hiukokgrsbvmpimtvbwg`), tabelas `cat_materiais` e `cat_perfis` |
| Fotos | Bucket `fotos-materiais` do mesmo projeto |
| Cópia offline | `localStorage` do navegador (somente leitura) |

O catálogo convive com as tabelas do app Rastrear no mesmo projeto (o plano
gratuito permite 2 projetos ativos e ambos já estavam em uso). Tudo do catálogo
usa o prefixo `cat_` — nada do outro app foi alterado. A segurança é feita por
RLS: só usuários **aprovados** leem/gravam materiais; só **admins** gerenciam a
equipe.

**Backups**: além de o Supabase guardar os dados, exporte de vez em quando um
CSV/JSON na aba **⇅ Dados**.

## Formato do CSV de importação

Cabeçalho reconhecido (a ordem não importa; use `;` ou `,` como separador):

```
codigo_sap;descricao;fabricante;categoria;unidade;referencias;aplicacao;localizacao;observacoes
```

As referências vão em uma única coluna, separadas por `;` dentro de aspas —
exemplo pronto em [`exemplos/materiais_exemplo.csv`](exemplos/materiais_exemplo.csv).
Materiais com o mesmo código SAP são atualizados (referências somadas); os
demais são adicionados.

## Raspador do Catálogo Expresso (Original Filter)

O script [`scraper/scrape_catalogoexpresso.py`](scraper/scrape_catalogoexpresso.py)
baixa do site catalogoexpresso.com.br os filtros por montadora/modelo com as
**referências cruzadas** e gera um CSV já no formato de importação do sistema.

> **Nota:** o ambiente onde este projeto foi gerado bloqueia o acesso a esse
> site (política de rede), então o script foi escrito a partir da estrutura
> pública de URLs da plataforma e precisa ser rodado **no seu computador**.
> Se algo não bater, rode o modo `inspect` e me mande a saída que eu ajusto.

```bash
cd scraper
pip install -r requirements.txt

# explorar a estrutura do site (formulários e filtros disponíveis)
python3 scrape_catalogoexpresso.py inspect

# listar os produtos de uma montadora
python3 scrape_catalogoexpresso.py buscar --fabricante VOLKSWAGEN

# referências cruzadas de um produto específico
python3 scrape_catalogoexpresso.py produto --id 1118

# gerar o CSV completo e importar na aba “⇅ Dados” do sistema
python3 scrape_catalogoexpresso.py tudo --fabricante VOLKSWAGEN --csv filtros_vw.csv
```

O script espera 1,5 s entre requisições (`--delay` para ajustar) — mantenha um
ritmo educado e confira os termos de uso do site antes de raspagens em massa.

## Estrutura do repositório

```
index.html                          ← telas (login, app, scanner, etiquetas)
css/estilo.css                      ← visual (claro/escuro) + layout de impressão
js/app.js                           ← lógica do aplicativo
js/config.js                        ← URL e chave pública do Supabase
js/vendor/supabase.js               ← cliente Supabase (local, sem CDN)
js/vendor/html5-qrcode.min.js       ← leitor de código de barras (fallback)
js/vendor/qrcode.js                 ← gerador de QR para as etiquetas
exemplos/materiais_exemplo.csv      ← modelo de planilha para importação
scraper/scrape_catalogoexpresso.py  ← raspador do Catálogo Expresso
```

As chaves em `js/config.js` são **públicas por design** (chave *publishable* do
Supabase) — a segurança vem das regras RLS no banco, não do sigilo da chave.

## Ideias para o futuro

- Controle de estoque (quantidade em prateleira, mínimo, alertas).
- Histórico de quem alterou o quê.
- Solicitações de compra direto pelo app.
- Importadores para outros catálogos online que a equipe usa.
