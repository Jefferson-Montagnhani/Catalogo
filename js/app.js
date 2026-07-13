'use strict';
/* ============================================================
   Catálogo de Materiais — base compartilhada (Supabase)
   Auth com aprovação de equipe · fotos · scanner · etiquetas QR
   ============================================================ */

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const CACHE_KEY = 'catalogoCache.v2';
const LEGADO_KEY = 'catalogoMateriais.v1';   // dados da versão antiga (local)
const PAGINA = 120;
const MAX_FOTOS = 4;
const BUCKET_FOTOS = 'fotos-materiais';

let sessao = null;
let perfil = null;              // linha de cat_perfis do usuário logado
let usuarioCarregado = null;    // id do usuário já inicializado (evita recarga em refresh de token)
let materiais = [];
let offline = false;
let ultimaBusca = 0;
let editId = null;
let fotosForm = [];             // URLs das fotos do material em edição
let fotosOriginais = [];        // fotos antes da edição (para apagar removidas)
let limiteRender = PAGINA;
let modoLogin = 'entrar';       // 'entrar' | 'criar' | 'novaSenha'
let canal = null;

const $ = id => document.getElementById(id);

/* ============================================================
   utilidades
   ============================================================ */
const norm  = s => (s ?? '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const alnum = s => norm(s).replace(/[^a-z0-9]/g, '');
const esc = s => (s ?? '').toString()
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const hoje = () => new Date().toISOString().slice(0, 10);

let toastTimer = null;
function toast(msg, erro){
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('erro', !!erro);
  el.classList.add('mostrar');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('mostrar'), erro ? 5500 : 2800);
}

function baixar(conteudo, nome, tipo){
  const blob = new Blob([conteudo], { type: tipo });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

const scriptsCarregados = {};
function carregarScript(src){
  if(!scriptsCarregados[src]){
    scriptsCarregados[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => { delete scriptsCarregados[src]; rej(new Error('Falha ao carregar ' + src)); };
      document.head.appendChild(s);
    });
  }
  return scriptsCarregados[src];
}

/* ============================================================
   telas
   ============================================================ */
function mostrarTela(nome){
  for(const t of document.querySelectorAll('.tela'))
    t.classList.toggle('ativa', t.id === 'tela-' + nome);
}

function abrirTab(nome){
  document.querySelectorAll('nav.tabs button').forEach(b =>
    b.classList.toggle('ativa', b.dataset.tab === nome));
  document.querySelectorAll('section.painel').forEach(s =>
    s.classList.toggle('ativa', s.id === 'tab-' + nome));
  if(nome === 'buscar') $('busca').focus();
  if(nome === 'equipe') carregarEquipe();
}

/* ============================================================
   autenticação
   ============================================================ */
function msgLogin(texto, erro){
  const el = $('login-msg');
  el.textContent = texto || '';
  el.className = 'login-msg ' + (erro ? 'erro' : 'ok');
}

function aplicarModoLogin(){
  $('grupo-nome').hidden = modoLogin !== 'criar';
  $('grupo-senha').hidden = false;
  $('grupo-senha2').hidden = modoLogin !== 'novaSenha';
  $('l-senha').autocomplete = modoLogin === 'entrar' ? 'current-password' : 'new-password';
  $('btn-login').textContent =
    modoLogin === 'criar' ? 'Criar conta' :
    modoLogin === 'novaSenha' ? 'Salvar nova senha' : 'Entrar';
  $('link-alternar').textContent = modoLogin === 'criar' ? 'Já tenho conta' : 'Criar conta';
  $('link-alternar').style.display = modoLogin === 'novaSenha' ? 'none' : '';
  $('link-esqueci').style.display = modoLogin === 'entrar' ? '' : 'none';
}

function traduzErroAuth(e){
  const m = (e && e.message || '').toLowerCase();
  if(m.includes('invalid login credentials')) return 'E-mail ou senha incorretos.';
  if(m.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar (veja sua caixa de entrada).';
  if(m.includes('user already registered')) return 'Este e-mail já tem conta — use “Entrar”.';
  if(m.includes('password should be at least')) return 'A senha precisa ter pelo menos 6 caracteres.';
  if(m.includes('rate limit') || m.includes('security purposes')) return 'Muitas tentativas — aguarde um minuto e tente de novo.';
  if(m.includes('failed to fetch') || m.includes('network')) return 'Sem conexão com a internet.';
  return (e && e.message) || 'Erro inesperado.';
}

async function enviarLogin(ev){
  ev.preventDefault();
  const email = $('l-email').value.trim();
  const senha = $('l-senha').value;
  const btn = $('btn-login');
  btn.disabled = true;
  msgLogin('');
  try{
    if(modoLogin === 'entrar'){
      const { error } = await sb.auth.signInWithPassword({ email, password: senha });
      if(error) throw error;
      // onAuthStateChange cuida do resto
    }else if(modoLogin === 'criar'){
      const nome = $('l-nome').value.trim();
      const { data, error } = await sb.auth.signUp({
        email, password: senha,
        options: { data: { nome }, emailRedirectTo: location.origin + location.pathname },
      });
      if(error) throw error;
      if(!data.session){
        msgLogin('Conta criada! Enviamos um link de confirmação para o seu e-mail — clique nele e depois volte aqui para entrar.');
      }
    }else if(modoLogin === 'novaSenha'){
      if(senha !== $('l-senha2').value){ msgLogin('As senhas não conferem.', true); return; }
      const { error } = await sb.auth.updateUser({ password: senha });
      if(error) throw error;
      toast('Senha alterada ✔');
      modoLogin = 'entrar';
      aplicarModoLogin();
      const { data: { session } } = await sb.auth.getSession();
      if(session) await iniciarSessao(session);
    }
  }catch(e){
    msgLogin(traduzErroAuth(e), true);
  }finally{
    btn.disabled = false;
  }
}

async function esqueciSenha(){
  const email = $('l-email').value.trim();
  if(!email){ msgLogin('Digite seu e-mail no campo acima e clique de novo em “Esqueci minha senha”.', true); return; }
  try{
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname,
    });
    if(error) throw error;
    msgLogin('Enviamos um link de recuperação para ' + email + '. Abra-o neste mesmo aparelho.');
  }catch(e){
    msgLogin(traduzErroAuth(e), true);
  }
}

