# Catálogo de Materiais — Códigos SAP e Referências Cruzadas

Sistema para concentrar em um só lugar os códigos SAP internos, referências de
fabricantes e localizações de materiais que hoje estão espalhados em cadernos,
grupos de WhatsApp e catálogos físicos/online.

## Como usar o sistema

Todo o sistema está em um único arquivo: **`index.html`**. Não precisa
instalar nada — funciona offline, no PC e no celular.

**Opção 1 — abrir direto no computador**
1. Baixe o arquivo `index.html` (botão *Code → Download ZIP* aqui no GitHub).
2. Dê dois cliques no arquivo — ele abre no navegador e já está funcionando.

**Opção 2 — publicar no GitHub Pages (recomendado para usar no celular)**
1. Neste repositório, vá em *Settings → Pages*.
2. Em *Source*, escolha *Deploy from a branch*, selecione a branch principal e a pasta `/ (root)`.
3. Em ~1 minuto o sistema fica disponível em `https://SEU-USUARIO.github.io/Catalogo/` —
   salve o endereço na tela inicial do celular e use como um aplicativo.

### O que dá para fazer

- **Cadastrar** materiais com: código SAP, descrição, fabricante, categoria,
  unidade, **referências/códigos equivalentes** (quantos quiser), aplicação/
  equipamento, localização no almoxarifado e observações.
- **Buscar** por qualquer coisa: código SAP, referência de fabricante,
  descrição, equipamento… A busca ignora acentos e pontuação — pesquisar
  `W9507` encontra a referência `W950/7`.
- **Copiar o código SAP** com um clique para colar direto no SAP.
- **Importar CSV** vindo do Excel/Google Planilhas ou do raspador (abaixo).
  Materiais com o mesmo código SAP são atualizados e as referências são somadas.
- **Exportar CSV** (abre no Excel) e **backup JSON** completo.

### ⚠️ Importante: onde os dados ficam

Os dados ficam salvos **no navegador do aparelho em que você cadastrou**
(localStorage). Isso significa:

- Não precisa de internet nem de servidor — mas cada aparelho tem sua própria base.
- **Exporte um backup JSON com frequência** (aba *Importar / Exportar*).
- Para passar os dados para outro aparelho ou colega, exporte o JSON/CSV e
  importe lá. Se no futuro vocês quiserem uma base única compartilhada pela
  equipe, dá para evoluir o sistema para um banco de dados central.

### Formato do CSV de importação

Cabeçalho reconhecido (a ordem não importa; use `;` ou `,` como separador):

```
codigo_sap;descricao;fabricante;categoria;unidade;referencias;aplicacao;localizacao;observacoes
```

As referências vão em uma única coluna, separadas por `;` dentro de aspas —
veja o exemplo pronto em [`exemplos/materiais_exemplo.csv`](exemplos/materiais_exemplo.csv).

## Raspador do Catálogo Expresso (Original Filter)

O script [`scraper/scrape_catalogoexpresso.py`](scraper/scrape_catalogoexpresso.py)
baixa do site catalogoexpresso.com.br os filtros por montadora/modelo com as
**referências cruzadas**, e gera um CSV já no formato de importação do sistema.

> **Nota:** o ambiente onde este projeto foi gerado bloqueia acesso a esse
> site (política de rede), então o script foi escrito a partir da estrutura
> pública de URLs da plataforma, mas precisa ser rodado **no seu computador**.
> Se algo não bater, rode o modo `inspect` (abaixo) e me mande a saída que eu ajusto.

### Como rodar (no seu PC, com Python 3 instalado)

```bash
cd scraper
pip install -r requirements.txt

# 1) Explorar a estrutura do site (formulários, filtros disponíveis)
python3 scrape_catalogoexpresso.py inspect

# 2) Listar os produtos de uma montadora
python3 scrape_catalogoexpresso.py buscar --fabricante VOLKSWAGEN

# 3) Ver as referências cruzadas de um produto específico
python3 scrape_catalogoexpresso.py produto --id 1118

# 4) Gerar o CSV completo (busca + detalhes de cada produto)
python3 scrape_catalogoexpresso.py tudo --fabricante VOLKSWAGEN --csv filtros_vw.csv
```

Depois é só importar o CSV gerado na aba **⇅ Importar / Exportar** do sistema
e preencher os códigos SAP internos de cada item.

O script espera 1,5 s entre requisições por padrão (`--delay` para ajustar) —
mantenha um ritmo educado e confira os termos de uso do site antes de
raspagens em massa.

## Estrutura do repositório

```
index.html                        ← o sistema completo (abra no navegador)
exemplos/materiais_exemplo.csv    ← modelo de planilha para importação
scraper/scrape_catalogoexpresso.py← raspador do Catálogo Expresso
scraper/requirements.txt          ← dependências do raspador
```

## Ideias para o futuro

- Base compartilhada entre vários usuários (banco de dados central).
- Fotos dos materiais.
- Leitura de código de barras/QR na etiqueta da prateleira.
- Importadores para outros catálogos online que a equipe usa.
