#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Raspador do catálogo "Original Filter" hospedado em catalogoexpresso.com.br.

A plataforma Catálogo Expresso (usada por Original Filter, VDO, ATE etc.)
aceita parâmetros de URL neste formato:

    resultado.php?cw_filtros=CHAVE<!2!>VALOR<!1!>CHAVE2<!2!>VALOR2&cw_ie_tp=1
    detalhes.php?cw_produtoAtivo=CodigoProduto<!2!>1118&retornaJSON=true

  * "<!1!>" separa pares de filtro; "<!2!>" separa chave de valor
  * "retornaJSON=true" pede a resposta em JSON em vez de HTML
  * "cw_pgAtual=N" pagina os resultados
  * Chaves conhecidas: FABRICANTEAPLICACAO (montadora), codFABRICANTEAPLICACAO,
    GRUPOPRODUTO, codGRUPOPRODUTO, FlagPontaEstoque

Comandos:

    python3 scrape_catalogoexpresso.py inspect
        Baixa a página inicial de busca e lista formulários, campos e selects
        encontrados — use para descobrir os nomes exatos dos filtros de
        modelo/montadora caso o site mude.

    python3 scrape_catalogoexpresso.py buscar --fabricante VOLKSWAGEN
        Lista os produtos de uma montadora (ou use --filtro CHAVE=VALOR).

    python3 scrape_catalogoexpresso.py produto --id 1118
        Mostra os detalhes de um produto: aplicações e referências cruzadas.

    python3 scrape_catalogoexpresso.py tudo --fabricante VOLKSWAGEN --csv vw.csv
        Busca + detalhes de cada produto e gera um CSV pronto para importar
        no app (index.html deste repositório).

Boas práticas:
  * Mantenha o --delay em pelo menos 1 segundo entre requisições.
  * Verifique os termos de uso do site antes de raspagens em massa.
  * Use --debug-dir para salvar as respostas cruas e ajustar o parser
    se a estrutura do site for diferente do esperado.