async function sair(){
  try{ await sb.auth.signOut(); }catch(e){ /* segue mesmo com erro */ }
  usuarioCarregado = null;
  perfil = null;
  materiais = [];
  if(canal){ sb.removeChannel(canal); canal = null; }
  mostrarTela('login');
}

/* fluxo pós-login: perfil -> aprovação -> app */
async function iniciarSessao(s){
  sessao = s;
  if(!s){ mostrarTela('login'); return; }
  if(usuarioCarregado === s.user.id) return;      // só refresh de token

  const { data, error } = await sb.from('cat_perfis').select('*').eq('id', s.user.id).maybeSingle();
  if(error){
    mostrarTela('login');
    msgLogin('Erro ao carregar seu perfil: ' + traduzErroAuth(error), true);
    return;
  }
  perfil = data;
  if(!perfil || !perfil.aprovado){
    mostrarTela('pendente');
    return;
  }

  usuarioCarregado = s.user.id;
  $('usuario-nome').textContent =
    (perfil.nome || perfil.email) + (perfil.admin ? ' · admin' : '');
  $('tab-btn-equipe').hidden = !perfil.admin;
  mostrarTela('app');
  abrirTab('buscar');
  await carregarMateriais();
  assinarTempoReal();
  if(perfil.admin) atualizarBadgePendentes();
  oferecerMigracaoLocal();
}

/* ============================================================
   dados: carregar / cache / tempo real
   ============================================================ */
async function buscarTodosMateriais(){
  const todos = [];
  for(let de = 0;; de += 1000){
    const { data, error } = await sb.from('cat_materiais')
      .select('*').order('descricao').range(de, de + 999);
    if(error) throw error;
    todos.push(...data);
    if(data.length < 1000) break;
  }
  return todos;
}

async function carregarMateriais(silencioso){
  try{
    materiais = await buscarTodosMateriais();
    offline = false;
    ultimaBusca = Date.now();
    salvarCache();
  }catch(e){
    console.error('Falha ao buscar materiais:', e);
    if(!silencioso){
      const cache = lerCache();
      if(cache){ materiais = cache; }
      offline = true;
      toast('Sem conexão com a base — mostrando última cópia local.', true);
    }
  }
  $('banner-offline').hidden = !offline;
  preencherFiltros();
  renderResultados();
  atualizarRodape();
}

function salvarCache(){
  try{
    localStorage.setItem(CACHE_KEY, JSON.stringify({ quando: Date.now(), materiais }));
  }catch(e){ /* cache é melhor esforço */ }
}
function lerCache(){
  try{
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return c && Array.isArray(c.materiais) ? c.materiais : null;
  }catch(e){ return null; }
}

function assinarTempoReal(){
  if(canal) sb.removeChannel(canal);
  canal = sb.channel('cat-materiais')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cat_materiais' }, p => {
      if(p.eventType === 'DELETE'){
        materiais = materiais.filter(m => m.id !== p.old.id);
      }else{
        const i = materiais.findIndex(m => m.id === p.new.id);
        if(i >= 0) materiais[i] = p.new; else materiais.push(p.new);
      }
      salvarCache();
      preencherFiltros();
      renderResultados();
      atualizarRodape();
    })
    .subscribe();
}

/* recarrega ao voltar para a aba depois de um tempo longe */
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && usuarioCarregado &&
     Date.now() - ultimaBusca > 5 * 60 * 1000){
    carregarMateriais(true);
  }
});

/* ============================================================
   busca e renderização
   ============================================================ */
function blobDe(m){
  const campos = [m.sap, m.descricao, m.fabricante, m.categoria, m.unidade,
                  m.aplicacao, m.localizacao, m.obs, ...(m.referencias || [])];
  const texto = campos.map(norm).join(' ');
  const codigos = [m.sap, ...(m.referencias || [])].map(alnum).join(' ');
  return texto + ' ' + codigos;
}

function pontuacao(m, tokens){
  let p = 0;
  const sapA = alnum(m.sap);
  const refsA = (m.referencias || []).map(alnum);
  for(const t of tokens){
    const tA = alnum(t);
    if(!tA) continue;
    if(sapA && sapA === tA) p += 100;
    else if(refsA.includes(tA)) p += 50;
    else if(sapA && sapA.startsWith(tA)) p += 10;
    else if(refsA.some(r => r.startsWith(tA))) p += 5;
  }
  return p;
}

function filtrar(){
  const q = $('busca').value.trim();
  const cat = $('filtro-categoria').value;
  const fab = $('filtro-fabricante').value;
  const tokens = q ? q.split(/\s+/) : [];

  let lista = materiais.filter(m => {
    if(cat && norm(m.categoria) !== norm(cat)) return false;
    if(fab && norm(m.fabricante) !== norm(fab)) return false;
    if(!tokens.length) return true;
    const blob = blobDe(m);
    return tokens.every(t => blob.includes(norm(t)) || (alnum(t) && blob.includes(alnum(t))));
  });

  if(tokens.length){
    lista = lista
      .map(m => [pontuacao(m, tokens), m])
      .sort((a, b) => b[0] - a[0] || norm(a[1].descricao).localeCompare(norm(b[1].descricao)))
      .map(par => par[1]);
  }else{
    lista = lista.slice().sort((a, b) => norm(a.descricao).localeCompare(norm(b.descricao)));
  }
  return lista;
}

function cardHTML(m){
  const refs = (m.referencias || []).map(r => `<span class="chip">${esc(r)}</span>`).join('');
  const fotos = (m.fotos || []).map((u, i) =>
    `<img src="${esc(u)}" loading="lazy" alt="Foto" data-acao="foto" data-idx="${i}">`).join('');
  return `
  <div class="card" data-id="${esc(m.id)}">
    <div class="card-top">
      ${m.sap
        ? `<span class="sap">${esc(m.sap)}</span>
           <button class="copy" data-acao="copiar" title="Copiar código SAP">📋 copiar</button>`
        : `<span class="sap vazio">sem código SAP</span>`}
      ${m.categoria ? `<span class="badge">${esc(m.categoria)}</span>` : ''}
    </div>
    <div class="desc">${esc(m.descricao)}</div>
    ${(m.fabricante || m.unidade)
      ? `<div class="meta">${esc([m.fabricante, m.unidade && ('Unid: ' + m.unidade)].filter(Boolean).join(' · '))}</div>` : ''}
    ${fotos ? `<div class="fotos-card">${fotos}</div>` : ''}
    ${refs ? `<div class="refs">${refs}</div>` : ''}
    ${m.aplicacao ? `<div class="linha"><b>Aplicação:</b> ${esc(m.aplicacao)}</div>` : ''}
    ${m.localizacao ? `<div class="linha"><b>Local:</b> ${esc(m.localizacao)}</div>` : ''}
    ${m.obs ? `<div class="linha"><b>Obs:</b> ${esc(m.obs)}</div>` : ''}
    <div class="acoes">
      <button data-acao="editar" ${offline ? 'disabled' : ''}>✏️ Editar</button>
      <button data-acao="excluir" class="excluir" ${offline ? 'disabled' : ''}>🗑️ Excluir</button>
    </div>
  </div>`;
}

function renderResultados(){
  const lista = filtrar();
  const alvo = $('resultados');
  const contagem = $('contagem');
  const btnMais = $('btn-mais');

  if(!materiais.length){
    contagem.textContent = '';
    alvo.innerHTML = `<div class="vazio-msg" style="grid-column:1/-1">
      Nenhum material cadastrado ainda.<br>
      Use a aba <b>➕ Cadastrar</b> ou importe uma planilha em <b>⇅ Dados</b>.</div>`;
    btnMais.hidden = true;
    return;
  }

  contagem.textContent = lista.length === materiais.length
    ? `${lista.length} materiais`
    : `${lista.length} de ${materiais.length} materiais`;

  if(!lista.length){
    alvo.innerHTML = `<div class="vazio-msg" style="grid-column:1/-1">Nada encontrado. Tente parte do código ou outra palavra.</div>`;
    btnMais.hidden = true;
    return;
  }

  alvo.innerHTML = lista.slice(0, limiteRender).map(cardHTML).join('');
  btnMais.hidden = lista.length <= limiteRender;
}

function preencherFiltros(){
  const preencher = (id, valores, rotulo) => {
    const sel = $(id);
    const atual = sel.value;
    sel.innerHTML = `<option value="">${rotulo}</option>` +
      valores.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if(valores.some(v => v === atual)) sel.value = atual;
  };
  const unicos = campo => [...new Set(materiais.map(m => (m[campo] || '').trim()).filter(Boolean))]
    .sort((a, b) => norm(a).localeCompare(norm(b)));
  preencher('filtro-categoria', unicos('categoria'), 'Todas as categorias');
  preencher('filtro-fabricante', unicos('fabricante'), 'Todos os fabricantes');
}

function atualizarRodape(){
  const quem = perfil ? ` · ${perfil.email}${perfil.admin ? ' (admin)' : ''}` : '';
  $('rodape').textContent =
    `${materiais.length} materiais · base compartilhada${quem}` + (offline ? ' · OFFLINE' : '');
}

/* ============================================================
   formulário (criar / editar)
   ============================================================ */
function lerReferencias(texto){
  return [...new Set((texto || '').split(/[\n;]+/).map(s => s.trim()).filter(Boolean))];
}

function coletarForm(){
  return {
    sap:         $('f-sap').value.trim(),
    descricao:   $('f-descricao').value.trim(),
    fabricante:  $('f-fabricante').value.trim(),
    categoria:   $('f-categoria').value.trim(),
    unidade:     $('f-unidade').value.trim().toUpperCase(),
    referencias: lerReferencias($('f-referencias').value),
    aplicacao:   $('f-aplicacao').value.trim(),
    localizacao: $('f-localizacao').value.trim(),
    obs:         $('f-obs').value.trim(),
    fotos:       fotosForm.slice(),
  };
}

function limparForm(){
  $('form-material').reset();
  editId = null;
  fotosForm = [];
  fotosOriginais = [];
  renderFotosForm();
  $('btn-salvar').textContent = 'Salvar material';
  $('btn-cancelar').hidden = true;
}

function aplicarLocal(linha){
  const i = materiais.findIndex(m => m.id === linha.id);
  if(i >= 0) materiais[i] = linha; else materiais.push(linha);
  salvarCache();
  preencherFiltros();
  renderResultados();
  atualizarRodape();
}

async function salvarMaterial(ev){
  ev.preventDefault();
  if(offline){ toast('Sem conexão — não é possível salvar agora.', true); return; }
  const dados = coletarForm();
  if(!dados.descricao){ toast('Informe pelo menos a descrição.', true); return; }

  if(dados.sap){
    const dup = materiais.find(m => m.id !== editId && alnum(m.sap) && alnum(m.sap) === alnum(dados.sap));
    if(dup){
      toast(`Já existe material com o SAP ${dup.sap}: “${dup.descricao}”. Edite-o em vez de criar outro.`, true);
      return;
    }
  }

  const btn = $('btn-salvar');
  btn.disabled = true;
  try{
    let linha;
    if(editId){
      const { data, error } = await sb.from('cat_materiais')
        .update(dados).eq('id', editId).select().single();
      if(error) throw error;
      linha = data;
      // apaga do storage as fotos removidas na edição
      const removidas = fotosOriginais.filter(u => !dados.fotos.includes(u));
      if(removidas.length) removerFotosStorage(removidas);
      toast('Material atualizado ✔');
    }else{
      const { data, error } = await sb.from('cat_materiais')
        .insert(dados).select().single();
      if(error) throw error;
      linha = data;
      toast('Material cadastrado ✔');
    }
    aplicarLocal(linha);
    limparForm();
    $('f-sap').focus();
  }catch(e){
    if(e && e.code === '23505')
      toast('Já existe um material com este código SAP na base.', true);
    else
      toast('Erro ao salvar: ' + (e.message || e), true);
  }finally{
    btn.disabled = false;
  }
}