Dependências:  pip install requests beautifulsoup4
"""

import argparse
import csv
import json
import re
import sys
import time
from datetime import date
from urllib.parse import parse_qs, unquote, urljoin, urlparse

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Instale as dependências primeiro:  pip install requests beautifulsoup4")

SEP_PAR = "<!1!>"   # separa pares de filtro
SEP_KV = "<!2!>"    # separa chave de valor
BASE_PADRAO = "https://catalogoexpresso.com.br/original-filter/"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def montar_filtros(pares):
    """[('FABRICANTEAPLICACAO', 'VOLKSWAGEN')] -> 'FABRICANTEAPLICACAO<!2!>VOLKSWAGEN'"""
    return SEP_PAR.join(f"{k}{SEP_KV}{v}" for k, v in pares)


class Catalogo:
    def __init__(self, base=BASE_PADRAO, delay=1.5, debug_dir=None, verbose=False):
        self.base = base if base.endswith("/") else base + "/"
        self.delay = max(delay, 0.5)
        self.debug_dir = debug_dir
        self.verbose = verbose
        self._n_req = 0
        self.sessao = requests.Session()
        self.sessao.headers.update({"User-Agent": UA,
                                    "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
                                    "Accept-Language": "pt-BR,pt;q=0.9"})

    def get(self, pagina, params=None, tentativas=3):
        url = urljoin(self.base, pagina)
        for i in range(tentativas):
            if self._n_req:
                time.sleep(self.delay)
            self._n_req += 1
            try:
                resp = self.sessao.get(url, params=params, timeout=30)
                if self.verbose:
                    print(f"  [{resp.status_code}] {resp.url}", file=sys.stderr)
                self._salvar_debug(resp)
                if resp.status_code == 200:
                    return resp
                if resp.status_code in (429, 500, 502, 503):
                    time.sleep(2 ** (i + 1))
                    continue
                resp.raise_for_status()
            except requests.RequestException as e:
                if i == tentativas - 1:
                    raise
                print(f"  tentativa {i + 1} falhou ({e}); repetindo…", file=sys.stderr)
                time.sleep(2 ** (i + 1))
        raise RuntimeError(f"Não foi possível baixar {url}")

    def _salvar_debug(self, resp):
        if not self.debug_dir:
            return
        import os
        os.makedirs(self.debug_dir, exist_ok=True)
        nome = re.sub(r"[^A-Za-z0-9._-]+", "_", resp.url.split("://", 1)[-1])[:150]
        with open(os.path.join(self.debug_dir, f"{self._n_req:03d}_{nome}.txt"),
                  "w", encoding="utf-8") as f:
            f.write(resp.text)

    # ---------- interpretação das respostas ----------

    @staticmethod
    def _como_json(resp):
        try:
            return resp.json()
        except ValueError:
            return None

    @staticmethod
    def _soup(resp):
        return BeautifulSoup(resp.text, "html.parser")


# ---------------------------------------------------------------- utilidades

def achar_listas_de_dicts(obj, caminho=""):
    """Percorre um JSON arbitrário e devolve [(caminho, lista_de_dicts)]."""
    achados = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            achados += achar_listas_de_dicts(v, f"{caminho}.{k}" if caminho else k)
    elif isinstance(obj, list):
        if obj and all(isinstance(x, dict) for x in obj):
            achados.append((caminho, obj))
        for i, v in enumerate(obj[:3]):
            achados += achar_listas_de_dicts(v, f"{caminho}[{i}]")
    return achados


def valor_por_chave(d, *pedacos):
    """Primeiro valor cuja chave contenha todos os pedaços (sem acento/caixa)."""
    def normalizar(s):
        import unicodedata
        s = unicodedata.normalize("NFD", str(s))
        return "".join(c for c in s if not unicodedata.combining(c)).lower()
    for k, v in d.items():
        kn = normalizar(k)
        if all(normalizar(p) in kn for p in pedacos):
            if v not in (None, ""):
                return str(v).strip()
    return ""


def extrair_produtos_de_json(dados):
    """Procura no JSON listas que pareçam produtos (têm CodigoProduto ou similar)."""
    produtos = []
    for caminho, lista in achar_listas_de_dicts(dados):
        for item in lista:
            codigo = valor_por_chave(item, "codigo", "produto") or valor_por_chave(item, "codigoproduto")
            if not codigo:
                continue
            produtos.append({
                "id": codigo,
                "nome": (valor_por_chave(item, "descricao") or valor_por_chave(item, "nome")
                         or valor_por_chave(item, "produto")),
                "_origem_json": caminho,
                "_bruto": item,
            })
    return produtos


def extrair_produtos_de_html(soup):
    """Fallback: coleta links para detalhes.php e extrai o id do produto."""
    produtos, vistos = [], set()
    for a in soup.select('a[href*="detalhes.php"]'):
        href = a.get("href", "")
        qs = parse_qs(urlparse(href).query)
        ativo = unquote(qs.get("cw_produtoAtivo", [""])[0])
        m = re.search(r"CodigoProduto" + re.escape(SEP_KV) + r"(\w+)", ativo)
        if not m:
            continue
        pid = m.group(1)
        if pid in vistos:
            continue
        vistos.add(pid)
        nome = " ".join(a.get_text(" ", strip=True).split())
        produtos.append({"id": pid, "nome": nome, "href": urljoin("detalhes.php", href)})
    return produtos


def classificar_tabelas_html(soup):
    """Separa tabelas de aplicações (montadora/modelo) e de referências (marca/código)."""
    aplicacoes, referencias = [], []
    for tabela in soup.find_all("table"):
        linhas = tabela.find_all("tr")
        if not linhas:
            continue
        cab = [c.get_text(" ", strip=True).lower() for c in linhas[0].find_all(["th", "td"])]
        cab_txt = " ".join(cab)
        corpo = [[c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]
                 for tr in linhas[1:]]
        corpo = [l for l in corpo if any(l)]
        if any(p in cab_txt for p in ("montadora", "fabricante", "modelo", "veículo", "veiculo", "aplica")):
            aplicacoes += [" ".join(x for x in l if x) for l in corpo]
        elif any(p in cab_txt for p in ("marca", "referência", "referencia", "equival", "cross")):
            referencias += [" ".join(x for x in l if x) for l in corpo]
    return aplicacoes, referencias


# ---------------------------------------------------------------- comandos

def cmd_inspect(cat, args):
    """Mostra a estrutura da página para ajudar a descobrir nomes de filtros."""
    alvo = args.url or "resultado.php"
    resp = cat.get(alvo, params={"cw_ie_tp": "1"})
    dados = cat._como_json(resp)
    if dados is not None:
        print("A resposta já veio em JSON. Chaves de nível superior:")
        print(json.dumps(list(dados.keys()) if isinstance(dados, dict) else type(dados).__name__,
                         ensure_ascii=False, indent=2))
        for caminho, lista in achar_listas_de_dicts(dados):
            exemplo = list(lista[0].keys()) if lista else []
            print(f"  lista '{caminho}' com {len(lista)} itens; chaves: {exemplo}")
        return

    soup = cat._soup(resp)
    print(f"Título da página: {soup.title.get_text(strip=True) if soup.title else '(sem título)'}\n")

    for i, form in enumerate(soup.find_all("form"), 1):
        print(f"Formulário {i}: action={form.get('action')!r} method={form.get('method')!r}")
        for inp in form.find_all(["input", "select", "textarea"]):
            nome = inp.get("name") or inp.get("id") or "(sem nome)"
            if inp.name == "select":
                ops = [o.get_text(strip=True) for o in inp.find_all("option")][:15]
                print(f"   select {nome}: {ops}{' …' if len(inp.find_all('option')) > 15 else ''}")
            else:
                print(f"   {inp.name} {nome} (type={inp.get('type', '-')})")
        print()

    selects_soltos = [s for s in soup.find_all("select") if not s.find_parent("form")]
    for s in selects_soltos:
        ops = [o.get_text(strip=True) for o in s.find_all("option")][:15]
        print(f"Select fora de formulário {s.get('name') or s.get('id')}: {ops}")

    print("\nTentando a mesma página com retornaJSON=true…")
    resp2 = cat.get(alvo, params={"cw_ie_tp": "1", "retornaJSON": "true"})
    dados2 = cat._como_json(resp2)
    if dados2 is None:
        print("  (não retornou JSON)")
    else:
        for caminho, lista in achar_listas_de_dicts(dados2):
            exemplo = list(lista[0].keys()) if lista else []
            print(f"  lista '{caminho}' com {len(lista)} itens; chaves: {exemplo}")


def _buscar_produtos(cat, args):
    pares = []
    if args.fabricante:
        pares.append(("FABRICANTEAPLICACAO", args.fabricante.upper()))
    for f in args.filtro or []:
        if "=" not in f:
            sys.exit(f"--filtro espera CHAVE=VALOR (recebi {f!r})")
        k, v = f.split("=", 1)
        pares.append((k, v))
    if not pares:
        sys.exit("Informe --fabricante e/ou --filtro CHAVE=VALOR.")

    todos, pagina = {}, 1
    while pagina <= args.paginas:
        params = {"cw_filtros": montar_filtros(pares), "cw_ie_tp": "1",
                  "retornaJSON": "true"}
        if pagina > 1:
            params["cw_pgAtual"] = str(pagina)
        resp = cat.get("resultado.php", params=params)

        dados = cat._como_json(resp)
        achados = (extrair_produtos_de_json(dados) if dados is not None
                   else extrair_produtos_de_html(cat._soup(resp)))

        novos = [p for p in achados if p["id"] not in todos]
        for p in novos:
            todos[p["id"]] = p
        print(f"página {pagina}: {len(achados)} produtos ({len(novos)} novos, total {len(todos)})",
              file=sys.stderr)
        if not novos:
            break
        pagina += 1
    return list(todos.values())


def cmd_buscar(cat, args):
    produtos = _buscar_produtos(cat, args)
    if not produtos:
        print("Nenhum produto encontrado. Rode o modo 'inspect' para conferir os "
              "nomes dos filtros, ou tente --debug-dir para ver a resposta crua.")
        return
    for p in produtos:
        print(f"{p['id']:>8}  {p.get('nome', '')}")
    print(f"\n{len(produtos)} produtos.", file=sys.stderr)


def detalhes_produto(cat, produto_id):
    params = {"cw_produtoAtivo": f"CodigoProduto{SEP_KV}{produto_id}",
              "retornaJSON": "true"}
    resp = cat.get("detalhes.php", params=params)

    det = {"id": produto_id, "codigo": "", "nome": "", "aplicacoes": [], "referencias": []}
    dados = cat._como_json(resp)
    if dados is not None:
        for caminho, lista in achar_listas_de_dicts(dados):
            for item in lista:
                marca = valor_por_chave(item, "marca")
                ref = (valor_por_chave(item, "referencia") or valor_por_chave(item, "codigo", "ref"))
                montadora = (valor_por_chave(item, "montadora")
                             or valor_por_chave(item, "fabricante", "aplic"))
                modelo = valor_por_chave(item, "modelo")
                if ref and marca:
                    det["referencias"].append(f"{marca} {ref}".strip())
                elif montadora or modelo:
                    ano = valor_por_chave(item, "ano")
                    det["aplicacoes"].append(" ".join(x for x in (montadora, modelo, ano) if x))
                if not det["codigo"]:
                    det["codigo"] = valor_por_chave(item, "codigo", "produto")
                if not det["nome"]:
                    det["nome"] = valor_por_chave(item, "descricao") or valor_por_chave(item, "nome")
    else:
        soup = cat._soup(resp)
        det["nome"] = soup.title.get_text(strip=True) if soup.title else ""
        det["aplicacoes"], det["referencias"] = classificar_tabelas_html(soup)

    det["aplicacoes"] = sorted(set(a for a in det["aplicacoes"] if a))
    det["referencias"] = sorted(set(r for r in det["referencias"] if r))
    return det


def cmd_produto(cat, args):
    det = detalhes_produto(cat, args.id)
    print(json.dumps(det, ensure_ascii=False, indent=2))


def cmd_tudo(cat, args):
    produtos = _buscar_produtos(cat, args)
    if not produtos:
        sys.exit("Nenhum produto encontrado — nada para gerar.")

    linhas = []
    for i, p in enumerate(produtos, 1):
        print(f"[{i}/{len(produtos)}] detalhes do produto {p['id']}…", file=sys.stderr)
        try:
            det = detalhes_produto(cat, p["id"])
        except Exception as e:
            print(f"  falhou: {e}", file=sys.stderr)
            continue
        codigo_of = det["codigo"] or p.get("nome", "") or p["id"]
        refs = [f"ORIGINAL FILTER {codigo_of}"] + det["referencias"]
        linhas.append({
            "codigo_sap": "",  # preencha com o código interno da usina
            "descricao": det["nome"] or f"FILTRO ORIGINAL FILTER {codigo_of}",
            "fabricante": "ORIGINAL FILTER",
            "categoria": "Filtro",
            "unidade": "UN",
            "referencias": "; ".join(dict.fromkeys(refs)),
            "aplicacao": "; ".join(det["aplicacoes"]),
            "localizacao": "",
            "observacoes": f"Importado de catalogoexpresso.com.br em {date.today():%d/%m/%Y}",
        })

    destino = args.csv or f"original-filter-{date.today():%Y-%m-%d}.csv"
    with open(destino, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(linhas[0].keys()), delimiter=";")
        w.writeheader()
        w.writerows(linhas)
    print(f"\n{len(linhas)} produtos gravados em {destino} — importe este arquivo "
          f"na aba “Importar / Exportar” do app.")


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=BASE_PADRAO, help="URL base do catálogo")
    ap.add_argument("--delay", type=float, default=1.5,
                    help="pausa em segundos entre requisições (padrão: 1.5)")
    ap.add_argument("--debug-dir", help="pasta para salvar as respostas cruas")
    ap.add_argument("-v", "--verbose", action="store_true", help="mostra cada requisição")
    sub = ap.add_subparsers(dest="comando", required=True)

    p = sub.add_parser("inspect", help="explora a estrutura da página")
    p.add_argument("--url", help="página a inspecionar (padrão: resultado.php)")
    p.set_defaults(func=cmd_inspect)

    def args_busca(p):
        p.add_argument("--fabricante", help="montadora, ex.: VOLKSWAGEN")
        p.add_argument("--filtro", action="append", metavar="CHAVE=VALOR",
                       help="filtro adicional (pode repetir), ex.: GRUPOPRODUTO=Blindado")
        p.add_argument("--paginas", type=int, default=50, help="máximo de páginas (padrão: 50)")

    p = sub.add_parser("buscar", help="lista produtos de uma busca")
    args_busca(p)
    p.set_defaults(func=cmd_buscar)

    p = sub.add_parser("produto", help="detalhes + referências cruzadas de um produto")
    p.add_argument("--id", required=True, help="CodigoProduto interno, ex.: 1118")
    p.set_defaults(func=cmd_produto)

    p = sub.add_parser("tudo", help="busca + detalhes de cada produto e gera CSV")
    args_busca(p)
    p.add_argument("--csv", help="arquivo de saída (padrão: original-filter-DATA.csv)")
    p.set_defaults(func=cmd_tudo)

    args = ap.parse_args()
    cat = Catalogo(base=args.base, delay=args.delay,
                   debug_dir=args.debug_dir, verbose=args.verbose)
    args.func(cat, args)


if __name__ == "__main__":
    main()