function editarMaterial(id){
  const m = materiais.find(x => x.id === id);
  if(!m) return;
  editId = id;
  $('f-sap').value = m.sap || '';
  $('f-descricao').value = m.descricao || '';
  $('f-fabricante').value = m.fabricante || '';
  $('f-categoria').value = m.categoria || '';
  $('f-unidade').value = m.unidade || '';
  $('f-referencias').value = (m.referencias || []).join('\n');
  $('f-aplicacao').value = m.aplicacao || '';
  $('f-localizacao').value = m.localizacao || '';
  $('f-obs').value = m.obs || '';
  fotosForm = (m.fotos || []).slice();
  fotosOriginais = fotosForm.slice();
  renderFotosForm();
  $('btn-salvar').textContent = 'Salvar alterações';
  $('btn-cancelar').hidden = false;
  abrirTab('cadastrar');
  $('f-descricao').focus();
}

async function excluirMaterial(id){
  const m = materiais.find(x => x.id === id);
  if(!m) return;
  if(!confirm(`Excluir “${m.descricao}”${m.sap ? ' (SAP ' + m.sap + ')' : ''} para toda a equipe?`)) return;
  try{
    const { error } = await sb.from('cat_materiais').delete().eq('id', id);
    if(error) throw error;
    if(m.fotos && m.fotos.length) removerFotosStorage(m.fotos);
    materiais = materiais.filter(x => x.id !== id);
    salvarCache();
    preencherFiltros();
    renderResultados();
    atualizarRodape();
    toast('Material excluído.');
  }catch(e){
    toast('Erro ao excluir: ' + (e.message || e), true);
  }
}

/* ============================================================
   fotos
   ============================================================ */
function caminhoDaFoto(url){
  const marca = '/' + BUCKET_FOTOS + '/';
  const i = url.indexOf(marca);
  return i >= 0 ? decodeURIComponent(url.slice(i + marca.length)) : null;
}

function removerFotosStorage(urls){
  const caminhos = urls.map(caminhoDaFoto).filter(Boolean);
  if(caminhos.length)
    sb.storage.from(BUCKET_FOTOS).remove(caminhos).catch(() => { /* melhor esforço */ });
}

function renderFotosForm(){
  const alvo = $('fotos-form');
  alvo.querySelectorAll('.foto-prev').forEach(el => el.remove());
  const btn = $('btn-add-foto');
  for(const [i, url] of fotosForm.entries()){
    const div = document.createElement('div');
    div.className = 'foto-prev';
    div.innerHTML = `<img src="${esc(url)}" alt="Foto ${i + 1}">
                     <button type="button" class="rm-foto" data-idx="${i}" title="Remover foto">✕</button>`;
    alvo.insertBefore(div, btn);
  }
  btn.style.display = fotosForm.length >= MAX_FOTOS ? 'none' : '';
}

function comprimirImagem(arquivo, maxLado = 1280, qualidade = 0.82){
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(arquivo);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * escala);
      c.height = Math.round(img.height * escala);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? res(b) : rej(new Error('Falha ao processar a imagem')), 'image/jpeg', qualidade);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Arquivo de imagem inválido')); };
    img.src = url;
  });
}

async function adicionarFoto(arquivo){
  if(fotosForm.length >= MAX_FOTOS){ toast(`Máximo de ${MAX_FOTOS} fotos por material.`, true); return; }
  if(offline){ toast('Sem conexão — não é possível enviar fotos agora.', true); return; }
  const btn = $('btn-add-foto');
  btn.disabled = true;
  btn.textContent = 'enviando…';
  try{
    const blob = await comprimirImagem(arquivo);
    const nome = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const { error } = await sb.storage.from(BUCKET_FOTOS)
      .upload(nome, blob, { contentType: 'image/jpeg' });
    if(error) throw error;
    const { data } = sb.storage.from(BUCKET_FOTOS).getPublicUrl(nome);
    fotosForm.push(data.publicUrl);
    renderFotosForm();
    toast('Foto adicionada ✔ (salve o material para gravar)');
  }catch(e){
    toast('Erro ao enviar foto: ' + (e.message || e), true);
  }finally{
    btn.disabled = false;
    btn.innerHTML = '📷<br>adicionar<br>foto';
  }
}

/* lightbox */
let lbFotos = [], lbIdx = 0;
function abrirLightbox(fotos, idx){
  lbFotos = fotos; lbIdx = idx;
  atualizarLightbox();
  $('lightbox').hidden = false;
}
function atualizarLightbox(){
  $('lb-img').src = lbFotos[lbIdx];
  $('lb-ant').style.display = lbFotos.length > 1 ? '' : 'none';
  $('lb-prox').style.display = lbFotos.length > 1 ? '' : 'none';
}

/* ============================================================
   scanner de código de barras / QR
   ============================================================ */
let scannerVideoStream = null;
let scannerIntervalo = null;
let scannerH5 = null;
let scannerAoLer = null;

/* o desligamento da câmera pode interromper um play() pendente dentro da
   biblioteca — é inofensivo, mas vira rejeição não tratada; silencia só isso */
window.addEventListener('unhandledrejection', ev => {
  const msg = (ev.reason && ev.reason.message) || '';
  if(msg.includes('play() request was interrupted')) ev.preventDefault();
});

async function abrirScanner(aoLer){
  scannerAoLer = aoLer;
  $('modal-scanner').hidden = false;
  $('scanner-status').textContent = 'Abrindo câmera…';
  $('scanner-video').hidden = true;
  $('leitor-h5').hidden = true;

  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    $('scanner-status').textContent =
      'Este navegador não dá acesso à câmera. Use HTTPS (GitHub Pages) e um navegador atualizado, ou digite o código manualmente.';
    return;
  }

  if('BarcodeDetector' in window){
    try{ await scannerNativo(); return; }
    catch(e){ console.warn('BarcodeDetector falhou, tentando fallback:', e); }
  }
  try{ await scannerFallback(); }
  catch(e){
    $('scanner-status').textContent =
      'Não foi possível acessar a câmera (' + (e.message || e) + '). Verifique a permissão da câmera e tente de novo, ou digite o código manualmente.';
  }
}

async function scannerNativo(){
  const suportados = await window.BarcodeDetector.getSupportedFormats();
  const desejados = ['qr_code','code_128','ean_13','ean_8','code_39','itf','upc_a','upc_e','data_matrix','codabar'];
  const detector = new window.BarcodeDetector({
    formats: desejados.filter(f => suportados.includes(f)),
  });
  scannerVideoStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' }, audio: false,
  });
  const video = $('scanner-video');
  video.srcObject = scannerVideoStream;
  video.hidden = false;
  await video.play();
  $('scanner-status').textContent = 'Aponte a câmera para o código de barras ou QR…';
  scannerIntervalo = setInterval(async () => {
    try{
      const codigos = await detector.detect(video);
      if(codigos.length) concluirLeitura(codigos[0].rawValue);
    }catch(e){ /* quadro ainda não pronto */ }
  }, 250);
}

async function scannerFallback(){
  await carregarScript('js/vendor/html5-qrcode.min.js');
  $('leitor-h5').hidden = false;
  const s = new window.Html5Qrcode('leitor-h5');
  scannerH5 = s;
  await s.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    texto => concluirLeitura(texto),
    () => { /* sem leitura neste quadro */ },
  );
  if(scannerH5 !== s){ pararH5(s); return; }   // modal foi fechado durante a inicialização
  $('scanner-status').textContent = 'Aponte a câmera para o código de barras ou QR…';
}

/* stop() da html5-qrcode lança erro síncrono se o scanner não estiver
   rodando — por isso todo o desligamento fica embrulhado aqui */
function pararH5(s){
  try{
    Promise.resolve(s.stop()).catch(() => {}).finally(() => { try{ s.clear(); }catch(e){} });
  }catch(e){
    try{ s.clear(); }catch(e2){}
  }
}

function concluirLeitura(texto){
  const acao = scannerAoLer;
  fecharScanner();
  if(navigator.vibrate) navigator.vibrate(80);
  toast('Código lido: ' + texto);
  if(acao) acao(texto);
}

function fecharScanner(){
  $('modal-scanner').hidden = true;
  scannerAoLer = null;
  if(scannerIntervalo){ clearInterval(scannerIntervalo); scannerIntervalo = null; }
  if(scannerVideoStream){
    scannerVideoStream.getTracks().forEach(t => t.stop());
    scannerVideoStream = null;
    $('scanner-video').srcObject = null;
  }
  if(scannerH5){
    const s = scannerH5; scannerH5 = null;
    // se ainda está iniciando (estado < 2), scannerFallback faz a limpeza ao terminar
    try{
      if(typeof s.getState !== 'function' || s.getState() >= 2) pararH5(s);
    }catch(e){}
  }
}

/* ============================================================
   etiquetas QR para prateleira
   ============================================================ */
async function imprimirEtiquetas(){
  const lista = filtrar();
  if(!lista.length){ toast('Nenhum material nos resultados para gerar etiquetas.', true); return; }
  if(lista.length > 300 && !confirm(`Gerar etiquetas de ${lista.length} materiais? A impressão pode ficar longa.`)) return;
  try{
    await carregarScript('js/vendor/qrcode.js');
  }catch(e){
    toast('Não foi possível carregar o gerador de QR: ' + e.message, true);
    return;
  }
  const area = $('area-impressao');
  area.innerHTML = lista.map(m => {
    const conteudo = m.sap || (m.referencias || [])[0] || m.descricao.slice(0, 40);
    const qr = window.qrcode(0, 'M');
    qr.addData(conteudo);
    qr.make();
    return `<div class="etiqueta">
      ${qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true })}
      <div class="et-info">
        <div class="et-sap">${esc(m.sap || '—')}</div>
        <div class="et-desc">${esc(m.descricao.slice(0, 64))}</div>
        ${m.localizacao ? `<div class="et-loc">${esc(m.localizacao)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
  document.body.classList.add('imprimindo');
  window.print();
}
window.addEventListener('afterprint', () => {
  document.body.classList.remove('imprimindo');
  $('area-impressao').innerHTML = '';
});

/* ============================================================
   equipe (admins)
   ============================================================ */
async function carregarEquipe(){
  if(!perfil || !perfil.admin) return;
  const alvo = $('lista-equipe');
  alvo.innerHTML = '<tr><td colspan="5">Carregando…</td></tr>';
  const { data, error } = await sb.from('cat_perfis').select('*').order('criado_em');
  if(error){
    alvo.innerHTML = `<tr><td colspan="5">Erro ao carregar: ${esc(error.message)}</td></tr>`;
    return;
  }
  alvo.innerHTML = data.map(p => {
    const eu = p.id === sessao.user.id;
    return `<tr data-id="${esc(p.id)}">
      <td>${esc(p.nome || '—')}${eu ? ' <small>(você)</small>' : ''}</td>
      <td>${esc(p.email)}</td>
      <td>${p.aprovado
            ? `<span class="aprovado">aprovado${p.admin ? ' · admin' : ''}</span>`
            : '<span class="pendente">pendente</span>'}</td>
      <td>${new Date(p.criado_em).toLocaleDateString('pt-BR')}</td>
      <td>
        <button data-eq="aprovar">${p.aprovado ? 'Revogar acesso' : '✔ Aprovar'}</button>
        ${p.aprovado ? `<button data-eq="admin">${p.admin ? 'Tirar admin' : 'Tornar admin'}</button>` : ''}
      </td>
    </tr>`;
  }).join('');
  atualizarBadgePendentes(data);
}

async function atualizarBadgePendentes(dados){
  if(!perfil || !perfil.admin) return;
  let pendentes;
  if(dados){
    pendentes = dados.filter(p => !p.aprovado).length;
  }else{
    const { count } = await sb.from('cat_perfis')
      .select('id', { count: 'exact', head: true }).eq('aprovado', false);
    pendentes = count || 0;
  }
  const badge = $('badge-pendentes');
  badge.hidden = !pendentes;
  badge.textContent = pendentes;
}

async function acaoEquipe(id, acao){
  const { data: alvo, error: e1 } = await sb.from('cat_perfis').select('*').eq('id', id).single();
  if(e1){ toast('Erro: ' + e1.message, true); return; }
  const eu = id === sessao.user.id;

  let mudanca;
  if(acao === 'aprovar'){
    if(alvo.aprovado && eu){ toast('Você não pode revogar o próprio acesso.', true); return; }
    if(alvo.aprovado && !confirm(`Revogar o acesso de ${alvo.email}?`)) return;
    mudanca = alvo.aprovado ? { aprovado: false, admin: false } : { aprovado: true };
  }else if(acao === 'admin'){
    if(alvo.admin && eu && !confirm('Tirar o SEU próprio acesso de administrador? Outra pessoa admin terá que devolvê-lo.')) return;
    mudanca = { admin: !alvo.admin };
  }else return;

  const { error } = await sb.from('cat_perfis').update(mudanca).eq('id', id);
  if(error){ toast('Erro: ' + error.message, true); return; }
  toast('Equipe atualizada ✔');
  if(eu && (mudanca.admin === false)){ perfil.admin = false; $('tab-btn-equipe').hidden = true; abrirTab('buscar'); }
  carregarEquipe();
}

/* ============================================================
   importação / exportação
   ============================================================ */
function detectarDelimitador(linha){
  const conta = c => (linha.match(new RegExp('\\' + c, 'g')) || []).length;
  const pv = conta(';'), vg = conta(','), tab = conta('\t');
  if(tab >= pv && tab >= vg) return '\t';
  return pv >= vg ? ';' : ',';
}

function parseCSV(texto){
  texto = texto.replace(/^\uFEFF/, '');
  const delim = detectarDelimitador(texto.split(/\r?\n/, 1)[0] || '');
  const linhas = []; let campo = '', linha = [], aspas = false;
  for(let i = 0; i < texto.length; i++){
    const c = texto[i];
    if(aspas){
      if(c === '"'){
        if(texto[i + 1] === '"'){ campo += '"'; i++; }
        else aspas = false;
      }else campo += c;
    }else if(c === '"'){ aspas = true; }
    else if(c === delim){ linha.push(campo); campo = ''; }
    else if(c === '\n' || c === '\r'){
      if(c === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo); campo = '';
      if(linha.some(x => x.trim() !== '')) linhas.push(linha);
      linha = [];
    }else campo += c;
  }
  linha.push(campo);
  if(linha.some(x => x.trim() !== '')) linhas.push(linha);
  return linhas;
}

const ALIAS_COLUNAS = {
  sap:         ['codigo_sap','codigo sap','cod_sap','cod sap','sap','material','no material','n material','numero material','codigo','cod'],
  descricao:   ['descricao','texto breve','texto breve material','denominacao','nome','produto'],
  fabricante:  ['fabricante','marca','fornecedor'],
  categoria:   ['categoria','grupo','grupo de mercadorias','tipo','familia'],
  unidade:     ['unidade','unidade medida','um','un','unid'],
  referencias: ['referencias','referencia','refs','ref','codigos equivalentes','equivalencias','cross','cross reference','referencias cruzadas'],
  aplicacao:   ['aplicacao','equipamento','aplicacao equipamento','onde usa','uso','veiculo'],
  localizacao: ['localizacao','local','deposito','prateleira','endereco','posicao'],
  obs:         ['observacoes','observacao','obs','nota','notas','comentario','comentarios'],
};

function mapearCabecalho(cabecalho){
  const mapa = {};
  cabecalho.forEach((nome, i) => {
    const chaveNorm = norm(nome).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    for(const [campo, aliases] of Object.entries(ALIAS_COLUNAS)){
      if(!(campo in mapa) && aliases.includes(chaveNorm)){ mapa[campo] = i; break; }
    }
  });
  return mapa;
}

/* envia uma lista de materiais "crus" para a base, mesclando por código SAP */
async function enviarParaBase(registros, origem){
  if(offline){ toast('Sem conexão — importe quando a internet voltar.', true); return false; }
  const porSap = new Map();
  materiais.forEach(m => { const k = alnum(m.sap); if(k) porSap.set(k, m); });

  const paraInserir = [];
  const paraAtualizar = [];
  let ignorados = 0;

  for(const r of registros){
    if(!r.sap && !r.descricao){ ignorados++; continue; }
    const existente = r.sap ? porSap.get(alnum(r.sap)) : null;
    if(existente){
      const mudanca = {};
      for(const campo of ['descricao','fabricante','categoria','unidade','aplicacao','localizacao','obs']){
        if(r[campo]) mudanca[campo] = r[campo];
      }
      mudanca.referencias = [...new Set([...(existente.referencias || []), ...(r.referencias || [])])];
      if(r.fotos && r.fotos.length)
        mudanca.fotos = [...new Set([...(existente.fotos || []), ...r.fotos])].slice(0, MAX_FOTOS);
      paraAtualizar.push({ id: existente.id, mudanca });
    }else{
      paraInserir.push({
        sap: r.sap || '', descricao: r.descricao || r.sap, fabricante: r.fabricante || '',
        categoria: r.categoria || '', unidade: r.unidade || '',
        referencias: r.referencias || [], aplicacao: r.aplicacao || '',
        localizacao: r.localizacao || '', obs: r.obs || '',
        fotos: (r.fotos || []).slice(0, MAX_FOTOS),
      });
    }
  }

  const total = paraInserir.length + paraAtualizar.length;
  let feitos = 0, erros = 0;
  const progresso = () => { $('contagem').textContent = `Importando… ${feitos}/${total}`; };
  progresso();

  for(let i = 0; i < paraInserir.length; i += 100){
    const fatia = paraInserir.slice(i, i + 100);
    const { data, error } = await sb.from('cat_materiais').insert(fatia).select();
    if(error){ erros += fatia.length; console.error(error); }
    else data.forEach(linha => { materiais.push(linha); feitos++; });
    progresso();
  }
  for(const { id, mudanca } of paraAtualizar){
    const { data, error } = await sb.from('cat_materiais')
      .update(mudanca).eq('id', id).select().single();
    if(error){ erros++; console.error(error); }
    else{
      const i = materiais.findIndex(m => m.id === id);
      if(i >= 0) materiais[i] = data;
      feitos++;
    }
    progresso();
  }

  salvarCache();
  preencherFiltros();
  renderResultados();
  atualizarRodape();
  const resumo = `${origem}: ${paraInserir.length ? paraInserir.length - Math.min(erros, paraInserir.length) : 0} novos, ${paraAtualizar.length} atualizados` +
    (ignorados ? `, ${ignorados} ignorados` : '') + (erros ? ` — ${erros} com ERRO` : ' ✔');
  toast(resumo, erros > 0);
  return erros === 0;
}

async function importarCSV(texto){
  const linhas = parseCSV(texto);
  if(linhas.length < 2){ toast('Arquivo vazio ou sem linhas de dados.', true); return; }
  const mapa = mapearCabecalho(linhas[0]);
  if(!('descricao' in mapa) && !('sap' in mapa)){
    toast('Cabeçalho não reconhecido: o CSV precisa de uma coluna “codigo_sap” ou “descricao”.', true);
    return;
  }
  const registros = linhas.slice(1).map(linha => {
    const pega = campo => (campo in mapa) ? (linha[mapa[campo]] || '').trim() : '';
    return {
      sap: pega('sap'), descricao: pega('descricao'), fabricante: pega('fabricante'),
      categoria: pega('categoria'), unidade: pega('unidade').toUpperCase(),
      referencias: lerReferencias(pega('referencias')),
      aplicacao: pega('aplicacao'), localizacao: pega('localizacao'), obs: pega('obs'),
    };
  });
  const ok = await enviarParaBase(registros, 'Importação CSV');
  if(ok) abrirTab('buscar');
}

function csvCampo(v){
  v = (v ?? '').toString();
  return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function exportarCSV(){
  if(!materiais.length){ toast('Nada para exportar ainda.', true); return; }
  const cab = ['codigo_sap','descricao','fabricante','categoria','unidade','referencias','aplicacao','localizacao','observacoes'];
  const linhas = materiais.map(m => [
    m.sap, m.descricao, m.fabricante, m.categoria, m.unidade,
    (m.referencias || []).join('; '), m.aplicacao, m.localizacao, m.obs,
  ].map(csvCampo).join(';'));
  const conteudo = '\uFEFF' + cab.join(';') + '\r\n' + linhas.join('\r\n');
  baixar(conteudo, `catalogo-materiais-${hoje()}.csv`, 'text/csv;charset=utf-8');
  toast('CSV exportado ✔');
}

function exportarJSON(){
  const conteudo = JSON.stringify({
    app: 'catalogo-materiais', versao: 2,
    exportadoEm: new Date().toISOString(), materiais,
  }, null, 1);
  baixar(conteudo, `catalogo-backup-${hoje()}.json`, 'application/json');
  toast('Backup JSON exportado ✔');
}

/* migração dos dados locais da versão 1 (localStorage) */
function dadosLegado(){
  try{
    const bruto = localStorage.getItem(LEGADO_KEY);
    if(!bruto) return null;
    const dados = JSON.parse(bruto);
    const lista = Array.isArray(dados) ? dados : dados.materiais;
    return Array.isArray(lista) && lista.length ? lista : null;
  }catch(e){ return null; }
}

function oferecerMigracaoLocal(){
  const antigos = dadosLegado();
  if(!antigos) return;
  $('bloco-migracao').hidden = false;
  $('qtd-migracao').textContent = antigos.length;
  if(!sessionStorage.getItem('migracaoOferecida')){
    sessionStorage.setItem('migracaoOferecida', '1');
    if(confirm(`Encontrei ${antigos.length} materiais salvos neste navegador pela versão antiga do catálogo.\n\nEnviar agora para a base compartilhada da equipe?`))
      migrarLegado();
  }
}

async function migrarLegado(){
  const antigos = dadosLegado();
  if(!antigos){ toast('Nenhum dado antigo encontrado.', true); return; }
  const registros = antigos.map(m => ({
    sap: m.sap || '', descricao: m.descricao || '', fabricante: m.fabricante || '',
    categoria: m.categoria || '', unidade: m.unidade || '',
    referencias: Array.isArray(m.referencias) ? m.referencias : lerReferencias(m.referencias || ''),
    aplicacao: m.aplicacao || '', localizacao: m.localizacao || '', obs: m.obs || '',
  }));
  const ok = await enviarParaBase(registros, 'Migração dos dados locais');
  if(ok){
    localStorage.setItem(LEGADO_KEY + '.backup', localStorage.getItem(LEGADO_KEY));
    localStorage.removeItem(LEGADO_KEY);
    $('bloco-migracao').hidden = true;
    abrirTab('buscar');
  }
}

/* ============================================================
   copiar SAP
   ============================================================ */
function copiarSap(sap){
  const feito = () => toast(`Código ${sap} copiado ✔`);
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(sap).then(feito, () => copiarFallback(sap, feito));
  }else copiarFallback(sap, feito);
}
function copiarFallback(texto, feito){
  const ta = document.createElement('textarea');
  ta.value = texto;
  document.body.appendChild(ta);
  ta.select();
  try{ document.execCommand('copy'); feito(); }
  catch(e){ toast('Não foi possível copiar automaticamente.', true); }
  ta.remove();
}

/* ============================================================
   eventos
   ============================================================ */
/* login */
$('form-login').addEventListener('submit', enviarLogin);
$('link-alternar').addEventListener('click', () => {
  modoLogin = modoLogin === 'criar' ? 'entrar' : 'criar';
  msgLogin('');
  aplicarModoLogin();
});
$('link-esqueci').addEventListener('click', esqueciSenha);
$('btn-sair').addEventListener('click', sair);
$('btn-sair-pendente').addEventListener('click', sair);
$('btn-verificar-aprovacao').addEventListener('click', async () => {
  usuarioCarregado = null;
  const { data: { session } } = await sb.auth.getSession();
  if(session) await iniciarSessao(session);
});

/* busca */
$('busca').addEventListener('input', () => { limiteRender = PAGINA; renderResultados(); });
$('filtro-categoria').addEventListener('change', () => { limiteRender = PAGINA; renderResultados(); });
$('filtro-fabricante').addEventListener('change', () => { limiteRender = PAGINA; renderResultados(); });
$('btn-mais').addEventListener('click', () => { limiteRender += PAGINA; renderResultados(); });

$('resultados').addEventListener('click', ev => {
  const foto = ev.target.closest('img[data-acao="foto"]');
  const card = ev.target.closest('.card');
  if(!card) return;
  const id = card.dataset.id;
  const m = materiais.find(x => x.id === id);
  if(foto && m){ abrirLightbox(m.fotos || [], Number(foto.dataset.idx) || 0); return; }
  const btn = ev.target.closest('button[data-acao]');
  if(!btn) return;
  if(btn.dataset.acao === 'copiar'){ if(m && m.sap) copiarSap(m.sap); }
  else if(btn.dataset.acao === 'editar') editarMaterial(id);
  else if(btn.dataset.acao === 'excluir') excluirMaterial(id);
});

/* abas */
document.querySelectorAll('nav.tabs button').forEach(b =>
  b.addEventListener('click', () => abrirTab(b.dataset.tab)));

/* formulário */
$('form-material').addEventListener('submit', salvarMaterial);
$('btn-cancelar').addEventListener('click', () => { limparForm(); abrirTab('buscar'); });
$('btn-add-foto').addEventListener('click', () => $('f-foto-input').click());
$('f-foto-input').addEventListener('change', ev => {
  const arq = ev.target.files[0];
  if(arq) adicionarFoto(arq);
  ev.target.value = '';
});
$('fotos-form').addEventListener('click', ev => {
  const rm = ev.target.closest('.rm-foto');
  if(!rm) return;
  fotosForm.splice(Number(rm.dataset.idx), 1);
  renderFotosForm();
});

/* scanner */
$('btn-scan-busca').addEventListener('click', () => abrirScanner(texto => {
  $('busca').value = texto;
  limiteRender = PAGINA;
  renderResultados();
  abrirTab('buscar');
}));
$('btn-scan-sap').addEventListener('click', () => abrirScanner(texto => {
  $('f-sap').value = texto;
}));
$('btn-fechar-scanner').addEventListener('click', fecharScanner);
$('modal-scanner').addEventListener('click', ev => {
  if(ev.target === $('modal-scanner')) fecharScanner();
});

/* etiquetas */
$('btn-etiquetas').addEventListener('click', imprimirEtiquetas);

/* lightbox */
$('lb-fechar').addEventListener('click', () => { $('lightbox').hidden = true; });
$('lightbox').addEventListener('click', ev => {
  if(ev.target === $('lightbox')) $('lightbox').hidden = true;
});
$('lb-ant').addEventListener('click', () => { lbIdx = (lbIdx - 1 + lbFotos.length) % lbFotos.length; atualizarLightbox(); });
$('lb-prox').addEventListener('click', () => { lbIdx = (lbIdx + 1) % lbFotos.length; atualizarLightbox(); });
document.addEventListener('keydown', ev => {
  if(ev.key === 'Escape'){ $('lightbox').hidden = true; fecharScanner(); }
});

/* equipe */
$('lista-equipe').addEventListener('click', ev => {
  const btn = ev.target.closest('button[data-eq]');
  if(!btn) return;
  acaoEquipe(btn.closest('tr').dataset.id, btn.dataset.eq);
});

/* dados */
$('arquivo-csv').addEventListener('change', ev => {
  const arq = ev.target.files[0];
  if(!arq) return;
  const leitor = new FileReader();
  leitor.onload = () => { importarCSV(leitor.result); ev.target.value = ''; };
  leitor.readAsText(arq, 'utf-8');
});
$('btn-exportar-csv').addEventListener('click', exportarCSV);
$('btn-exportar-json').addEventListener('click', exportarJSON);
$('btn-migrar').addEventListener('click', migrarLegado);

/* ============================================================
   inicialização
   ============================================================ */
aplicarModoLogin();

sb.auth.onAuthStateChange((evento, s) => {
  // setTimeout evita deadlock ao chamar outras funções do supabase dentro do callback
  setTimeout(() => {
    if(evento === 'PASSWORD_RECOVERY'){
      modoLogin = 'novaSenha';
      aplicarModoLogin();
      mostrarTela('login');
      msgLogin('Defina sua nova senha abaixo.');
      return;
    }
    if(evento === 'SIGNED_OUT'){ mostrarTela('login'); return; }
    iniciarSessao(s);
  }, 0);
});

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if(!session) mostrarTela('login');
  // com sessão, o onAuthStateChange (INITIAL_SESSION) cuida da inicialização
})();
