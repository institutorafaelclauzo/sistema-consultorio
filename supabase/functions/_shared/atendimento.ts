/**
 * Atendimento automatico do WhatsApp.
 *
 * Quem escreve para a clinica cai num menu de tres opcoes: informacoes,
 * agendar, ou falar com a equipe. O agendamento e um sub-fluxo (unidade ->
 * horario) e nao um destino final: de qualquer etapa da a para voltar.
 *
 * Duas regras guiam todo o texto daqui:
 *  1. nenhuma resposta termina sem dizer o que fazer em seguida;
 *  2. MENU sempre volta ao inicio, e isso aparece escrito na mensagem.
 *
 * Regra da clinica para marcar:
 *  - paciente ja cadastrado marca direto;
 *  - pessoa sem cadastro gera solicitacao com a vaga reservada por 24h, e a
 *    recepcao confirma.
 *
 * Este arquivo so decide e escreve no banco. Quem envia a mensagem e o
 * meta-webhook, que ja tem o token e o numero em maos.
 */

import type { adminClient } from './whatsapp.ts'
import { cadastrarDaFicha, type ConsultaParaCadastro } from './cadastro.ts'
import {
  acharResposta,
  assuntoClinico,
  carregarRespostas,
  medicamentoControlado,
} from './respostas.ts'

/** Dias oferecidos de uma vez. Cabe a quinzena inteira numa mensagem so. */
/**
 * Ate oito dias por lista.
 *
 * Nao e limite de tela: e para o *9* poder significar "falar com a equipe" em
 * qualquer etapa. Com dez dias na lista, o nove seria um dia e a saida teria de
 * voltar a ser uma palavra digitada.
 */
const MAX_DIAS = 8
/** Horarios de um dia. Um expediente de 8h as 18h em blocos de 40min da 15. */
// Oito tambem aqui, pelo mesmo motivo dos dias: com nove horarios na lista, o
// *9* seria um horario. Quem precisar de um horario fora dos oito primeiros usa
// justamente o 9 para falar com a equipe, que e o que a linha de saida oferece.
const MAX_HORARIOS_DIA = 8
/** Teto do WhatsApp para linhas de uma lista tocavel. */
const MAX_TOQUES = 10
/** Tetos da Meta para o texto de cada linha. Passar disso derruba a mensagem. */
const LIMITE_TITULO = 24
const LIMITE_DESCRICAO = 72

/**
 * O cliente com service_role que o webhook ja tem em maos. Tipar pelo retorno
 * de adminClient() em vez de `any` mantem o lint honesto sem repetir aqui a
 * definicao inteira do banco.
 */
type Admin = ReturnType<typeof adminClient>

export type Estado =
  | 'menu'
  | 'minha_consulta'
  | 'confirmar_cancelamento'
  | 'ja_tem_consulta'
  | 'aguardando_paciente'
  | 'aguardando_unidade'
  | 'aguardando_convenio'
  | 'aguardando_dia'
  | 'aguardando_horario'
  | 'dados_nome'
  | 'dados_nascimento'
  | 'dados_responsavel'
  | 'dados_cpf'
  | 'dados_email'
  | 'informacoes_unidade'
  | 'atendente'
  | 'documento_quem'
  | 'documento_paciente'
  | 'documento_tipo'
  | 'documento_item'
  | 'documento_exigencia'
  | 'documento_farmacia'
export type MotivoAtencao =
  | 'atendente'
  | 'falha'
  | 'cancelou_sozinho'
  | 'urgencia'
  | 'anexo'
  | 'documento'
  | 'farmacia'

/**
 * A telemedicina como "unidade" do fluxo.
 *
 * Ela nao tem agenda propria: usa os horarios das unidades fisicas, porque e o
 * mesmo medico no mesmo dia. Para o robo, porem, e uma opcao na mesma lista
 * de Santos e Sao Paulo - e tratar como unidade virtual deixa o fluxo inteiro
 * (unidade -> dia -> horario) igual, com um desvio so na hora de buscar os
 * horarios e outro na hora de gravar. O id nao e uuid de proposito: nunca vai
 * para a coluna booking_unit_id; a modalidade fica em booking_modality.
 */
const TELE_ID = 'telemedicina'
const UNIDADE_TELE = { id: TELE_ID, name: 'Telemedicina (por vídeo)', address: '' }
export type Modalidade = 'presencial' | 'telemedicina'

/**
 * Botao ou linha de lista tocavel no WhatsApp.
 *
 * O `id` e o que volta quando a pessoa toca, e ele e escrito de proposito com
 * exatamente o mesmo texto que o robo ja aceita digitado ("2", "CANCELAR",
 * "SIM"). Assim tocar e digitar entram pelo mesmo caminho, e quem prefere
 * escrever - ou usa um aparelho que nao mostra a lista - continua atendido.
 */
export type Toque = { id: string; titulo: string; descricao?: string }

export type Resultado = {
  resposta: string
  /** Preenchido quando a conversa precisa de alguem da equipe. */
  atencao?: MotivoAtencao
  /**
   * O robo terminou o atendimento e nao sobrou nada para a equipe fazer.
   *
   * Vale para o fim da ficha: o cadastro foi completado e, quando havia
   * agendamento, a consulta ficou marcada. Ate 20/09/2026 uma conversa dessas
   * nao ganhava marca nenhuma na lista - so o robo tinha falado, entao
   * "Respondida" (que e sobre gente da equipe) nao valia, e "Resolvida" so vem
   * de alguem clicar em Concluir. O cartao ficava com cara de pendente sem ter
   * pendencia, e a recepcao abria um por um para descobrir isso.
   *
   * Fechar aqui e seguro porque nao e definitivo: qualquer mensagem nova da
   * familia reabre a conversa, no mesmo lugar do webhook que ja trata a
   * mensagem recebida.
   */
  concluida?: boolean
  /** Ate tres botoes lado a lado. Acima disso, use lista. */
  botoes?: Toque[]
  /** Lista tocavel: o rotulo abre o menu, as linhas sao as opcoes (max. 10). */
  lista?: { rotulo: string; linhas: Toque[] }
} | null

type Unidade = {
  id: string
  name: string
  address: string
  info_text?: string | null
  /** Convenio aceito nesta unidade. Vazio = so particular, e o robo nao pergunta. */
  accepts_insurance?: string | null
}
type Paciente = {
  id: string
  name: string
  /** O que o cadastro ja tem. Vazio = falta, e o robo pergunta. */
  nascimento?: string | null
  responsavel?: string | null
  cpf?: string | null
  email?: string | null
}
/** `unitId` so vem na telemedicina: diz de qual unidade fisica saiu o horario. */
type Horario = { inicio: string; fim: string; unitId?: string }

/** Consulta futura ja marcada para este telefone. */
export type ConsultaMarcada = {
  id: string
  inicio: string
  unidade: string
  endereco: string
  paciente: string
  confirmada: boolean
}

function normalizar(texto: string) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
}

/** Frases que abrem o agendamento sem passar pelo menu. */
export function pediuAgendamento(texto: string) {
  const t = normalizar(texto)

  // Remarcar e desmarcar contem "marcar" e sao o oposto: quem pede isso ja tem
  // consulta, e precisa do caminho de remarcacao, nao de uma consulta nova.
  if (/\b(remarc|desmarc|cancel)/.test(t)) return false

  // Palavra solta e nao frase inteira.
  //
  // Ate 15/09/2026 a lista era de frases exatas: valia "quero marcar", nao
  // valia "quero marcar retorno para o Anthony", nem "queria marcar uma
  // consulta", nem "gostaria de agendar para meu filho". Ninguem escreve no
  // WhatsApp do jeito que o programador previu, e cada frase de fora caia no
  // menu ou, pior, numa resposta pronta que nao tinha nada a ver - foi o que
  // aconteceu com a Sonia, que pediu para marcar retorno e recebeu a lista de
  // documentos para levar.
  //
  // "consulta" sozinha fica de fora de proposito: "quanto custa a consulta?" e
  // pergunta de preco, e abriria a escolha de unidade sem ninguem pedir.
  return /\b(marcar|marcacao|agendar|agendamento|horarios?)\b/.test(t)
}

/** A saida de emergencia. Vale em qualquer etapa, inclusive com a equipe. */
function pediuMenu(texto: string) {
  const t = normalizar(texto)
  return (
    t === 'menu' ||
    t === '0' ||
    t === 'inicio' ||
    t === 'voltar ao menu' ||
    t === 'menu principal' ||
    t === 'opcoes'
  )
}

/** Um passo atras, nao ate o inicio. */
function pediuVoltar(texto: string) {
  const t = normalizar(texto)
  return t === 'voltar' || t === 'anterior'
}

/**
 * Chamar a equipe por palavra, e nao por numero.
 *
 * A palavra continua valendo para quem digita, mas deixou de ser o caminho
 * anunciado: hoje o *9* faz o mesmo em qualquer etapa, e pedir uma palavra a
 * quem esta respondendo numeros era trocar de idioma no meio da conversa.
 */
function pediuAtendente(texto: string) {
  const t = normalizar(texto)
  // O 9 vale em qualquer etapa porque nenhuma lista passa de oito opcoes. E a
  // primeira coisa conferida a cada mensagem, entao ele nunca e confundido com
  // a escolha de um dia ou de um horario.
  if (t === '9') return true
  return (
    t === 'atendente' ||
    t === 'secretaria' ||
    t === 'equipe' ||
    t === 'falar com atendente' ||
    t === 'falar com a equipe' ||
    t === 'ajuda'
  )
}

/** "Urgente", "é urgência", ou a linha URGENCIA tocada na lista. */
function pediuUrgencia(texto: string) {
  return /urgen/.test(normalizar(texto))
}

function desistiu(texto: string) {
  const t = normalizar(texto)
  return t === 'cancelar' || t === 'sair' || t === 'parar' || t === 'desistir'
}

/**
 * Le uma hora escrita por extenso: "10h", "09:20", "as 9 h".
 *
 * So conta como hora quando ha marca explicita (`h` ou `:`). Numero solto
 * continua sendo indice da lista, que e o que a mensagem pede.
 *
 * Existe por causa de um erro silencioso: num dia com 15 horarios, quem
 * digitava "10h" era entendido como "opcao 10" e saia marcado as 14:00,
 * convencido de que tinha marcado as 10:00. Errar calado e pior do que nao
 * entender.
 */
function horaEscrita(texto: string): { hora: number; minuto: number | null } | null {
  const t = normalizar(texto)
  if (!/[h:]/.test(t)) return null
  const m = t.match(/(\d{1,2})\s*[:h]\s*(\d{2})?/)
  if (!m) return null
  const hora = Number(m[1])
  const minuto = m[2] === undefined ? null : Number(m[2])
  if (hora > 23) return null
  if (minuto !== null && minuto > 59) return null
  return { hora, minuto }
}

/** Le "31/08" e devolve dia e mes, para quem responde a data em vez do numero. */
function dataEscrita(texto: string): { dia: number; mes: number } | null {
  const m = normalizar(texto).match(/(\d{1,2})\s*[/.-]\s*(\d{1,2})/)
  if (!m) return null
  const dia = Number(m[1])
  const mes = Number(m[2])
  if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return null
  return { dia, mes }
}

/**
 * Le "2", "2.", "*2*" ou "opcao 2" e devolve o indice na lista mostrada.
 *
 * O NUMERO PRECISA SER A MENSAGEM, e nao um numero dentro dela. Antes daqui a
 * funcao raspava tudo que nao fosse digito e lia o que sobrava, entao qualquer
 * frase com um algarismo virava escolha de menu - e isso acontecia ANTES de o
 * robo tentar responder a pergunta ou reconhecer assunto clinico:
 *
 *   "meu filho de 2 anos esta com sangue nas fezes"  ->  abria o agendamento
 *   "ele tem 5 anos, o que devo levar?"              ->  abria a 2a via
 *   "prefiro Santos, fica a 2 quadras"               ->  escolhia a unidade 2
 *
 * A pergunta nunca era respondida, e no primeiro caso um sintoma de alarme
 * entrava como "quero marcar". Numero de idade e o mais comum numa clinica
 * pediatrica: quase toda mae diz a idade do filho na primeira frase.
 *
 * O que continua valendo e o jeito real de responder: o numero sozinho, com
 * pontuacao, com os asteriscos que o proprio robo usa no menu, ou precedido
 * de "opcao"/"numero". Tudo o mais e frase, e frase vai para quem sabe ler
 * frase.
 */
function escolha(texto: string, total: number): number | null {
  const limpo = normalizar(texto)
    .replace(/\*/g, '')
    .replace(/^(a\s+)?(op(c|ç)(a|ã)o|numero|n(u|ú)mero|item|alternativa)\s+/, '')
    .replace(/[.)\]º°,;:!]+$/, '')
    .trim()
  if (!/^\d{1,2}$/.test(limpo)) return null
  const numero = Number.parseInt(limpo, 10)
  if (!Number.isFinite(numero) || numero < 1 || numero > total) return null
  return numero - 1
}

/**
 * "segunda, 14/09".
 *
 * Por extenso, e nao "seg.": ninguem le uma lista de abreviacoes de olhada, e o
 * dia da semana e justamente o que a pessoa esta procurando ao escolher.
 *
 * O "-feira" sai porque nao acrescenta nada e rouba nove caracteres do titulo
 * da lista tocavel, que a Meta corta em 24.
 */
function formatarDia(iso: string, timezone: string) {
  const texto = new Date(iso).toLocaleDateString('pt-BR', {
    timeZone: timezone,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
  })
  return texto.replace('-feira', '')
}

function formatarHora(iso: string, timezone: string) {
  return new Date(iso).toLocaleTimeString('pt-BR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatarData(iso: string, timezone: string) {
  return `${formatarDia(iso, timezone)} às ${formatarHora(iso, timezone)}`
}

/** Chave estavel do dia no fuso da clinica, no formato AAAA-MM-DD. */
function chaveDoDia(iso: string, timezone: string) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: timezone })
}

/**
 * Agrupa os horarios livres por dia, preservando a ordem cronologica.
 *
 * O paciente pensa em dia antes de pensar em hora. Uma lista corrida de 42
 * horarios so mostrava os 8 primeiros - dois dias - e dava a impressao de que a
 * agenda acabava ali, escondendo os outros cinco dias abertos.
 */
function agruparPorDia(horarios: Horario[], timezone: string) {
  const porDia = new Map<string, Horario[]>()
  for (const h of horarios) {
    const chave = chaveDoDia(h.inicio, timezone)
    const lista = porDia.get(chave)
    if (lista) lista.push(h)
    else porDia.set(chave, [h])
  }
  return [...porDia.entries()].map(([chave, lista]) => ({ chave, horarios: lista }))
}

/**
 * O menu como o pai le no celular.
 *
 * O emoji nao e enfeite: quem abre esta conversa costuma estar com uma crianca
 * no colo e pressa, e o icone diz do que se trata antes da leitura. Um por
 * linha, sempre o mesmo - variar so atrapalharia o reconhecimento.
 *
 * O numero vai em negrito porque e o que a pessoa precisa digitar. O verbo vem
 * na frente ("Marcar", "Falar", "Ver") para a linha responder a pergunta "o que
 * eu quero fazer" em vez de nomear uma funcao do sistema.
 */
const OPCOES = [
  '*1* 💬 Dúvidas sobre a consulta',
  // 🗓️ e nao 📅: o calendario cheio desenha uma data fixa dentro do icone, e um
  // "24 de fevereiro" ao lado de uma consulta de setembro confunde quem le.
  // "ou retorno" escrito na linha porque quem volta em 30 dias nao tinha como
  // saber que este era o caminho dele: "marcar uma consulta" soa como comecar
  // do zero, e o paciente de retorno ia para o *3* pedir gente. A lista abaixo
  // nao cabe essa frase (24 caracteres por linha, limite da Meta), entao ali a
  // palavra vai na descricao.
  '*2* 🗓️ Marcar uma consulta ou retorno',
  // 🗣️ e nao 👩‍⚕️: o emoji de profissional de saude e composto por dois
  // caracteres colados por um invisivel, e em Android antigo a cola falha e
  // aparecem dois desenhos soltos - justamente no aparelho mais simples.
  '*3* 🗣️ Falar com alguém da equipe',
  // 🔄 e nao 🔎: a opcao faz tres coisas, e a lupa sugere apenas olhar.
  '*4* 🔄 Ver, remarcar ou cancelar',
  // "2a via" vem na frente do nome tecnico porque e assim que a familia chega:
  // "perdi a receita", "a farmacia nao aceitou". Ninguem escreve "solicitacao
  // de documento medico". O 📄 repete a ideia de papel na mao.
  '*5* 📄 2ª via de receita ou pedido de exame',
].join('\n')

// O "0" sempre funcionou - pediuMenu o aceita desde o inicio, e ele nunca
// colide com a lista porque indice de opcao comeca em 1. So nao estava escrito
// em lugar nenhum, e o que nao se anuncia nao existe para quem le.
const VOLTA = 'Digite *0* a qualquer momento para voltar ao início.'
const SAIDAS = 'Digite *9* para falar com a nossa equipe, ou *0* para voltar ao início.'

/**
 * Acrescenta as duas saidas na propria lista tocavel.
 *
 * Quem toca nao deveria precisar digitar nada. As duas linhas ocupam duas das
 * dez, entao o conteudo e cortado em oito - o mesmo oito de MAX_DIAS, para que
 * o numero mostrado e o numero tocado nunca discordem.
 */
/**
 * Encurta um titulo de linha respeitando o limite da Meta.
 *
 * Corta no separador quando existe, porque "Livance Ibirapuera - Sao Paulo"
 * vira "Livance Ibirapuera" e nao "Livance Ibirapuera - Sa". A cidade nao se
 * perde: ela continua na descricao e no texto da mensagem.
 */
function tituloCurto(texto: string): string {
  const limpo = texto.trim()
  if (limpo.length <= LIMITE_TITULO) return limpo

  for (const separador of [' - ', ' · ', ' — ', ', ']) {
    const corte = limpo.split(separador)[0].trim()
    if (corte.length > 0 && corte.length <= LIMITE_TITULO) return corte
  }
  return `${limpo.slice(0, LIMITE_TITULO - 1).trimEnd()}…`
}

/**
 * Acrescenta as duas saidas e faz caber no que a Meta aceita.
 *
 * O corte acontece AQUI, e nao em cada tela, porque foi assim que a lista de
 * unidades quebrou: "Livance Ibirapuera - São Paulo" tem 30 caracteres, a Meta
 * recusou a mensagem interativa inteira, e ela chegou como texto puro sem botao
 * nenhum. Nada avisa quando isso acontece - a mensagem simplesmente perde o
 * toque. Centralizando, uma tela nova nao pode reintroduzir o defeito.
 */
function comVoltar(linhas: Toque[]): Toque[] {
  const cabem = linhas.slice(0, MAX_TOQUES - 2).map((linha) => ({
    ...linha,
    titulo: tituloCurto(linha.titulo),
    ...(linha.descricao ? { descricao: linha.descricao.slice(0, LIMITE_DESCRICAO) } : {}),
  }))

  return [
    ...cabem,
    { id: '9', titulo: 'Falar com a equipe' },
    { id: '0', titulo: 'Voltar ao menu' },
  ]
}

/**
 * Colunas que nasceram depois de alguma versao da funcao ja estar no ar.
 *
 * A funcao, o frontend e as migrations sobem por caminhos diferentes, e a
 * funcao costuma chegar primeiro. Quando ela grava uma coluna que o banco
 * ainda nao tem, o Postgres NAO ignora o campo desconhecido: ele recusa o
 * UPDATE inteiro.
 *
 * Em 19/09/2026 isso derrubou o atendimento de um jeito que nao parecia erro.
 * O estado da conversa deixou de ser gravado, entao o robo nunca saia do
 * menu: o paciente digitava 1, recebia o menu, digitava 1 de novo, recebia o
 * menu. Tres vezes, sem nenhuma mensagem de erro em lugar nenhum.
 *
 * Perder o campo novo e um arranhao; perder o estado da conversa trava o
 * atendimento. Entao o campo novo e o que cede.
 */
const COLUNAS_RECENTES = ['booking_insurance']

async function salvarEstado(
  admin: Admin,
  conversationId: string,
  campos: Record<string, unknown>,
) {
  const tudo = { booking_updated_at: new Date().toISOString(), ...campos }
  const { error } = await admin
    .from('whatsapp_conversations')
    .update(tudo)
    .eq('id', conversationId)
  if (!error) return

  const semAsNovas: Record<string, unknown> = { ...tudo }
  let tirouAlguma = false
  for (const coluna of COLUNAS_RECENTES) {
    if (coluna in semAsNovas) {
      delete semAsNovas[coluna]
      tirouAlguma = true
    }
  }
  if (!tirouAlguma) {
    console.error('Falha ao salvar o estado da conversa', error)
    return
  }

  console.warn('Coluna recente ausente no banco; salvando o estado sem ela', error)
  const { error: aindaFalha } = await admin
    .from('whatsapp_conversations')
    .update(semAsNovas)
    .eq('id', conversationId)
  if (aindaFalha) console.error('Falha ao salvar o estado da conversa', aindaFalha)
}

/**
 * Encerra a etapa mas deixa o menu no ar.
 *
 * Serve para toda mensagem que termina oferecendo um numero ("digite 2 para
 * ..."). Com o estado zerado, esse numero caia na regra de silencio quando a
 * conversa estava marcada para a equipe - foi o que aconteceu depois de um
 * cancelamento em 30/08/2026: o robo prometeu "digite 2" e emudeceu.
 */
async function voltarAoMenuAtivo(admin: Admin, conversationId: string) {
  await salvarEstado(admin, conversationId, {
    booking_state: 'menu',
    booking_options: null,
    booking_unit_id: null,
    booking_modality: null,
    booking_patient_id: null,
    booking_replaces_id: null,
    booking_intake_id: null,
    booking_insurance: null,
  })
}

async function limparEstado(admin: Admin, conversationId: string) {
  await salvarEstado(admin, conversationId, {
    booking_state: null,
    booking_options: null,
    booking_unit_id: null,
    booking_modality: null,
    booking_patient_id: null,
    booking_replaces_id: null,
    booking_intake_id: null,
    booking_insurance: null,
  })
}

/** Se a clinica oferece telemedicina pelo robo, e o texto de informacoes dela. */
async function telemedicinaDaClinica(
  admin: Admin,
  clinicId: string,
): Promise<{ ativa: boolean; informacoes: string }> {
  const { data } = await admin
    .from('clinic_settings')
    .select('telemedicine_enabled,telemedicine_info_text')
    .eq('clinic_id', clinicId)
    .maybeSingle()
  return {
    ativa: Boolean(data?.telemedicine_enabled),
    informacoes: (data?.telemedicine_info_text ?? '').trim(),
  }
}

/**
 * A unidade pelo id, incluindo a virtual da telemedicina.
 *
 * Todo lugar que precisava reler a unidade do banco passa por aqui, para a
 * telemedicina nao virar "unidade nao encontrada" no meio do fluxo.
 */
/**
 * As colunas da unidade, e o plano B quando uma delas ainda nao existe.
 *
 * A funcao, o frontend e as migrations sobem por caminhos diferentes, e a
 * funcao costuma chegar primeiro. Quando ela pede uma coluna que o banco ainda
 * nao tem, o Postgres NAO ignora a coluna desconhecida: recusa a consulta
 * INTEIRA e devolve nulo.
 *
 * Em 19/09/2026 isso derrubou o atendimento sem parecer erro: sem unidades, a
 * opcao 1 nao tinha o que mostrar e devolvia o menu. O paciente digitava 1,
 * recebia o menu, digitava 1 de novo, recebia o menu.
 *
 * Entao toda coluna nova entra com um plano B: tenta com ela, e se falhar
 * refaz sem. A unidade volta sem convenio - que e o mesmo que "so particular",
 * o estado anterior do mundo - e o atendimento segue de pe.
 */
const COLUNAS_DA_UNIDADE = 'id,name,address,info_text,accepts_insurance'
const COLUNAS_ANTIGAS_DA_UNIDADE = 'id,name,address,info_text'

async function unidadePorId(admin: Admin, id: string): Promise<Unidade | null> {
  if (id === TELE_ID) return UNIDADE_TELE
  const { data, error } = await admin
    .from('clinic_units')
    .select(COLUNAS_DA_UNIDADE)
    .eq('id', id)
    .maybeSingle()
  if (!error && data) return data as Unidade

  const { data: basico } = await admin
    .from('clinic_units')
    .select(COLUNAS_ANTIGAS_DA_UNIDADE)
    .eq('id', id)
    .maybeSingle()
  return (basico as Unidade | null) ?? null
}

async function unidadesAtivas(admin: Admin, clinicId: string) {
  const { data, error } = await admin
    .from('clinic_units')
    .select(COLUNAS_DA_UNIDADE)
    .eq('clinic_id', clinicId)
    .is('archived_at', null)
    .order('name')
  if (!error && data) return data as Unidade[]

  console.warn('clinic_units sem accepts_insurance; seguindo so com particular', error)
  const { data: basico } = await admin
    .from('clinic_units')
    .select(COLUNAS_ANTIGAS_DA_UNIDADE)
    .eq('clinic_id', clinicId)
    .is('archived_at', null)
    .order('name')
  return (basico ?? []) as Unidade[]
}

/** As unidades fisicas e, quando a clinica oferece, a telemedicina no fim. */
async function opcoesDeAtendimento(admin: Admin, clinicId: string): Promise<Unidade[]> {
  const unidades = await unidadesAtivas(admin, clinicId)
  const tele = await telemedicinaDaClinica(admin, clinicId)
  return tele.ativa && unidades.length > 0 ? [...unidades, UNIDADE_TELE] : unidades
}

async function fusoDaClinica(admin: Admin, clinicId: string) {
  const { data } = await admin
    .from('clinics')
    .select('timezone')
    .eq('id', clinicId)
    .maybeSingle()
  return data?.timezone || 'America/Sao_Paulo'
}

/**
 * Horarios livres de uma unidade.
 *
 * Devolve `falhou` separado de "lista vazia" de proposito. Ate 30/08/2026 os
 * dois casos se confundiam e o paciente ouvia "nao temos horarios" quando na
 * verdade a consulta ao banco tinha sido recusada por permissao. Dizer que a
 * agenda esta vazia quando ela esta cheia e pior do que admitir a falha.
 */
async function horariosLivres(
  admin: Admin,
  clinicId: string,
  unitId: string,
): Promise<{ horarios: Horario[]; falhou: boolean }> {
  // Telemedicina: os horarios de todas as unidades fisicas, juntos e em ordem.
  // Cada um lembra de onde veio, porque e la que a consulta vai ser gravada.
  if (unitId === TELE_ID) {
    const fisicas = await unidadesAtivas(admin, clinicId)
    const partes = await Promise.all(fisicas.map((u) => horariosLivres(admin, clinicId, u.id)))
    if (partes.length > 0 && partes.every((p) => p.falhou)) return { horarios: [], falhou: true }
    const juntos = partes
      .flatMap((p, i) => p.horarios.map((h) => ({ ...h, unitId: fisicas[i].id })))
      .sort((a, b) => a.inicio.localeCompare(b.inicio))
    return { horarios: juntos, falhou: false }
  }

  // Libera reservas vencidas antes de listar: sem isso o horario aparece livre
  // aqui e a marcacao falha depois, no indice unico.
  const { error: erroFaxina } = await admin.rpc('liberar_reservas_vencidas')
  if (erroFaxina) console.error('liberar_reservas_vencidas falhou', erroFaxina)

  const { data, error } = await admin.rpc('available_slots', { p_unit_id: unitId })
  if (error) {
    console.error('available_slots falhou', { unitId, error })
    return { horarios: [], falhou: true }
  }

  // Sem corte aqui: quem decide quanto mostrar e a etapa (dias ou horarios do
  // dia). Cortar na origem foi o que escondeu cinco dias de agenda.
  const lista = ((data ?? []) as { slot_start: string; slot_end: string }[]).map((h) => ({
    inicio: h.slot_start,
    fim: h.slot_end,
  }))
  return { horarios: lista, falhou: false }
}

const AVISO_FALHA =
  'Tive um problema para consultar a agenda agora. Já avisei a nossa equipe, ' +
  'que retorna por aqui para marcar com você.\n\n' + VOLTA

// ---------------------------------------------------------------
// Menu principal
// ---------------------------------------------------------------

export async function mostrarMenu(
  admin: Admin,
  conversationId: string,
  saudacao: string,
  aviso = '',
): Promise<Resultado> {
  await salvarEstado(admin, conversationId, {
    booking_state: 'menu',
    booking_options: null,
    booking_unit_id: null,
    menu_sent_at: new Date().toISOString(),
  })

  // Com aviso, o aviso ja e a instrucao. Repetir "Como podemos ajudar?" logo
  // depois de "Nao entendi, responda com o numero" dava duas ordens seguidas.
  const cabecalho = aviso ||
    `${saudacao}\n\nEstamos aqui para cuidar de você. Como podemos ajudar hoje?`
  // A instrucao vai DEPOIS das opcoes de proposito: quem ja sabe o que quer
  // responde na hora, e quem hesitou tem a saida logo abaixo do que leu.
  const instrucao = aviso ? '' : '\n\nResponda com o número ou toque em "Ver opções".'
  return {
    resposta: `${cabecalho}\n\n${OPCOES}${instrucao}`,
    lista: {
      rotulo: 'Ver opções',
      linhas: [
        { id: '1', titulo: 'Dúvidas sobre a consulta', descricao: 'Valores, contatos e orientações' },
        { id: '2', titulo: 'Marcar uma consulta', descricao: 'Consulta nova ou retorno · unidade, dia e horário' },
        { id: '3', titulo: 'Falar com a equipe', descricao: 'Alguém do consultório responde' },
        { id: '4', titulo: 'Minha consulta', descricao: 'Ver, remarcar ou cancelar' },
        // 24 caracteres e o teto do titulo; "2ª via ou exame" cabe e diz o
        // essencial, com o resto na descricao.
        { id: '5', titulo: '2ª via ou exame', descricao: 'Receita ou pedido de exame já feito' },
      ],
    },
  }
}

/**
 * Responder uma pergunta escrita, quando a clinica tem resposta pronta para ela.
 *
 * Vem antes do menu: quem escreveu "quanto custa a consulta?" fez uma pergunta,
 * e devolver uma lista de opcoes e fingir que a pergunta nao existiu. Se nenhum
 * assunto cadastrado bate - ou se a mensagem e clinica - devolve nulo e o menu
 * segue como sempre.
 *
 * Termina em 'menu' para os numeros continuarem valendo: quem acabou de ler o
 * valor da consulta e exatamente quem pode responder "2" para marcar.
 */
async function responderPergunta(
  admin: Admin,
  clinicId: string,
  conversationId: string,
  texto: string,
  textoGeral: string,
): Promise<Resultado | null> {
  const achada = acharResposta(texto, await carregarRespostas(admin, clinicId))
  if (!achada) return null

  // "Quanto custa?" nao tem resposta unica: depende de onde. O assunto marcado
  // para perguntar a unidade cai na mesma pergunta da opcao 1 do menu, e a
  // resposta e o texto de informacoes do lugar escolhido. Com um lugar so, a
  // pergunta nao existe e vale o texto da propria resposta.
  if (achada.perguntarUnidade) {
    const lugares = await opcoesDeAtendimento(admin, clinicId)
    if (lugares.length > 1) {
      return await perguntarLocalDasInformacoes(admin, clinicId, conversationId, textoGeral)
    }
  }

  await salvarEstado(admin, conversationId, {
    booking_state: 'menu',
    booking_options: null,
    booking_unit_id: null,
    menu_sent_at: new Date().toISOString(),
  })

  return {
    resposta: `${achada.resposta}\n\n${SAIDAS}`,
    lista: {
      rotulo: 'Ver opções',
      linhas: [
        { id: '2', titulo: 'Marcar uma consulta', descricao: 'Consulta nova ou retorno · unidade, dia e horário' },
        { id: '9', titulo: 'Falar com a equipe', descricao: 'Alguém do consultório responde' },
        { id: '0', titulo: 'Voltar ao menu' },
      ],
    },
  }
}

/**
 * Informacoes da consulta: primeiro onde, depois o texto.
 *
 * O valor nao e um so - Santos e Sao Paulo cobram diferente, e a telemedicina
 * tem regra propria de retorno. Responder tudo de uma vez virava um paragrafo
 * com tres precos, e a pessoa tinha que achar o dela no meio. Perguntar antes
 * custa um toque e entrega a resposta certa, curta, com o endereco certo.
 *
 * Com uma unidade so e sem telemedicina, nao ha o que perguntar: responde.
 */
/**
 * O que dizer quando a resposta nao foi o numero esperado.
 *
 * Antes era sempre "Nao entendi, responda com o numero". Mas quem escreve
 * "Convenio" no meio da escolha da unidade nao errou: mudou de assunto, e o
 * robo sabia responder aquilo. Insistir no numero era defender o proprio fluxo
 * em vez de atender - a pessoa perguntava e ouvia que nao tinha sido entendida.
 *
 * Agora: se a mensagem casa com uma resposta pronta, ela vem primeiro e a
 * pergunta da etapa e repetida logo abaixo, para a conversa continuar de onde
 * parou. Sem casar com nada, o "Nao entendi" de sempre.
 *
 * A etapa nao muda em nenhum dos dois casos: responder uma duvida no meio do
 * caminho nao pode tirar a pessoa do lugar onde ela estava.
 *
 * SINTOMA TEM TRATAMENTO PROPRIO, e vem antes de tudo.
 *
 * A frase que explica por que o robo nao orienta sobre sintoma existia so no
 * caminho de quem escrevia sem etapa aberta. Depois de ver o menu, ou no meio
 * do agendamento, "meu filho esta vomitando sangue desde ontem" recebia
 * "Nao entendi. Responda com o numero da opcao" - a mae corrigida sobre a
 * forma de responder, e ninguem avisado. E gastropediatria: hematemese chega
 * escrita assim, e pediuUrgencia (/urgen/) nao pega nada disso.
 *
 * Estando aqui, vale para TODAS as etapas de uma vez, que e onde o defeito
 * estava. A etapa continua de pe: a pergunta e repetida logo abaixo, e quem
 * quiser gente digita 3 ou 9, como o robo diz.
 */
async function naoEntendi(
  admin: Admin,
  clinicId: string,
  texto: string,
  pergunta: string,
): Promise<string> {
  if (assuntoClinico(texto)) {
    return (
      'Sobre sintomas, remédios e o que fazer, quem responde é o Dr. Rafael ou alguém ' +
      'da equipe - por aqui eu não posso orientar. Digite *9* para falar com a equipe.\n\n' +
      pergunta
    )
  }
  const achada = acharResposta(texto, await carregarRespostas(admin, clinicId))
  // O texto curto da propria resposta, e nao a pergunta "Santos, SP ou
  // telemedicina?" dos assuntos marcados: fazer outra pergunta a quem ja esta
  // respondendo uma seria trocar uma confusao por outra.
  return achada ? `${achada.resposta}\n\n${pergunta}` : `Não entendi. ${pergunta}`
}

async function perguntarLocalDasInformacoes(
  admin: Admin,
  clinicId: string,
  conversationId: string,
  textoGeral: string,
): Promise<Resultado> {
  const lugares = await opcoesDeAtendimento(admin, clinicId)

  if (lugares.length <= 1) {
    return await responderInformacoes(admin, clinicId, conversationId, lugares[0]?.id ?? '', textoGeral)
  }

  const linhas = lugares.map((u, i) => `*${i + 1}* ${u.name}`).join('\n')
  await salvarEstado(admin, conversationId, {
    booking_state: 'informacoes_unidade',
    booking_options: lugares.map((u) => u.id),
    booking_unit_id: null,
  })
  return {
    resposta:
      `💬 Para qual atendimento você quer informações?\n\n${linhas}\n\n` +
      `Responda com o número. ${SAIDAS}`,
    lista: {
      rotulo: 'Escolher',
      linhas: comVoltar(lugares.map((u, i) => ({ id: String(i + 1), titulo: u.name }))),
    },
  }
}

async function responderInformacoes(
  admin: Admin,
  clinicId: string,
  conversationId: string,
  lugarId: string,
  textoGeral: string,
): Promise<Resultado> {
  // Os OUTROS lugares, para a linha "Outra unidade" dizer para onde ela leva.
  //
  // Antes ela mostrava o lugar que a pessoa acabou de ler ("Você viu: Santos"),
  // que e a unica informacao que ela ja tem. Quem toca ali quer saber de outro
  // lugar, entao e o nome do outro lugar que precisa aparecer.
  const outros = (await opcoesDeAtendimento(admin, clinicId)).filter((l) => l.id !== lugarId)
  // 72 caracteres e o limite da descricao na lista do WhatsApp. Passou disso, a
  // Meta recusa a mensagem inteira - melhor uma frase generica do que nenhuma
  // resposta.
  const nomesDosOutros = outros.map((l) => l.name).join(' ou ')
  const descricaoOutros =
    nomesDosOutros && nomesDosOutros.length <= 72 ? nomesDosOutros : 'Ver os outros atendimentos'

  let informacoes = ''
  if (lugarId === TELE_ID) {
    const tele = await telemedicinaDaClinica(admin, clinicId)
    informacoes = tele.informacoes
  } else if (lugarId) {
    const unidade = await unidadePorId(admin, lugarId)
    informacoes = (unidade?.info_text ?? '').trim()
  }
  // O fecho comum vai no fim de qualquer lugar: como agendar, como falar com
  // a equipe, telefones, horario. E o mesmo para todos, editado uma vez so.
  // Sem texto da unidade nem fecho, volta ao menu em vez de mandar vazio.
  const fecho = textoGeral.trim()
  // Uma linha fina entre as duas partes. O que vem antes e daquele lugar
  // (valor, endereco, o que levar); o que vem depois vale para todos. Sem a
  // separacao, a mensagem parecia uma lista so, e o olho lia "estacionamento"
  // e "telefones" com o mesmo peso. Traco leve de proposito: o pesado (━) ja e
  // usado no comprovante da consulta, e dois riscos iguais em mensagens
  // diferentes tiram o significado do primeiro.
  const corpo =
    informacoes && fecho
      ? `${informacoes}\n\n──────────────\n\n${fecho}`
      : [informacoes, fecho].filter(Boolean).join('\n\n')
  if (!corpo) {
    return await mostrarMenu(admin, conversationId, 'Olá!')
  }

  // Segue em 'menu': assim a pessoa le os valores e responde 2 na hora.
  await salvarEstado(admin, conversationId, {
    booking_state: 'menu',
    booking_options: null,
    booking_unit_id: null,
  })
  // Quem le sobre telemedicina pode estar com pressa: a saida de urgencia
  // aparece aqui mesmo, e nao so depois de entrar no agendamento.
  const tele = lugarId === TELE_ID
  // Sem outro lugar, nao se oferece "outra unidade".
  //
  // Com um atendimento so, o *1* levava de volta a mesmissima mensagem, que
  // convidava de novo a ver "outra unidade" - digita 1, le o mesmo texto,
  // digita 1, le o mesmo texto. E o laco que custou o atendimento de
  // 19/09/2026, na versao de quem tem uma unidade cadastrada.
  const temOutros = outros.length > 0
  return {
    resposta:
      `${corpo}\n\n` +
      // Curta de proposito: o fecho ja explica o 2 e o 3 com contexto.
      (temOutros
        ? 'Digite *1* para ver outra unidade ou *0* para ver todas as opções.'
        : 'Digite *0* para voltar ao início.') +
      (tele ? '\n\n🚨 Se for *urgência*, digite URGÊNCIA: a equipe entra em contato o mais rápido possível.' : ''),
    // Quem acabou de ler o preco e exatamente quem esta pronto para marcar.
    lista: {
      rotulo: 'Ver opções',
      linhas: [
        { id: '2', titulo: 'Marcar uma consulta', descricao: 'Consulta nova ou retorno · unidade, dia e horário' },
        ...(tele ? [{ id: 'URGENCIA', titulo: '🚨 É urgência', descricao: 'Falar com a equipe agora' }] : []),
        ...(temOutros ? [{ id: '1', titulo: 'Outra unidade', descricao: descricaoOutros }] : []),
        { id: '9', titulo: 'Falar com a equipe', descricao: 'Alguém do consultório responde' },
        { id: '0', titulo: 'Voltar ao menu' },
      ],
    },
  }
}

/** Quantas respostas prontas o robo da enquanto a equipe nao assume. */
const LIMITE_NA_ESPERA = 3

async function chamarEquipe(admin: Admin, conversationId: string): Promise<Resultado> {
  await salvarEstado(admin, conversationId, {
    booking_state: 'atendente',
    booking_options: null,
    booking_unit_id: null,
    // Cada espera comeca com o contador limpo: quem entrou na fila hoje nao
    // paga pelas perguntas que fez semana passada.
    auto_replies_while_waiting: 0,
  })
  // O primeiro paragrafo diz o que esta acontecendo agora; o segundo da uma
  // tarefa util para o tempo de espera; o terceiro diz quando esperar resposta.
  // Sem os tres, "vou te transferir" vira promessa vaga.
  return {
    resposta:
      'Estou direcionando você para um atendente da clínica.\n\n' +
      'Pode já escrever sua dúvida por aqui: a pessoa que assumir o atendimento ' +
      'vai ler tudo antes de responder.\n\n' +
      'Atendemos de segunda a sexta, das 8h às 18h. Fora desse horário, ' +
      'respondemos no próximo dia útil.\n\n' + VOLTA,
    atencao: 'atendente',
  }
}

// ---------------------------------------------------------------
// Opcao 4: minha consulta
// ---------------------------------------------------------------

function descreverConsulta(c: ConsultaMarcada, timezone: string) {
  const linhas = [formatarData(c.inicio, timezone), c.unidade]
  if (c.endereco) linhas.push(c.endereco)
  if (c.paciente) linhas.unshift(c.paciente)
  if (!c.confirmada) linhas.push('(aguardando confirmação da equipe)')
  return linhas.join('\n')
}

async function mostrarMinhaConsulta(
  admin: Admin,
  clinicId: string,
  conversationId: string,
  consultas: ConsultaMarcada[],
): Promise<Resultado> {
  const timezone = await fusoDaClinica(admin, clinicId)

  if (consultas.length === 0) {
    await salvarEstado(admin, conversationId, { booking_state: 'menu' })
    return {
      resposta:
        'Não encontrei nenhuma consulta marcada para este número.\n\n' +
        'Digite *2* para agendar, ou *0* para ver as opções.',
      lista: {
        rotulo: 'Ver opções',
        linhas: [
          { id: '2', titulo: 'Marcar uma consulta', descricao: 'Consulta nova ou retorno · unidade, dia e horário' },
          { id: '9', titulo: 'Falar com a equipe' },
          { id: '0', titulo: 'Voltar ao menu' },
        ],
      },
    }
  }

  await salvarEstado(admin, conversationId, {
    booking_state: 'minha_consulta',
    booking_options: consultas.map((c) => c.id),
  })

  if (consultas.length === 1) {
    return {
      resposta:
        `Sua consulta:\n\n${descreverConsulta(consultas[0], timezone)}\n\n` +
        'Digite CANCELAR para desmarcar, REMARCAR para trocar a data, ou 0 para voltar.',
      botoes: [
        { id: 'REMARCAR', titulo: 'Remarcar' },
        { id: 'CANCELAR', titulo: 'Cancelar consulta' },
        { id: 'MENU', titulo: 'Voltar ao menu' },
      ],
    }
  }

  const linhas = consultas
    .map((c, i) => `*${i + 1}* ${formatarData(c.inicio, timezone)} · ${c.unidade}`)
    .join('\n')
  return {
    resposta:
      `Você tem ${consultas.length} consultas marcadas:\n\n${linhas}\n\n` +
      'Responda com o número da que quer cancelar ou remarcar, ou *0* para voltar.',
    lista: {
      rotulo: 'Escolher consulta',
      linhas: comVoltar(
        consultas.map((c, i) => ({
          id: String(i + 1),
          titulo: formatarData(c.inicio, timezone).slice(0, 24),
          descricao: c.unidade.slice(0, 72),
        })),
      ),
    },
  }
}

/** Cancelamento e destrutivo: nunca acontece sem um sim explicito. */
async function pedirConfirmacaoCancelamento(
  admin: Admin,
  clinicId: string,
  conversationId: string,
  consulta: ConsultaMarcada,
  remarcar: boolean,
): Promise<Resultado> {
  const timezone = await fusoDaClinica(admin, clinicId)
  await salvarEstado(admin, conversationId, {
    booking_state: 'confirmar_cancelamento',
    booking_options: [consulta.id],
    booking_replaces_id: remarcar ? consulta.id : null,
  })
  return {
    resposta:
      (remarcar
        ? 'Vamos remarcar esta consulta:\n\n'
        : 'Confirma o cancelamento desta consulta?\n\n') +
      `${descreverConsulta(consulta, timezone)}\n\n` +
      (remarcar
        ? 'Responda SIM para escolher a nova data. A consulta atual só será cancelada depois que a nova estiver marcada.'
        : 'Responda SIM para cancelar, ou 0 para deixar como está.'),
    botoes: [
      { id: 'SIM', titulo: remarcar ? 'Sim, escolher data' : 'Sim, cancelar' },
      { id: 'MENU', titulo: 'Não, manter' },
    ],
  }
}

async function cancelarConsulta(admin: Admin, appointmentId: string) {
  const { error } = await admin
    .from('appointments')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', appointmentId)
    .eq('status', 'scheduled')
  if (error) console.error('Falha ao cancelar consulta', { appointmentId, error })
  return !error
}

// ---------------------------------------------------------------
// Opcao 2: agendar
// ---------------------------------------------------------------

/**
 * Primeira etapa quando o telefone atende a mais de um paciente.
 *
 * Numa gastropediatria e o caso comum: a mae cadastra os dois filhos com o
 * proprio celular. Sem esta pergunta o sistema escolhia sozinho e marcava a
 * consulta no nome do irmao errado.
 */
async function perguntarPaciente(
  admin: Admin,
  conversationId: string,
  pacientes: Paciente[],
): Promise<Resultado> {
  const linhas = pacientes.map((p, i) => `*${i + 1}* ${p.name}`).join('\n')

  await salvarEstado(admin, conversationId, {
    booking_state: 'aguardando_paciente',
    booking_options: pacientes.map((p) => p.id),
    booking_unit_id: null,
    booking_patient_id: null,
  })

  return {
    resposta:
      `👶 *Vamos agendar!* Para quem é a consulta?\n\n${linhas}\n\n` +
      `Responda com o número. ${SAIDAS}`,
    // Era a unica etapa sem lista tocavel: quem chegava aqui tinha de digitar,
    // enquanto nas telas seguintes bastava tocar. A troca de gesto no meio do
    // caminho e o tipo de coisa que faz a pessoa achar que travou.
    lista: {
      rotulo: 'Escolher paciente',
      linhas: comVoltar(
        pacientes.map((p, i) => ({ id: String(i + 1), titulo: p.name.slice(0, 24) })),
      ),
    },
  }
}

/**
 * Entrada do agendamento. Pergunta o paciente antes de tudo quando ha mais de
 * um no mesmo telefone; caso contrario segue direto para a unidade.
 */
async function iniciarAgendamento(
  admin: Admin,
  clinicId: string,
  conversationId: string,
  pacientes: Paciente[],
  consultas: ConsultaMarcada[] = [],
  jaAvisouDaOutra = false,
): Promise<Resultado> {
  // Ja existe consulta futura para este telefone. Seguir direto para as datas
  // produziria uma segunda consulta em silencio - e na maioria das vezes a
  // pessoa queria justamente trocar a data da que ja tem.
  if (consultas.length > 0 && !jaAvisouDaOutra) {
    const timezone = await fusoDaClinica(admin, clinicId)
    await salvarEstado(admin, conversationId, {
      booking_state: 'ja_tem_consulta',
      booking_options: [consultas[0].id],
      booking_replaces_id: null,
    })
    return {
      resposta:
        `Você já tem uma consulta marcada:\n\n${descreverConsulta(consultas[0], timezone)}\n\n` +
        'O que você prefere?\n\n' +
        '1 - Remarcar (trocar por outra data)\n' +
        '2 - Marcar mais uma consulta, além dessa\n\n' +
        VOLTA,
      botoes: [
        { id: '1', titulo: 'Remarcar essa' },
        { id: '2', titulo: 'Marcar mais uma' },
        { id: 'MENU', titulo: 'Voltar ao menu' },
      ],
    }
  }

  if (pacientes.length > 1) {
    return await perguntarPaciente(admin, conversationId, pacientes)
  }
  await salvarEstado(admin, conversationId, {
    booking_patient_id: pacientes[0]?.id ?? null,
  })
  return await perguntarUnidade(admin, clinicId, conversationId)
}

async function perguntarUnidade(
  admin: Admin,
  clinicId: string,
  conversationId: string,
): Promise<Resultado> {
  const unidades = await opcoesDeAtendimento(admin, clinicId)

  if (unidades.length === 0) {
    return {
      resposta:
        'Ainda não temos unidades publicadas para agendamento por aqui.\n\n' + SAIDAS,
      atencao: 'atendente',
    }
  }

  // Uma unidade so: nao faz sentido perguntar qual, mas o convenio continua
  // valendo - e ele e justamente o caso de uma clinica com unidade unica.
  if (unidades.length === 1) {
    const plano = (unidades[0].accepts_insurance ?? '').trim()
    if (plano) return await perguntarConvenioOuDia(admin, clinicId, conversationId, unidades[0])
    return await perguntarDia(admin, clinicId, conversationId, unidades[0], false)
  }

  // Consulta a agenda de cada unidade antes de listar. Custa uma chamada por
  // unidade, mas evita o pior roteiro possivel: a pessoa escolhe, espera, e
  // descobre que ali nao tinha nada.
  const comAgenda = await Promise.all(
    unidades.map(async (u) => ({ unidade: u, ...(await horariosLivres(admin, clinicId, u.id)) })),
  )

  if (comAgenda.every((u) => u.falhou)) {
    await limparEstado(admin, conversationId)
    return { resposta: AVISO_FALHA, atencao: 'falha' }
  }

  const abertas = comAgenda.filter((u) => u.horarios.length > 0)

  if (abertas.length === 0) {
    await limparEstado(admin, conversationId)
    return {
      resposta:
        'No momento não temos horários abertos para agendamento pelo WhatsApp.\n\n' + SAIDAS,
      atencao: 'atendente',
    }
  }

  // "Sem horários" e "não consegui ver a agenda" são coisas diferentes, e
  // dizer a primeira quando foi a segunda é mentira com consequência: a agenda
  // de Santos pode estar cheia de vagas, o RPC ter falhado, e a família ler que
  // Santos não tem nada - escolhe São Paulo, ou desiste. horariosLivres separa
  // os dois casos justamente para isso; era aqui que a distinção se perdia.
  const rotuloDaAgenda = (u: { horarios: Horario[]; falhou?: boolean }) =>
    u.horarios.length > 0
      ? `${u.horarios.length} horário${u.horarios.length === 1 ? '' : 's'} livre${u.horarios.length === 1 ? '' : 's'}`
      : u.falhou
        ? 'não consegui ver a agenda agora'
        : 'sem horários no momento'

  const linhas = comAgenda
    .map((u, i) => `*${i + 1}* ${u.unidade.name} (${rotuloDaAgenda(u)})`)
    .join('\n')

  await salvarEstado(admin, conversationId, {
    booking_state: 'aguardando_unidade',
    booking_options: unidades.map((u) => u.id),
    booking_unit_id: null,
    // A modalidade cai junto com a unidade.
    //
    // A unidade em andamento e DERIVADA da modalidade: com 'telemedicina'
    // gravada, o resto do fluxo ignora booking_unit_id e trata tudo como
    // video. Quem escolheu telemedicina, voltou ao menu e escolheu Santos
    // saia com uma consulta por video marcada numa unidade fisica - a familia
    // indo ao endereco e o Dr. Rafael esperando na tela.
    //
    // Reaparecer a pergunta "em qual unidade?" e o momento certo de esquecer:
    // ninguem escolheu nada ainda.
    booking_modality: null,
  })

  return {
    resposta:
      `📍 *Vamos agendar!* Em qual unidade você prefere ser atendido?\n\n${linhas}\n\n` +
      `Responda com o número. ${SAIDAS}`,
    lista: {
      rotulo: 'Escolher unidade',
      linhas: comVoltar(comAgenda.map((u, i) => ({
        id: String(i + 1),
        titulo: u.unidade.name,
        descricao: rotuloDaAgenda(u),
      }))),
    },
  }
}

/** Primeira etapa da agenda: em que dia. */
/**
 * Pergunta o convenio antes das datas, quando a unidade aceita algum.
 *
 * Vem ANTES de escolher dia e horario de proposito. Perguntar depois seria
 * perguntar a quem ja escolheu, e quem tem o plano pode preferir outro dia
 * para usar o convenio; e perguntar antes da unidade nao faz sentido, porque
 * o plano vale numa unidade e nao na outra.
 *
 * Unidade sem convenio cadastrado pula direto. E a telemedicina tambem, por
 * construcao: ela nao tem linha em clinic_units, entao nunca tem o campo.
 */
async function perguntarConvenioOuDia(
  admin: Admin,
  clinicId: string,
  conversationId: string,
  unidade: Unidade,
): Promise<Resultado> {
  const plano = (unidade.accepts_insurance ?? '').trim()
  if (!plano) return await perguntarDia(admin, clinicId, conversationId, unidade)

  await salvarEstado(admin, conversationId, {
    booking_state: 'aguardando_convenio',
    booking_unit_id: unidade.id,
    booking_options: null,
    // Unidade com convenio e unidade fisica - a telemedicina nem tem linha em
    // clinic_units. Gravar a modalidade aqui fecha o caminho de volta: quem
    // passou pela telemedicina antes nao carrega o 'telemedicina' para dentro
    // de uma consulta presencial.
    booking_modality: 'presencial',
  })

  return {
    resposta:
      `💳 Esta consulta vai ser pelo convênio *${plano}* ou *particular*?\n\n` +
      `*1* ${plano}\n` +
      '*2* Particular\n\n' +
      'Responda com o número, ou toque no botão.',
    botoes: [
      { id: '1', titulo: plano.slice(0, 20) },
      { id: '2', titulo: 'Particular' },
    ],
  }
}

async function perguntarDia(
  admin: Admin,
  clinicId: string,
  conversationId: string,
  unidade: Unidade,
  /** Falso quando a clinica so tem uma unidade: nao existe "outra" para trocar. */
  podeTrocarUnidade = true,
): Promise<Resultado> {
  const timezone = await fusoDaClinica(admin, clinicId)
  const { horarios, falhou } = await horariosLivres(admin, clinicId, unidade.id)
  const tele = unidade.id === TELE_ID

  if (falhou) {
    await limparEstado(admin, conversationId)
    return { resposta: AVISO_FALHA, atencao: 'falha' }
  }

  if (horarios.length === 0) {
    if (!podeTrocarUnidade) {
      await limparEstado(admin, conversationId)
      return {
        resposta:
          `No momento não temos horários abertos em ${unidade.name}.\n\n` + SAIDAS,
        atencao: 'atendente',
      }
    }
    // Continua em aguardando_unidade: assim o proximo numero ja escolhe outra
    // unidade, sem obrigar a recomecar.
    return {
      resposta:
        `No momento não temos horários abertos em ${unidade.name}.\n\n` +
        'Você pode responder com o número de outra unidade da lista acima.\n' + SAIDAS,
    }
  }

  const dias = agruparPorDia(horarios, timezone)
  // Na telemedicina uma das oito linhas e a urgencia, entao cabem sete dias.
  const mostrados = dias.slice(0, tele ? MAX_DIAS - 1 : MAX_DIAS)

  const linhas = mostrados
    .map((d, i) => {
      const quantos = d.horarios.length
      return `*${i + 1}* ${formatarDia(d.horarios[0].inicio, timezone)} (${quantos} ${
        quantos === 1 ? 'horário' : 'horários'
      })`
    })
    .join('\n')

  // A telemedicina nao tem unidade no banco: a modalidade e que guarda a
  // escolha, e o horario, quando vier, diz de qual unidade fisica saiu.
  await salvarEstado(admin, conversationId, {
    booking_state: 'aguardando_dia',
    booking_options: mostrados.map((d) => d.chave),
    booking_unit_id: tele ? null : unidade.id,
    booking_modality: tele ? 'telemedicina' : 'presencial',
  })

  // Sem agenda alem da quinzena nao adianta prometer: quem precisa de data
  // distante fala com a equipe, que enxerga o calendario inteiro.
  const rodape = podeTrocarUnidade
    ? 'Digite VOLTAR para escolher outra unidade, *9* se precisar de uma data mais distante, ou *0* para o início.'
    : 'Digite *9* se precisar de uma data mais distante, ou *0* para o início.'

  // Na telemedicina existe a saida de urgencia: quem nao pode esperar um
  // horario da lista fala com a equipe agora, e a conversa sobe na fila.
  const urgencia = tele
    ? '\n\n🚨 Se for *urgência*, digite URGÊNCIA: a nossa equipe entra em contato o mais rápido possível.'
    : ''

  const linhasDaLista = mostrados.map((d, i) => ({
    id: String(i + 1),
    titulo: formatarDia(d.horarios[0].inicio, timezone),
    descricao: `${d.horarios.length} horário${d.horarios.length === 1 ? '' : 's'}`,
  }))

  return {
    resposta:
      `🗓️ *Datas disponíveis${tele ? ' para telemedicina' : ` em ${unidade.name}`}:*\n\n${linhas}\n\n` +
      `Responda com o número do dia.\n${rodape}${urgencia}`,
    lista: {
      rotulo: 'Escolher o dia',
      linhas: comVoltar(
        tele
          ? [...linhasDaLista, { id: 'URGENCIA', titulo: '🚨 É urgência', descricao: 'Falar com a equipe agora' }]
          : linhasDaLista,
      ),
    },
  }
}

/**
 * Urgencia na telemedicina: o robo para de marcar e chama gente.
 *
 * Nao e a mesma coisa que "falar com a equipe". Quem pediu urgencia esta com
 * uma crianca passando mal e precisa ouvir que alguem vai ligar agora - e a
 * conversa precisa saltar na lista da recepcao com uma bandeira propria.
 */
async function transferirUrgencia(admin: Admin, conversationId: string): Promise<Resultado> {
  await salvarEstado(admin, conversationId, {
    booking_state: 'atendente',
    booking_options: null,
    booking_unit_id: null,
    booking_modality: null,
  })
  return {
    resposta:
      '🚨 Entendi que é urgência. Estou transferindo você para um atendente do ' +
      'consultório, e a nossa equipe vai entrar em contato com urgência por aqui.\n\n' +
      'Se puder, já escreva o que está acontecendo com o paciente: a pessoa que ' +
      'assumir o atendimento lê tudo antes de responder.\n\n' +
      'Se for uma emergência com risco de vida, procure o pronto-socorro mais próximo ou ligue 192.',
    atencao: 'urgencia',
  }
}

/** Segunda etapa: a que horas, dentro do dia escolhido. */
async function perguntarHorario(
  admin: Admin,
  clinicId: string,
  conversationId: string,
  unitId: string,
  diaEscolhido: string,
): Promise<Resultado> {
  const timezone = await fusoDaClinica(admin, clinicId)
  const { horarios, falhou } = await horariosLivres(admin, clinicId, unitId)
  const tele = unitId === TELE_ID

  if (falhou) {
    await limparEstado(admin, conversationId)
    return { resposta: AVISO_FALHA, atencao: 'falha' }
  }

  const doDia = horarios
    .filter((h) => chaveDoDia(h.inicio, timezone) === diaEscolhido)
    .slice(0, MAX_HORARIOS_DIA)

  if (doDia.length === 0) {
    // Alguem ocupou o dia inteiro entre a listagem e a escolha. Volta um passo
    // em vez de encerrar.
    const unidade = await unidadePorId(admin, unitId)
    if (!unidade) {
      await limparEstado(admin, conversationId)
      return { resposta: AVISO_FALHA, atencao: 'falha' }
    }
    return await perguntarDia(admin, clinicId, conversationId, unidade)
  }

  const linhas = doDia.map((h, i) => `*${i + 1}* ${formatarHora(h.inicio, timezone)}`).join('\n')

  await salvarEstado(admin, conversationId, {
    booking_state: 'aguardando_horario',
    booking_options: doDia,
    booking_unit_id: tele ? null : unitId,
    booking_modality: tele ? 'telemedicina' : 'presencial',
  })

  return {
    // Acima de dez a lista tocavel nao cabe, e a mensagem numerada continua
    // valendo sozinha - por isso o `lista` sai condicional, e nao truncado.
    // Uma das dez linhas fica para a volta, entao o dia so vira lista quando
    // couberem nove horarios. Acima disso a mensagem numerada resolve sozinha.
    ...(doDia.length <= MAX_TOQUES - 1
      ? {
          lista: {
            rotulo: 'Escolher horário',
            linhas: comVoltar(
              doDia.map((h, i) => ({
                id: String(i + 1),
                titulo: formatarHora(h.inicio, timezone),
              })),
            ),
          },
        }
      : {}),
    resposta:
      `⏰ *Horários de ${formatarDia(doDia[0].inicio, timezone)}:*\n\n${linhas}\n\n` +
      'Responda com o número do horário.\n' +
      'Digite VOLTAR para escolher outro dia, *9* para falar com a nossa equipe, ou *0* para o início.',
  }
}

async function marcar(
  admin: Admin,
  clinicId: string,
  conversationId: string,
  unitId: string,
  paciente: Paciente | null,
  telefone: string,
  nomeDoPerfil: string,
  slot: Horario,
  /** Consulta antiga a cancelar assim que a nova entrar (remarcacao). */
  substitui: string | null = null,
  /** Convenio escolhido na conversa. Vazio = particular. */
  convenio = '',
): Promise<Resultado> {
  // Telemedicina: a consulta e gravada na unidade fisica que cedeu o horario -
  // e o mesmo medico, no mesmo dia, entao o horario nao pode ficar livre la.
  // O que muda e a modalidade.
  const tele = unitId === TELE_ID
  const unidadeDoHorario = tele ? slot.unitId ?? null : unitId
  if (!unidadeDoHorario) {
    await voltarAoMenuAtivo(admin, conversationId)
    return {
      resposta:
        'Não consegui identificar a unidade desse horário. Digite *2* para ver os horários de novo, ou *0* para o início.',
    }
  }
  const unidade = await unidadePorId(admin, unidadeDoHorario)
  const timezone = await fusoDaClinica(admin, clinicId)


  // Lido antes de inserir, porque a antiga so e cancelada la embaixo - e depois
  // de cancelada continuaria legivel, mas depender disso seria contar com uma
  // ordem que pode mudar. A contagem da nova e a da antiga mais um.
  let vezesRemarcada = 0
  if (substitui) {
    const { data: anterior } = await admin
      .from('appointments')
      .select('reschedule_count')
      .eq('id', substitui)
      .maybeSingle()
    vezesRemarcada = (anterior?.reschedule_count ?? 0) + 1
  }

  const linhaDaConsulta: Record<string, unknown> = {
    clinic_id: clinicId,
    unit_id: unidadeDoHorario,
    modality: tele ? 'telemedicina' : 'presencial',
    patient_id: paciente?.id ?? null,
    starts_at: slot.inicio,
    ends_at: slot.fim,
    status: 'scheduled',
    source: 'whatsapp',
    // Sem cadastro, o nome do WhatsApp e tudo que a recepcao tem para saber
    // quem esta esperando confirmacao. Melhor do que so um numero de telefone.
    contact_name: paciente?.name || nomeDoPerfil || '',
    contact_phone: telefone,
    // Todo mundo sai daqui com consulta marcada, com ou sem cadastro.
    //
    // Antes quem nao tinha cadastro saia com uma reserva de 24h "aguardando
    // confirmacao". Na pratica isso trocava a certeza de quem acabou de marcar
    // por uma tarefa para a recepcao - e quem chegou pelo WhatsApp e
    // exatamente quem ainda nao conhece a clinica e mais precisa sair seguro.
    // O lembrete da vespera continua sendo a checagem de que a pessoa vem.
    confirmed_by_clinic: true,
    hold_expires_at: null,
    // Vazio quando e particular, que e o caso da maioria. A recepcao le isto na
    // Agenda e ja sabe se prepara a guia ou a maquininha.
    insurance: convenio,
    reschedule_count: vezesRemarcada,
    rescheduled_from: substitui,
  }

  /**
   * Colunas de appointments que nasceram depois de alguma versao desta funcao.
   *
   * Mesmo problema de COLUNAS_RECENTES, e mesma solucao - so que aqui o preco
   * de nao ter a defesa e maior. A funcao sobe antes das migrations; se o
   * banco ainda nao tem 'insurance', o Postgres recusa o INSERT INTEIRO e
   * TODO agendamento pelo WhatsApp passa a responder "nao consegui concluir o
   * agendamento agora", ate a migration chegar.
   *
   * Perder o convenio de uma consulta e um arranhao que a recepcao conserta na
   * chegada. Perder o agendamento e a familia sem horario.
   */
  const COLUNAS_RECENTES_DA_CONSULTA = ['insurance', 'rescheduled_from', 'reschedule_count']

  let { data: criada, error } = await admin
    .from('appointments').insert(linhaDaConsulta).select('id').maybeSingle()

  if (error && (error as { code?: string }).code === '42703') {
    const semAsNovas = { ...linhaDaConsulta }
    for (const coluna of COLUNAS_RECENTES_DA_CONSULTA) delete semAsNovas[coluna]
    console.warn('appointments sem alguma coluna recente; gravando sem ela', error)
    const segunda = await admin
      .from('appointments').insert(semAsNovas).select('id').maybeSingle()
    criada = segunda.data
    error = segunda.error
  }

  // Tambem termina oferecendo numero quando da errado, entao o menu fica ativo.
  if (error) await voltarAoMenuAtivo(admin, conversationId)
  else await limparEstado(admin, conversationId)

  if (error) {
    // 23505 = alguem pegou o mesmo horario entre a listagem e a escolha.
    if ((error as { code?: string }).code === '23505') {
      return {
        resposta:
          'Esse horário acabou de ser ocupado por outra pessoa.\n\n' +
          'Digite *2* para ver os horários atualizados, ou *0* para voltar ao início.',
        lista: {
          rotulo: 'Ver opções',
          linhas: [
            { id: '2', titulo: 'Ver horários atualizados' },
            { id: '9', titulo: 'Falar com a equipe' },
            { id: '0', titulo: 'Voltar ao menu' },
          ],
        },
      }
    }
    console.error('Falha ao marcar consulta', error)
    return {
      resposta:
        'Não consegui concluir o agendamento agora. Já avisei a nossa equipe, ' +
        'que entra em contato por aqui.\n\n' + VOLTA,
      atencao: 'falha',
    }
  }

  // A nova esta garantida: so agora a antiga cai. Fazer o contrario deixaria a
  // pessoa sem consulta nenhuma se ela desistisse no meio do caminho.
  let remarcou = false
  if (substitui) remarcou = await cancelarConsulta(admin, substitui)

  const quando = formatarData(slot.inicio, timezone)
  // Na telemedicina o endereco nao interessa; o que a pessoa precisa saber e
  // que a consulta e por video e que o link chega por aqui.
  const onde = tele
    ? 'Telemedicina, por vídeo. O link da consulta chega aqui pelo WhatsApp antes do horário.'
    : `${unidade?.name ?? 'nossa unidade'}${unidade?.address ? `\n${unidade.address}` : ''}`
  const aviso = remarcou ? '*Consulta remarcada!*' : '*Consulta marcada!*'

  // Esta mensagem e um comprovante, e nao uma etapa: e ela que a pessoa vai
  // rolar a conversa para reencontrar semanas depois, atras do endereco. Por
  // isso nao leva botao - rodape com botao faz parecer que ainda falta algo -
  // e os tres dados ganham icone, para saltarem numa olhada rapida.
  //
  // Asterisco simples e o negrito do WhatsApp. O aviso da vespera vem destacado
  // porque e a unica coisa que ainda se espera da pessoa.
  // Vaga garantida. So agora vem a ficha - e ela e opcional do primeiro ao
  // ultimo campo. Perguntar antes de marcar transformaria cinco perguntas em
  // cinco chances de perder o horario para outra pessoa.
  //
  // Pergunta o que falta, inclusive na remarcacao.
  //
  // Ate 16/09/2026 a remarcacao pulava a ficha inteira, com o comentario "os
  // dados ja vieram na primeira vez". Nao vieram: quem toca em "Voltar ao menu"
  // no meio das perguntas fica com a consulta marcada e a ficha vazia, e a
  // remarcacao virava a porta dos fundos para nunca mais responder nada. Foi o
  // caso do Sandro em 16/09: escolheu o horario, saiu na primeira pergunta,
  // remarcou em seguida e recebeu "Consulta remarcada!" sem cadastro nenhum.
  //
  // Paciente completo continua sem ser interrogado: camposQueFaltam devolve
  // lista vazia para quem ja tem tudo, remarcando ou nao.
  const faltam = camposQueFaltam(paciente)
  const comprovante =
    `✅ ${aviso}\n\n🗓️ ${quando}\n${tele ? "💻" : "📍"} ${onde}\n\n` +
    '*Um dia antes da consulta enviamos uma mensagem aqui pelo WhatsApp para ' +
    'você confirmar sua presença.*'

  if (faltam.length > 0 && criada?.id) {
    const abertura = await perguntarDados(admin, conversationId, criada.id, faltam)
    // Anuncia e ja pergunta, em vez de pedir licenca: "posso fazer algumas
    // perguntas?" convida a responder "nao" e deixa a conversa parada
    // esperando uma resposta que nao leva a lugar nenhum.
    const quantas =
      faltam.length === 1 ? 'uma pergunta rápida' : `${faltam.length} perguntas rápidas`
    // Nada de confirmacao aqui: a conversa abre com as perguntas e fecha com o
    // comprovante. Uma confirmacao no comeco e outra no fim soariam como duas
    // consultas, e e o comprovante do fim que a pessoa vai rolar para
    // reencontrar semanas depois, atras do endereco.
    return {
      ...abertura,
      resposta:
        `📋 Seu horário de *${quando}* está guardado.\n\n` +
        `Para completar o cadastro, ${quantas}.\n\n` +
        (abertura?.resposta ?? ''),
    }
  }

  return { resposta: `${comprovante}\n\n` + VOLTA }
}

/**
 * O que ainda falta perguntar.
 *
 * Sem cadastro, tudo: a consulta chegaria so com o nome do perfil do WhatsApp
 * e um telefone. Com cadastro, so os buracos - perguntar o nome de quem a
 * clinica atende ha dois anos soaria como se ninguem o conhecesse. Mas o CPF
 * costuma faltar mesmo em paciente antigo, e sem ele nao sai receita.
 */
function camposQueFaltam(paciente: Paciente | null): string[] {
  if (!paciente) return PERGUNTAS.map((p) => p.chave)
  const vazio = (valor?: string | null) => !String(valor ?? '').trim()
  return PERGUNTAS.filter((p) => {
    if (p.chave === 'nome') return false
    if (p.chave === 'nascimento') return vazio(paciente.nascimento)
    if (p.chave === 'responsavel') return vazio(paciente.responsavel)
    if (p.chave === 'cpf') return vazio(paciente.cpf)
    return vazio(paciente.email)
  }).map((p) => p.chave)
}


// ---------------------------------------------------------------
// Dados do paciente, perguntados DEPOIS de marcar
// ---------------------------------------------------------------

/**
 * As cinco perguntas, na ordem em que sao feitas.
 *
 * A ordem nao e a da ficha, e a da conversa: nome e nascimento saem de cabeca,
 * responsavel e quase sempre quem esta digitando, e o CPF - o unico que faz a
 * pessoa levantar da cadeira - vem no fim, quando a consulta ja esta marcada e
 * desistir da pergunta nao custa a vaga.
 */
const PERGUNTAS: {
  estado: Estado
  chave: 'nome' | 'nascimento' | 'responsavel' | 'cpf' | 'email'
  coluna: string
  /** Coluna equivalente no cadastro do paciente, quando existe. */
  colunaDoCadastro?: string
  texto: string
  /** Devolve o valor a guardar, ou null quando a resposta nao serve. */
  ler: (texto: string) => string | null
  /** Mensagem de quando nao serve. Na segunda tentativa a pergunta e pulada. */
  erro: string
  /**
   * Sem PULAR anunciado.
   *
   * Nome, nascimento e responsavel a familia sabe de cabeca, e sem eles o
   * cadastro nao serve para nada. CPF e e-mail sao os que fazem a pessoa
   * levantar da cadeira - esses continuam com a saida escrita na tela.
   *
   * "Obrigatoria" e sobre o que se pede, e nao sobre travar: 0 e 9 continuam
   * valendo, e depois de duas respostas que nao dao para usar o robo segue
   * adiante sozinho em vez de repetir a mesma pergunta para sempre.
   */
  obrigatoria?: boolean
  /** O proprio texto ja diz como pular, entao a linha generica nao entra. */
  jaExplicaOPular?: boolean
}[] = [
  {
    estado: 'dados_nome',
    chave: 'nome',
    obrigatoria: true,
    coluna: 'intake_patient_name',
    texto: '👤 Qual é o *nome completo do paciente*?',
    ler: (t) => (t.trim().length >= 2 ? t.trim().slice(0, 160) : null),
    erro: 'Não consegui ler o nome. Pode escrever de novo?',
  },
  {
    estado: 'dados_nascimento',
    chave: 'nascimento',
    obrigatoria: true,
    coluna: 'intake_birth_date',
    colunaDoCadastro: 'birth_date',
    texto: '🎂 Qual é a *data de nascimento* dele(a)? (dia/mês/ano)',
    // Guarda o que a pessoa escreveu quando nao e uma data redonda: "março de
    // 2019" diz muito mais para o medico do que um campo vazio.
    ler: (t) => (t.trim().length >= 3 ? t.trim().slice(0, 60) : null),
    erro: 'Não consegui ler a data. Pode escrever assim: 12/03/2019?',
  },
  {
    estado: 'dados_responsavel',
    chave: 'responsavel',
    obrigatoria: true,
    coluna: 'intake_guardian',
    colunaDoCadastro: 'guardian_name',
    texto: '👤 Qual é o *nome do responsável pelo contato*? Se for você, informe seu nome.',
    ler: (t) => (t.trim().length >= 2 ? t.trim().slice(0, 160) : null),
    erro: 'Não consegui ler o nome. Pode escrever de novo?',
  },
  {
    estado: 'dados_cpf',
    chave: 'cpf',
    coluna: 'intake_cpf',
    colunaDoCadastro: 'cpf',
    // Sem a linha generica de PULAR embaixo: este texto ja explica o pular, e
    // com contexto ("nao tem CPF, nao sabe agora"). Duas instrucoes coladas
    // dizendo a mesma coisa e o tipo de ruido que faz a pessoa parar de ler.
    texto:
      '🪪 Qual é o *CPF do paciente*?\n\n' +
      '_Ele é exigido por lei na receita digital. Se o paciente não tiver CPF, ' +
      'ou você não souber agora, responda PULAR._',
    jaExplicaOPular: true,
    ler: (t) => (cpfValido(t) ? soDigitos(t) : null),
    erro: 'Esse CPF não confere. Pode conferir e mandar de novo, ou responder PULAR.',
  },
  {
    estado: 'dados_email',
    chave: 'email',
    coluna: 'intake_email',
    colunaDoCadastro: 'email',
    texto:
      '✉️ Por fim, qual é o *e-mail* para enviarmos receitas e documentos?',
    ler: (t) => (emailValido(t) ? t.trim().slice(0, 160) : null),
    erro: 'Esse e-mail parece incompleto. Pode mandar de novo, ou responder PULAR.',
  },
]

function soDigitos(texto: string) {
  return texto.replace(/\D/g, '')
}

/**
 * CPF pelo digito verificador, e nao so pelo tamanho.
 *
 * Onze digitos quaisquer passariam - inclusive um telefone digitado por engano
 * no campo errado - e o erro so apareceria meses depois, na hora de emitir a
 * receita, com a familia longe.
 */
function cpfValido(texto: string) {
  const cpf = soDigitos(texto)
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false
  for (const [ate, posicao] of [[9, 10], [10, 11]] as const) {
    let soma = 0
    for (let i = 0; i < ate; i++) soma += Number(cpf[i]) * (posicao - i)
    const resto = (soma * 10) % 11 % 10
    if (resto !== Number(cpf[ate])) return false
  }
  return true
}

function emailValido(texto: string) {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(texto.trim())
}

/** "pular", "nao sei", "nao tenho": tudo que significa "segue sem isso". */
function pulou(texto: string) {
  const t = normalizar(texto)
  return (
    t === 'pular' || t === 'pula' || t === '-' || t === 'x' ||
    t === 'nao sei' || t === 'não sei' || t === 'nao tenho' || t === 'não tenho' ||
    t === 'nao lembro' || t === 'sem cpf' || t === 'nao possui' || t === 'depois'
  )
}

/** A fila guardada na conversa: o que falta e quantas tentativas ja houve. */
function filaDaFicha(opcoes: unknown): { tentativas: number; faltam: string[]; manual: boolean } {
  const bruto = opcoes as { tentativas?: number; faltam?: unknown; manual?: boolean } | null
  return {
    tentativas: Number(bruto?.tentativas ?? 0),
    faltam: Array.isArray(bruto?.faltam) ? (bruto?.faltam as string[]) : [],
    // Questionario disparado pela equipe, e nao pelo fim de um agendamento.
    manual: bruto?.manual === true,
  }
}

/**
 * O agradecimento final. Fecha a etapa e devolve o menu ativo.
 *
 * Diz o que fica pendente sem cobrar: quem nao soube o CPF ja ouviu uma vez que
 * pode responder depois, e repetir viraria pressao sobre quem justamente nao
 * podia resolver aquilo naquele momento.
 */
async function terminarDados(
  admin: Admin,
  conversationId: string,
  clinicId?: string,
  appointmentId?: string | null,
  /** Questionario disparado pela equipe: fecha sem comprovante. */
  manual = false,
): Promise<Resultado> {
  await salvarEstado(admin, conversationId, {
    booking_state: 'menu',
    booking_options: null,
    booking_intake_id: null,
  })

  // O cadastro nasce agora, com o que a familia acabou de digitar, e nao
  // depois que alguem da equipe clicar num botao. Se falhar, a vespera tenta
  // de novo: a consulta ja esta marcada de qualquer jeito.
  let virouCadastro = false
  if (clinicId && appointmentId) {
    try {
      const { data: consulta } = await admin
        .from('appointments')
        .select(
          'id,patient_id,starts_at,contact_name,contact_phone,' +
            'intake_patient_name,intake_birth_date,intake_guardian,intake_cpf,intake_email,' +
            'clinic_units(name)',
        )
        .eq('id', appointmentId)
        .maybeSingle()
      // O cliente do Deno nao consegue tipar select com tabela aninhada
      // (clinic_units(name)) e devolve um tipo de erro no lugar da linha. O
      // formato e o que ConsultaParaCadastro descreve, e e o proprio select
      // acima que garante isso.
      const ficha = consulta as unknown as ConsultaParaCadastro | null
      if (ficha && !ficha.patient_id) {
        virouCadastro = Boolean(await cadastrarDaFicha(admin, clinicId, ficha))
      }
    } catch (causa) {
      console.error('Nao consegui criar o cadastro a partir da ficha', causa)
    }
  }

  // O comprovante fecha a conversa. Remontado aqui, e nao guardado la atras,
  // porque entre a reserva e esta mensagem a familia respondeu varias vezes -
  // e o que vale e o estado da consulta agora.
  //
  // NUNCA no questionario manual. Ali a consulta usada e so o lugar onde as
  // respostas ficam penduradas, e pode ser uma que ja passou: em 16/09/2026 o
  // robo terminou o questionario anunciando "✅ Consulta marcada! segunda,
  // 14/09" - uma consulta de dois dias ANTES, que ninguem tinha acabado de
  // marcar. Comprovante e coisa de quem acabou de marcar.
  let comprovante = ''
  if (clinicId && appointmentId && !manual) {
    try {
      const { data: consulta } = await admin
        .from('appointments')
        .select('starts_at,modality,clinic_units(name,address)')
        .eq('id', appointmentId)
        .maybeSingle()
      // Consulta que ja passou nao vira comprovante, venha de onde vier.
      if (consulta && new Date(consulta.starts_at).getTime() > Date.now()) {
        const unidade = (Array.isArray(consulta.clinic_units)
          ? consulta.clinic_units[0]
          : consulta.clinic_units) as { name?: string; address?: string } | null
        const timezone = await fusoDaClinica(admin, clinicId)
        const tele = consulta.modality === 'telemedicina'
        const onde = tele
          ? 'Telemedicina, por vídeo. O link da consulta chega aqui pelo WhatsApp antes do horário.'
          : `${unidade?.name ?? 'nossa unidade'}${unidade?.address ? `\n${unidade.address}` : ''}`
        comprovante =
          `✅ *Consulta marcada!*\n\n🗓️ ${formatarData(consulta.starts_at, timezone)}\n${tele ? '💻' : '📍'} ${onde}\n\n` +
          '*Um dia antes da consulta enviamos uma mensagem aqui pelo WhatsApp para ' +
          'você confirmar sua presença.*\n\n'
      }
    } catch (causa) {
      console.error('Nao consegui remontar o comprovante', causa)
    }
  }

  return {
    resposta:
      '✅ *Tudo certo, obrigado!* Já anotamos os dados' +
      // "Na sua consulta" so quando a pessoa acabou de marcar uma. No
      // questionario manual a consulta e detalhe interno - quem leu "anotamos
      // na sua consulta" sem ter marcado nada sai procurando qual.
      (virouCadastro
        ? ' e seu cadastro está feito'
        : appointmentId && !manual
          ? ' na sua consulta'
          : ' no seu cadastro') +
      '.\n\n' +
      (comprovante ? `━━━━━━━━━━━━━━\n${comprovante}` : '') +
      VOLTA,
    // Fim da ficha: o robo perguntou tudo o que tinha para perguntar e a
    // familia respondeu. Vale tambem para o questionario que a equipe disparou,
    // que termina aqui do mesmo jeito - e cuja pendencia era justamente esta.
    concluida: true,
  }
}

/**
 * Recomeça o questionário do cadastro, a pedido da equipe.
 *
 * O caminho normal é o robô perguntar logo depois de marcar. Mas quem toca em
 * "Voltar ao menu" no meio, ou some, fica com a consulta marcada e a ficha
 * vazia - e aí só a recepção percebe, olhando a agenda na véspera. O botão
 * "Questionário" na tela de Respostas serve para essa hora: manda as perguntas
 * de novo, na conversa que já existe, sem ninguém ter de ligar.
 *
 * Devolve null quando não há o que perguntar, isto é, quando o cadastro já
 * está completo. Quem chamou avisa a equipe na tela, em vez de mandar mensagem
 * à toa para a família.
 */
export async function iniciarQuestionario(
  admin: Admin,
  conversationId: string,
  /**
   * A consulta onde pendurar as respostas, quando existe.
   *
   * Aceita null desde 16/09/2026. Antes exigia consulta FUTURA, e isso deixava
   * de fora justamente quem a equipe mais quer alcançar: o paciente antigo sem
   * CPF na ficha, que não tem nada marcado. Sem consulta, as respostas vão
   * direto para o cadastro.
   */
  consultaId: string | null,
  paciente: Paciente | null,
): Promise<{ resultado: Resultado; faltam: string[] } | null> {
  const faltam = camposQueFaltam(paciente)
  if (faltam.length === 0) return null

  // Deixa escrito de quem são as respostas. Sem consulta, é só isto que liga o
  // que a família vai digitar a uma ficha - e num telefone com dois irmãos
  // cadastrados, é o que impede o CPF de um cair no cadastro do outro.
  if (paciente) {
    await salvarEstado(admin, conversationId, { booking_patient_id: paciente.id })
  }

  const resultado = await perguntarDados(admin, conversationId, consultaId, faltam, '', true)
  return { resultado, faltam }
}

/**
 * Guarda a resposta e faz a proxima pergunta.
 *
 * Uma pergunta por mensagem, e nao um formulario de cinco linhas: no WhatsApp
 * um bloco com cinco campos volta pela metade, fora de ordem, e ninguem sabe
 * qual resposta e de qual campo.
 */
async function perguntarDados(
  admin: Admin,
  conversationId: string,
  /**
   * A consulta onde as respostas ficam penduradas, quando ha uma.
   *
   * Null quando a equipe disparou o questionario para alguem que ja tem ficha
   * mas nao tem consulta marcada: ai as respostas vao direto para o cadastro.
   */
  appointmentId: string | null,
  /** A fila do que falta, comecando pela pergunta a fazer agora. */
  faltam: string[],
  aviso = '',
  /**
   * Questionario disparado pela equipe, e nao pelo fim de um agendamento.
   *
   * Muda os botoes: sem "Voltar ao menu". No agendamento ele faz sentido - a
   * pessoa estava num fluxo e pode querer sair dele. Aqui ela nao estava em
   * fluxo nenhum: a clinica pediu quatro dados, e oferecer "voltar ao menu"
   * transforma um pedido curto numa porta de saida para o menu inteiro.
   * Quem quiser sair mesmo assim digita MENU ou 0, como em qualquer etapa.
   */
  manual = false,
): Promise<Resultado> {
  const pergunta = PERGUNTAS.find((p) => p.chave === faltam[0])
  if (!pergunta) return await terminarDados(admin, conversationId, undefined, null, manual)

  await salvarEstado(admin, conversationId, {
    booking_state: pergunta.estado,
    booking_intake_id: appointmentId,
    // A fila do que ainda falta, e as tentativas na pergunta atual. Na segunda
    // falha o robo segue em frente sozinho, em vez de prender quem nao tem
    // como responder.
    booking_options: { tentativas: 0, faltam, manual },
  })
  return {
    resposta:
      (aviso ? `${aviso}\n\n` : '') +
      pergunta.texto +
      (pergunta.obrigatoria || pergunta.jaExplicaOPular
        ? ''
        : '\n\n_Se preferir não responder agora, digite PULAR._'),
    botoes: pergunta.obrigatoria
      ? manual
        ? undefined
        : [{ id: 'MENU', titulo: 'Voltar ao menu' }]
      : manual
        ? [{ id: 'PULAR', titulo: 'Pular' }]
        : [
            { id: 'PULAR', titulo: 'Pular' },
            { id: 'MENU', titulo: 'Voltar ao menu' },
          ],
  }
}

/**
 * Grava uma resposta na consulta.
 *
 * Falha de escrita nao interrompe a conversa: a consulta ja esta marcada, e o
 * dado que nao entrou o medico pergunta no consultorio. Prender a pessoa numa
 * pergunta por causa de um erro nosso seria o pior dos dois mundos.
 */
async function guardarDado(
  admin: Admin,
  /** Null quando o questionario foi disparado sem consulta: so ficha. */
  appointmentId: string | null,
  pergunta: (typeof PERGUNTAS)[number],
  valor: string,
  paciente: Paciente | null,
) {
  if (appointmentId) {
    const { error } = await admin
      .from('appointments')
      .update({ [pergunta.coluna]: valor })
      .eq('id', appointmentId)
    if (error) console.error('Falha ao guardar dado do agendamento', { coluna: pergunta.coluna, error })
  }

  // Paciente ja cadastrado: o dado vai tambem para a ficha dele, que e de onde
  // a receita e o prontuario leem. So preenche buraco - nunca sobrescreve o que
  // a equipe digitou, porque isto aqui veio por mensagem e ninguem conferiu.
  if (!paciente || !pergunta.colunaDoCadastro) return
  const jaTem = String(
    (paciente as unknown as Record<string, unknown>)[pergunta.chave] ?? '',
  ).trim()
  if (jaTem) return

  // Data so quando e data: "marco de 2019" fica no agendamento, para alguem ler.
  let paraOCadastro: string = valor
  if (pergunta.chave === 'nascimento') {
    const m = valor.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
    if (!m) return
    paraOCadastro = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }

  const { error: erroDoCadastro } = await admin
    .from('patients')
    .update({ [pergunta.colunaDoCadastro]: paraOCadastro })
    .eq('id', paciente.id)
  if (erroDoCadastro) {
    console.error('Falha ao completar o cadastro', { campo: pergunta.chave, erroDoCadastro })
  }
}

// ---------------------------------------------------------------
// Opcao 5: 2a via de receita e pedido de exame
// ---------------------------------------------------------------

/**
 * O pedido sendo montado, guardado em booking_options entre uma pergunta e a
 * seguinte. O nome do paciente vai junto do id porque o comprovante precisa
 * escrever o nome, e reler o cadastro a cada passo seria consulta a toa.
 */
type PedidoDeDocumento = {
  pacienteId?: string | null
  paciente?: string
  tipo?: 'receita' | 'exame'
  item?: string
}

function pedidoEmAndamento(opcoes: unknown): PedidoDeDocumento {
  const bruto = opcoes as { pedido?: PedidoDeDocumento } | null
  return bruto?.pedido ?? {}
}

/** O nome do tipo como a pessoa leu no botao, para repetir igual no comprovante. */
const NOME_DO_TIPO = {
  receita: '💊 2ª via de receita',
  exame: '🔬 Pedido de exame',
} as const

/**
 * A pergunta de abertura, depois da portaria.
 *
 * Com mais de um paciente no telefone, perguntar de quem e o pedido vem antes
 * de tudo: a mae que cadastrou dois filhos nao pode receber "qual medicamento?"
 * sem que ninguem tenha dito de qual crianca se trata - e adivinhar a crianca
 * errada numa receita e pior do que uma pergunta a mais.
 */
async function perguntarDeQuemEOPedido(
  admin: Admin,
  conversationId: string,
  pacientes: Paciente[],
): Promise<Resultado> {
  if (pacientes.length === 1) {
    return await perguntarTipoDoDocumento(admin, conversationId, {
      pacienteId: pacientes[0].id,
      paciente: pacientes[0].name,
    })
  }

  const cabem = pacientes.slice(0, MAX_TOQUES - 2)
  await salvarEstado(admin, conversationId, {
    booking_state: 'documento_paciente',
    booking_options: { pedido: {}, pacientes: cabem.map((p) => p.id) },
  })
  return {
    resposta:
      'Para qual paciente é o pedido?\n\n' +
      cabem.map((p, i) => `*${i + 1}* ${p.name}`).join('\n') +
      `\n\n${SAIDAS}`,
    lista: {
      rotulo: 'Escolher paciente',
      linhas: comVoltar(cabem.map((p, i) => ({ id: String(i + 1), titulo: p.name }))),
    },
  }
}

async function perguntarTipoDoDocumento(
  admin: Admin,
  conversationId: string,
  pedido: PedidoDeDocumento,
): Promise<Resultado> {
  await salvarEstado(admin, conversationId, {
    booking_state: 'documento_tipo',
    booking_options: { pedido },
  })
  const dePara = pedido.paciente ? ` para *${pedido.paciente}*` : ''
  return {
    resposta:
      `O que você precisa${dePara}?\n\n` +
      '*1* 💊 2ª via de receita\n' +
      '*2* 🔬 Pedido de exame\n\n' +
      SAIDAS,
    botoes: [
      { id: '1', titulo: '2ª via de receita' },
      { id: '2', titulo: 'Pedido de exame' },
    ],
  }
}

/**
 * O passo da exigencia, e por que ele nao e burocracia.
 *
 * Foi o caso que o Dr. Rafael descreveu: o laboratorio devolve o pedido
 * porque o CID nao confere, a farmacia recusa a receita porque a validade
 * venceu. Sem essa linha ele recebe "preciso da receita da domperidona", refaz
 * exatamente igual, e a farmacia recusa de novo - ninguem falou o que estava
 * errado. A pergunta existe para o documento voltar certo na primeira vez.
 *
 * A foto vale mais que a explicacao: quem esta no balcao da farmacia costuma
 * repetir errado o que o atendente disse, e a imagem do que foi recusado mostra
 * sozinha. Por isso a mensagem convida, mas nao exige nenhum dos dois.
 */
async function perguntarExigencia(
  admin: Admin,
  conversationId: string,
  pedido: PedidoDeDocumento,
): Promise<Resultado> {
  await salvarEstado(admin, conversationId, {
    booking_state: 'documento_exigencia',
    booking_options: { pedido },
  })
  // Quem devolveu o documento muda com o tipo, e a pergunta precisa nomear a
  // pessoa certa: "a farmácia pediu correção no seu ultrassom?" faz a mae parar
  // para entender uma pergunta que nao era para ela.
  const quemRecusou =
    pedido.tipo === 'exame' ? 'O laboratório ou a clínica de exames' : 'A farmácia'
  return {
    resposta:
      `${quemRecusou} pediu alguma correção?\n\n` +
      'Se pediram, escreva o que foi. Se não, responda *não*.\n\n' +
      '📎 Se tiver foto do documento que não foi aceito, pode mandar aqui.',
    botoes: [{ id: 'não', titulo: 'Não pediram nada' }],
  }
}

/**
 * O comprovante, e o fim do caminho automatico.
 *
 * Ele repete o pedido inteiro de proposito. Para a familia, e a prova de que
 * foi entendido - sem isso a duvida "sera que registrou o medicamento certo?"
 * so se resolve esperando. Para a clinica, esta mensagem E o pedido: ela fica
 * como ultima mensagem da conversa, aparece na previa da lista, e poupa quem
 * abrir de subir a conversa inteira para descobrir o que foi pedido.
 *
 * Prazo com nome: "em breve" e o que a clinica sente, "1 dia util" e o que a
 * familia consegue esperar sem cobrar. Quem nao ganha prazo cobra em duas
 * horas, e a cobranca cai na mesma equipe que ainda nao teve tempo.
 */
async function registrarPedido(
  admin: Admin,
  conversationId: string,
  pedido: PedidoDeDocumento,
  exigencia: string,
): Promise<Resultado> {
  await salvarEstado(admin, conversationId, {
    booking_state: 'atendente',
    booking_options: null,
    auto_replies_while_waiting: 0,
  })
  const titulo = pedido.tipo ? NOME_DO_TIPO[pedido.tipo] : '📄 Documento'
  const linhas = [`${titulo}${pedido.paciente ? ` · ${pedido.paciente}` : ''}`]
  if (pedido.item) linhas.push(pedido.item)
  if (exigencia) linhas.push(`_Pediram correção:_ ${exigencia}`)

  return {
    resposta:
      '✅ Pedido registrado.\n\n' +
      linhas.join('\n') +
      // "revisar e responder", e nao "revisar e enviar".
      //
      // A portaria reconhece quem tem CADASTRO, e o cadastro nasce quando a
      // familia termina a ficha do agendamento - antes da consulta acontecer.
      // Quem marcou ontem passa por aqui e pediria 2a via de uma receita que
      // nunca existiu. Prometer o envio seria mandar essa pessoa esperar um
      // documento que nao ha; prometer a resposta e verdade nos dois casos, e
      // no caso comum - o que motivou tudo isto - a resposta E o documento.
      '\n\nA equipe do Instituto Clauzo encaminhará o pedido para avaliação médica e informará o prazo de resposta.\n\n' +
      VOLTA,
    atencao: 'documento',
  }
}

/**
 * A portaria: quem nunca consultou aqui.
 *
 * Nao e um beco. O numero desconhecido pode ser o pai usando o celular do
 * trabalho - e pode ser a farmacia ligando por causa da receita, que foi
 * justamente o caso que motivou tudo isto. As duas coisas precisam de caminho,
 * e caminhos diferentes.
 *
 * O que o robo NAO faz aqui, em nenhum dos dois: confirmar que fulano se trata
 * nesta clinica, mostrar cadastro, ou mandar documento. Isso e dado de saude, e
 * quem escreve de um numero que a clinica nunca viu nao provou ser ninguem.
 * Confirmar a pedido seria entregar prontuario para quem souber um nome.
 */
async function perguntarQuemPede(admin: Admin, conversationId: string): Promise<Resultado> {
  await salvarEstado(admin, conversationId, {
    booking_state: 'documento_quem',
    booking_options: null,
  })
  return {
    resposta:
      'A 2ª via é de documento emitido em consulta, e não localizei atendimento neste número.\n\n' +
      '*1* 👨‍👩‍👦 Sou o paciente ou responsável\n' +
      '*2* 🏥 Sou de farmácia ou laboratório\n\n' +
      SAIDAS,
    botoes: [
      { id: '1', titulo: 'Paciente/responsável' },
      { id: '2', titulo: 'Farmácia/laboratório' },
    ],
  }
}

async function perguntarPedidoDaFarmacia(
  admin: Admin,
  conversationId: string,
): Promise<Resultado> {
  await salvarEstado(admin, conversationId, {
    booking_state: 'documento_farmacia',
    booking_options: null,
  })
  return {
    resposta:
      'Certo. Me diga o *nome do paciente* e o que precisa ser corrigido no documento.\n\n' +
      '📎 Se puder, mande a foto do que foi recusado.',
  }
}

/**
 * Entrada da opcao 5.
 *
 * A portaria vem antes de qualquer pergunta: sem atendimento neste numero, o
 * fluxo do paciente nem comeca.
 */
async function iniciarDocumento(
  admin: Admin,
  conversationId: string,
  pacientes: Paciente[],
): Promise<Resultado> {
  if (pacientes.length === 0) return await perguntarQuemPede(admin, conversationId)
  return await perguntarDeQuemEOPedido(admin, conversationId, pacientes)
}

// ---------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------

/**
 * Decide a resposta automatica. Devolve null quando o robo deve ficar calado -
 * porque a equipe assumiu, porque a mensagem e resposta a um acompanhamento,
 * ou porque o menu ja foi mostrado ha pouco.
 */
export async function tratarConversa(opcoes: {
  admin: Admin
  clinicId: string
  conversationId: string
  estadoAtual: Estado | null
  opcoesAtuais: unknown
  unidadeEmAndamento: string | null
  /** 'telemedicina' quando a pessoa escolheu atendimento por video. */
  modalidadeEmAndamento?: Modalidade | null
  /**
   * Falso quando o robo nao deve puxar assunto: a pessoa esta respondendo um
   * acompanhamento, ou alguem da equipe escreveu ha pouco e a conversa e
   * humana. Quem calcula e o webhook, que tem o historico em maos.
   */
  podeIniciarMenu: boolean
  /**
   * A mensagem e um anexo: foto, documento, audio ou video.
   *
   * Quem manda a foto de um exame quer que alguem OLHE. Responder o menu a isso
   * e o robo dizendo "nao vi o que voce mandou, escolha uma opcao".
   */
  anexo?: boolean
  /**
   * O robo ja mostrou o menu nesta conversa.
   *
   * Falso na primeira mensagem de alguem. Enquanto for falso, atalho nenhum
   * pula a apresentacao: a pessoa precisa ver o que existe antes de ser levada
   * para dentro de um fluxo.
   */
  jaViuOMenu?: boolean
  /**
   * Quantas respostas prontas o robo ja deu nesta espera pela equipe.
   *
   * Passando de LIMITE_NA_ESPERA, ele para de responder ate alguem assumir a
   * conversa. Ausente vale zero: quem chama sem informar esta comecando a
   * contagem, e nao pulando o limite.
   */
  respostasNaEspera?: number
  texto: string
  telefone: string
  /**
   * Todos os pacientes cadastrados com este telefone, em ordem de nome. Vazio
   * quando ninguem foi reconhecido. Mais de um e o caso da mae com dois filhos.
   */
  pacientes: Paciente[]
  /** Paciente ja escolhido nesta conversa, quando a pergunta ja foi feita. */
  pacienteEmAndamento: string | null
  /** Consultas futuras ja marcadas para este telefone, da mais proxima em diante. */
  consultas: ConsultaMarcada[]
  /** Consulta a cancelar assim que a nova entrar, num fluxo de remarcacao. */
  consultaASubstituir: string | null
  /** Consulta recem-marcada cujos dados estao sendo perguntados. */
  consultaEmCadastro: string | null
  /** Convenio ja respondido neste agendamento. Vazio ou ausente = particular. */
  convenioEmAndamento?: string | null
  /** Nome que a pessoa usa no WhatsApp. Vazio quando o evento nao trouxe. */
  nomeDoPerfil: string
  textos: { saudacao: string; saudacaoConhecida: string; informacoes: string }
}): Promise<Resultado> {
  const { admin, clinicId, conversationId, estadoAtual, texto } = opcoes

  // A telemedicina nao tem id de unidade no banco; a modalidade e que diz que
  // a pessoa esta nesse caminho. Daqui para baixo as etapas so olham para
  // esta variavel, e nunca para a coluna crua.
  const unidadeEmAndamento =
    opcoes.modalidadeEmAndamento === 'telemedicina' ? TELE_ID : opcoes.unidadeEmAndamento

  // Chamar pelo nome so quando ha um paciente neste telefone. Com dois irmaos
  // cadastrados, usar o nome de um deles seria adivinhar - e adivinhar errado
  // metade das vezes.
  const unico = opcoes.pacientes.length === 1 ? opcoes.pacientes[0] : null
  const primeiroNome = (unico?.name ?? '').trim().split(/\s+/)[0] ?? ''
  const saudacao = (
    unico && opcoes.textos.saudacaoConhecida.trim()
      ? opcoes.textos.saudacaoConhecida.replace(/\{nome\}/g, primeiroNome)
      : opcoes.textos.saudacao
  ).trim() || 'Olá! 👋 Aqui é o consultório do Dr. Rafael Clauzo, Instituto Clauzo.'

  /** Quem vai no prontuario da consulta: o escolhido, ou o unico que existe. */
  const pacienteDaConsulta =
    opcoes.pacientes.find((p) => p.id === opcoes.pacienteEmAndamento) ?? unico ?? null

  // MENU vem antes de tudo, ate de "a equipe assumiu": e a saida de emergencia
  // que prometemos em toda mensagem, e promessa que falha uma vez nao vale.
  if (pediuMenu(texto)) {
    return await mostrarMenu(admin, conversationId, saudacao)
  }

  // Anexo: foto, documento, audio ou video.
  //
  // O robo nao le nada disso, e fingir que leu seria pior. Quem manda a foto de
  // um exame, uma receita antiga ou um audio contando o caso quer que uma
  // pessoa olhe. Ate 15/09/2026 a mensagem virava "[image]" e a resposta era o
  // menu inteiro: "como podemos ajudar hoje?" para quem acabou de mandar o
  // ultrassom do filho.
  //
  // Entrega para a equipe e diz que entregou. Se a conversa ja estava com a
  // equipe, silencio: a segunda foto nao precisa de outro "vou entregar".
  //
  // Vem antes do bloco da equipe para que o anexo de quem NAO estava na fila
  // entre nela, e depois do MENU para nao tirar a saida de emergencia de
  // ninguem.
  // Dentro do pedido de documento, a foto nunca cai na regra geral.
  //
  // A regra geral entrega o anexo a equipe e zera booking_options - o pedido
  // montado ate ali evapora. Em "o que foi recusado?" a foto E a resposta; nas
  // etapas anteriores ela e natural do mesmo jeito (a mae fotografa a receita
  // quando o robo pergunta o nome do remedio) e precisa ser recebida sem
  // derrubar o que ja foi respondido. Cada etapa trata a sua, mais abaixo.
  const noPedidoDeDocumento = Boolean(estadoAtual?.startsWith('documento_'))

  if (opcoes.anexo && !noPedidoDeDocumento) {
    if (estadoAtual === 'atendente') return null
    await salvarEstado(admin, conversationId, {
      booking_state: 'atendente',
      booking_options: null,
      booking_unit_id: null,
      auto_replies_while_waiting: 0,
    })
    return {
      resposta:
        '📎 Recebi o que você enviou e já avisei a nossa equipe: alguém do consultório vai olhar e responder por aqui.\n\n' +
        'Se quiser, escreva junto o que é e o que você gostaria de saber. Isso ajuda quem for responder.\n\n' +
        'Atendemos de segunda a sexta, das 8h às 18h. Fora desse horário, respondemos no próximo dia útil.\n\n' +
        VOLTA,
      atencao: 'anexo',
    }
  }

  // Equipe assumiu a conversa. O robo cala a boca - falar por cima de uma
  // pessoa que esta atendendo e pior do que nao responder.
  //
  // A excecao e urgencia. Quem ja esta na fila da equipe e escreve "e urgente"
  // precisa de duas coisas: a conversa subindo na lista da recepcao, e a
  // confirmacao de que o recado chegou. Ficar mudo aqui era o pior cenario
  // possivel - a mae avisando que a crianca esta mal, e a tela sem sinal
  // nenhum de que aquilo era diferente das outras conversas em espera.
  if (estadoAtual === 'atendente') {
    if (pediuUrgencia(texto)) {
      return {
        resposta:
          '🚨 Avisei a nossa equipe de que é urgente. Alguém entra em contato o mais rápido possível.\n\n' +
          'Se for uma emergência com risco de vida, procure o pronto-socorro mais próximo ou ligue 192.',
        atencao: 'urgencia',
      }
    }

    // Pergunta de sempre, respondida na espera - ate tres vezes.
    //
    // A fila pode durar a noite inteira, e nesse tempo a pessoa escreve
    // "convenio?", "quanto custa?", "onde fica?". Calar diante de uma pergunta
    // que a clinica ja respondeu mil vezes nao protege ninguem.
    //
    // Tres e o limite porque insistir costuma querer dizer que o texto pronto
    // nao serviu: a quarta repeticao do mesmo paragrafo vira deboche. Passou
    // disso, o robo cala e a conversa e so da equipe.
    //
    // podeIniciarMenu entra aqui porque ele e quem sabe se alguem da equipe
    // escreveu ha pouco. Com atendimento humano em andamento, nem a resposta
    // pronta deve aparecer: seria o robo falando por cima da atendente.
    // Na fila, so responde o que casa forte: duas palavras do assunto, e nao
    // uma. Uma palavra solta pega frases que nao sao pergunta - "quero marcar
    // retorno para o Anthony" casava com "retorno" e recebia a lista de
    // documentos. Duas palavras separam a duvida de verdade do resto.
    //
    // A trava anterior era "pedido de agendamento nao recebe resposta pronta", e
    // ela calou a Aline: a mensagem dela pedia informacoes PARA agendar, e a
    // pergunta (AMIL, valor, formas de pagamento) ficou sem resposta. O peso do
    // casamento resolve os dois casos sem precisar adivinhar a intencao.
    const jaRespondidas = opcoes.respostasNaEspera ?? 0
    if (opcoes.podeIniciarMenu && jaRespondidas < LIMITE_NA_ESPERA) {
      const lista = await carregarRespostas(admin, clinicId)
      // Casamento forte (duas palavras do assunto) responde sempre, mesmo que a
      // frase fale em agendar: e o caso da Aline, que pediu informacoes PARA
      // agendar e perguntou de AMIL, valor e formas de pagamento.
      //
      // Casamento fraco (uma palavra) so vale se a pessoa nao estiver pedindo
      // para marcar: e o caso da Sonia, cujo "quero marcar retorno para o
      // Anthony" casava com "retorno" e recebia a lista de documentos. Mas
      // "convenio?" solto, que tambem casa com uma palavra e e pergunta de
      // verdade, continua respondido.
      const achada =
        acharResposta(texto, lista, 2) ??
        (pediuAgendamento(texto) ? null : acharResposta(texto, lista, 1))
      // Sem perguntar a unidade: a pergunta "para qual atendimento?" mudaria a
      // etapa da conversa e tiraria a pessoa da fila sem ela pedir. Vale o
      // texto curto da propria resposta, que ja cobre os tres lugares.
      if (achada) {
        await admin
          .from('whatsapp_conversations')
          .update({ auto_replies_while_waiting: jaRespondidas + 1 })
          .eq('id', conversationId)
        return {
          resposta:
            `${achada.resposta}\n\n` +
            '🙋 Sua conversa continua na fila: alguém da nossa equipe responde por aqui.',
        }
      }
    }
    return null
  }

  // Nao existe mais silencio por causa da bandeira de atencao.
  //
  // A bandeira acumulava dois papeis: avisar a equipe e calar o robo. Sao
  // coisas diferentes. Quem cancelou a consulta sozinho acende a bandeira
  // porque a vaga interessa a recepcao - mas nao esta esperando ninguem falar
  // com ele, e ficava mudo ate alguem abrir a conversa na tela.
  //
  // Quem realmente pediu gente cai no estado 'atendente' logo acima, e quem
  // esta em conversa humana e barrado por equipeFalouRecentemente, calculado no
  // webhook. Esses dois bastam, e nao criam becos sem saida.

  // Pedir gente vale de qualquer etapa, e nao so da opcao 3 do menu.
  if (pediuAtendente(texto)) {
    return await chamarEquipe(admin, conversationId)
  }

  // Urgencia tambem vale de qualquer etapa. Nasceu na telemedicina, mas uma
  // mae com a crianca passando mal nao vai procurar a etapa certa para dizer
  // isso - e o custo de tratar como urgente o que nao era e uma ligacao a mais.
  // Urgencia transfere de qualquer etapa - menos dentro do pedido de
  // documento, onde "urgente" quase sempre quer dizer pressa.
  //
  // "e urgente, ela precisa do omeprazol" e uma mae correndo atras de receita,
  // nao uma emergencia: mandar essa pessoa ao pronto-socorro e ainda jogar
  // fora o pedido dela erra duas vezes. Com sintoma junto - "e urgente, ela
  // esta vomitando sangue" - a transferencia vale, e o pedido perder-se ali e
  // o menor dos problemas.
  if (pediuUrgencia(texto) && (!noPedidoDeDocumento || assuntoClinico(texto))) {
    return await transferirUrgencia(admin, conversationId)
  }

  // "Cancelar" muda de sentido dentro de "minha consulta": ali nao e desistir
  // do fluxo, e desmarcar a consulta. Sem esta excecao a palavra era engolida
  // aqui e a pessoa nunca chegava a poder cancelar de fato.
  const naEtapaDeCancelar =
    estadoAtual === 'minha_consulta' || estadoAtual === 'confirmar_cancelamento'

  if (desistiu(texto) && estadoAtual && !naEtapaDeCancelar) {
    return await mostrarMenu(
      admin,
      conversationId,
      saudacao,
      'Tudo bem, parei por aqui. Posso ajudar em mais alguma coisa?',
    )
  }

  // ---- Sem etapa em andamento ----
  if (!estadoAtual) {
    // Atalho de agendamento so depois que a pessoa viu o menu.
    //
    // O botao do site manda "Vim pelo site e gostaria de agendar uma consulta"
    // ja escrito. Com o atalho valendo na primeira mensagem, a conversa comecava
    // em "Em qual unidade?", sem apresentacao e sem as outras opcoes - e quem so
    // queria saber o valor antes de marcar ficava sem saber que podia perguntar.
    //
    // Entao: primeira mensagem sempre recebe o menu, com a saudacao e as quatro
    // opcoes. Da segunda em diante o atalho vale, e "quero marcar retorno para o
    // Anthony" abre a agenda direto. A pessoa ja sabe o que existe ali.
    //
    // Sintoma junto do pedido tambem nao abre a agenda direto. "Meu filho tem
    // refluxo, queria marcar" e as duas coisas: o robo diz que nao orienta sobre
    // sintoma e mostra o menu, de onde ela marca pelo *2*. Pular essa frase
    // seria o robo fingir que nao leu a parte que mais importava.
    if (opcoes.jaViuOMenu && pediuAgendamento(texto) && !assuntoClinico(texto)) {
      return await iniciarAgendamento(
        admin, clinicId, conversationId, opcoes.pacientes, opcoes.consultas,
      )
    }
    // Sem etapa aberta, o menu e uma iniciativa nossa - e iniciativa tem hora.
    // Mandar menu depois de "Estou bem, obrigada", ou no meio de uma conversa
    // que a secretaria esta tocando, atrapalha em vez de ajudar.
    if (!opcoes.podeIniciarMenu) return null

    // Quem pediu para marcar na primeira mensagem ve o MENU, e nao uma resposta
    // pronta. Sem esta linha, "quero marcar retorno para o Anthony" caia no
    // texto de documentos, porque "retorno" e palavra-chave dele - foi o que
    // aconteceu com a Sonia. O pedido e claro demais para o robo responder
    // outra coisa; so nao e claro o bastante para pular a apresentacao.
    if (pediuAgendamento(texto) && !assuntoClinico(texto)) {
      return await mostrarMenu(admin, conversationId, saudacao)
    }

    // A pergunta vem antes do menu. Quem escreveu uma duvida que a clinica ja
    // respondeu mil vezes merece a resposta, e nao uma lista de opcoes.
    const pronta = await responderPergunta(admin, clinicId, conversationId, texto, opcoes.textos.informacoes)
    if (pronta) return pronta

    // Quem descreveu um sintoma ou perguntou de remedio nao pode receber "como
    // podemos ajudar hoje?" como se nao tivesse dito nada. O robo nao responde
    // - isso e consulta -, mas diz por que nao responde e mostra o caminho. Nao
    // transfere sozinho de proposito: muita gente escreve o sintoma junto com
    // "queria marcar", e ai o menu e que resolve.
    if (assuntoClinico(texto)) {
      return await mostrarMenu(
        admin,
        conversationId,
        saudacao,
        'Sobre sintomas, remédios e o que fazer, quem responde é o Dr. Rafael ou alguém da equipe - ' +
          'por aqui eu não posso orientar. Digite *3* para falar com a equipe, ou escolha:',
      )
    }

    return await mostrarMenu(admin, conversationId, saudacao)
  }

  // ---- Ficha do paciente, depois de marcar ----
  //
  // Vem antes do menu porque estas etapas aceitam texto livre: um nome como
  // "Ana" nao pode cair na leitura de numeros do menu.
  const perguntaAtual = PERGUNTAS.find((p) => p.estado === estadoAtual)
  if (perguntaAtual) {
    const consulta = opcoes.consultaEmCadastro
    // Precisa de um destino: a consulta, ou a ficha de quem ja e paciente.
    // Sem nenhum dos dois, encerra em vez de continuar perguntando para o
    // vazio. A ficha entrou aqui em 16/09/2026: a equipe passou a poder
    // disparar o questionario para quem tem cadastro e nenhuma consulta
    // marcada, e ate entao a primeira resposta caia neste return.
    if (!consulta && !pacienteDaConsulta) return await terminarDados(admin, conversationId)

    const { tentativas, faltam, manual } = filaDaFicha(opcoes.opcoesAtuais)
    const restantes = faltam.slice(1)

    // "Voltar" nao e "pular", e tratar como se fosse apagava o campo.
    //
    // Quem digita VOLTAR na ficha quer corrigir o que respondeu antes - errou
    // a data de nascimento, trocou uma letra do nome. Cair no mesmo caminho do
    // PULAR fazia o robo dizer "Sem problema." e seguir adiante, perdendo o
    // campo atual sem a pessoa ter pedido nada disso.
    //
    // Voltar de verdade exigiria guardar o que ja foi respondido nesta fila, e
    // a ficha e curta: dizer a verdade e repetir a pergunta resolve, e quem
    // precisa corrigir fala com a equipe na consulta, como sempre pode.
    if (pediuVoltar(texto)) {
      return {
        resposta:
          'Aqui não dá para voltar uma pergunta - mas o que já foi respondido está guardado, ' +
          'e o Dr. Rafael confere tudo na consulta.\n\n' +
          perguntaAtual.texto,
        botoes: manual ? undefined : [{ id: 'MENU', titulo: 'Voltar ao menu' }],
      }
    }

    // Pular vale nos campos opcionais, sem justificativa e sem insistir. Nos
    // obrigatorios o robo pede de novo, uma vez - e depois segue, porque
    // insistir eternamente prenderia quem nao pode responder agora.
    if (pulou(texto)) {
      if (perguntaAtual.obrigatoria && tentativas < 1) {
        await salvarEstado(admin, conversationId, {
          booking_options: { tentativas: tentativas + 1, faltam, manual },
        })
        return {
          resposta:
            'Esse dado o Dr. Rafael precisa ter no cadastro. Pode responder aqui, ' +
            'mesmo que não seja exato?\n\n' +
            perguntaAtual.texto,
          botoes: manual ? undefined : [{ id: 'MENU', titulo: 'Voltar ao menu' }],
        }
      }
      return restantes.length
        ? await perguntarDados(admin, conversationId, consulta, restantes, 'Sem problema.', manual)
        : await terminarDados(admin, conversationId, clinicId, consulta, manual)
    }

    const valor = perguntaAtual.ler(texto)
    if (valor === null) {
      // Uma segunda chance, e so uma. Insistir num CPF que a pessoa nao tem
      // seria transformar um dado opcional em muro.
      if (tentativas >= 1) {
        return restantes.length
          ? await perguntarDados(
              admin, conversationId, consulta, restantes,
              'Tudo bem, deixamos esse campo em branco: o Dr. Rafael completa na consulta.',
              manual,
            )
          : await terminarDados(admin, conversationId, clinicId, consulta, manual)
      }
      await salvarEstado(admin, conversationId, {
        booking_options: { tentativas: tentativas + 1, faltam, manual },
      })
      return {
        resposta:
          perguntaAtual.erro +
          (perguntaAtual.obrigatoria ? '' : '\n\n_Ou digite PULAR para seguir sem esse dado._'),
        botoes: perguntaAtual.obrigatoria
          ? manual
            ? undefined
            : [{ id: 'MENU', titulo: 'Voltar ao menu' }]
          : manual
            ? [{ id: 'PULAR', titulo: 'Pular' }]
            : [
                { id: 'PULAR', titulo: 'Pular' },
                { id: 'MENU', titulo: 'Voltar ao menu' },
              ],
      }
    }

    await guardarDado(admin, consulta, perguntaAtual, valor, pacienteDaConsulta)
    return restantes.length
      ? await perguntarDados(admin, conversationId, consulta, restantes, '', manual)
      : await terminarDados(admin, conversationId, clinicId, consulta, manual)
  }

  // ---- Menu ----
  if (estadoAtual === 'menu') {
    const escolhido = escolha(texto, 5)

    if (escolhido === 0) {
      return await perguntarLocalDasInformacoes(admin, clinicId, conversationId, opcoes.textos.informacoes)
    }

    if (escolhido === 1) {
      return await iniciarAgendamento(
        admin, clinicId, conversationId, opcoes.pacientes, opcoes.consultas,
      )
    }

    if (escolhido === 2) {
      return await chamarEquipe(admin, conversationId)
    }

    if (escolhido === 3) {
      return await mostrarMinhaConsulta(admin, clinicId, conversationId, opcoes.consultas)
    }

    if (escolhido === 4) {
      return await iniciarDocumento(admin, conversationId, opcoes.pacientes)
    }

    // Sintoma junto do pedido nao abre a agenda direto. "Meu filho tem refluxo,
    // queria marcar" e as duas coisas: o robo diz que nao orienta sobre sintoma
    // e mostra o menu, de onde a pessoa marca pelo *2*. Pular essa frase seria
    // o robo fingir que nao leu a parte que mais importava.
    if (pediuAgendamento(texto) && !assuntoClinico(texto)) {
      return await iniciarAgendamento(
        admin, clinicId, conversationId, opcoes.pacientes, opcoes.consultas,
      )
    }

    // Com alguem da equipe conversando, o robo para por aqui.
    //
    // Numero de menu ele ainda processa, porque a pessoa escolheu de propósito.
    // Mas texto solto, daqui para baixo, vira resposta pronta ou "nao entendi" -
    // e isso ele nao pode mandar por cima de uma conversa humana em andamento.
    // Aconteceu com a Barbara em 15/09/2026: a equipe explicou a mao, as 11:50,
    // que a Trasmontano e atendida; ela perguntou "Unimed nao?" as 12:23 e o
    // robo repetiu a resposta pronta de convenio por cima da atendente.
    //
    // A trava ja existia (12 horas desde a ultima mensagem de gente), mas so
    // valia para quem estava sem etapa nenhuma. No menu, ela nao valia.
    if (!opcoes.podeIniciarMenu) return null

    // Antes de dizer "nao entendi": a pessoa pode ter ignorado a lista e
    // escrito a duvida dela, que e o que se faz num WhatsApp de verdade.
    const pronta = await responderPergunta(admin, clinicId, conversationId, texto, opcoes.textos.informacoes)
    if (pronta) return pronta

    // Sintoma escrito COM o menu na tela recebia "Não entendi. Responda com o
    // número da opção" - a mãe corrigida sobre a forma de responder, e ninguém
    // avisado. A frase existia, mas só valia para quem escrevia antes de o
    // menu aparecer, o que na prática é só a primeira mensagem da vida dela.
    if (assuntoClinico(texto)) {
      return await mostrarMenu(
        admin,
        conversationId,
        saudacao,
        'Sobre sintomas, remédios e o que fazer, quem responde é o Dr. Rafael ou alguém da equipe - ' +
          'por aqui eu não posso orientar. Digite *3* para falar com a equipe, ou escolha:',
      )
    }

    return await mostrarMenu(
      admin,
      conversationId,
      saudacao,
      'Não entendi. Responda com o número da opção:',
    )
  }

  // ---- 2a via de receita e pedido de exame ----

  // Numero sem atendimento: paciente/responsavel ou farmacia?
  if (estadoAtual === 'documento_quem') {
    const escolhido = escolha(texto, 2)
    if (escolhido === 0) {
      // Pode ser o pai no celular do trabalho, e pode ser alguem que nunca
      // veio. Quem confere e gente: o robo nao tem como saber, e chutar aqui
      // seria abrir cadastro para quem souber um nome.
      return await chamarEquipe(admin, conversationId)
    }
    if (escolhido === 1) {
      return await perguntarPedidoDaFarmacia(admin, conversationId)
    }
    return {
      resposta: 'Não entendi. Responda *1* se você é o paciente ou responsável, ou *2* se está falando de uma farmácia ou laboratório.',
      botoes: [
        { id: '1', titulo: 'Paciente/responsável' },
        { id: '2', titulo: 'Farmácia/laboratório' },
      ],
    }
  }

  // O pedido da farmacia, que sai daqui direto para a equipe.
  //
  // Sem confirmar nada sobre o paciente e sem prometer resposta por este canal:
  // quem recebe o documento corrigido e a familia, pelo numero dela. Dizer isso
  // agora evita a farmacia esperando um PDF que nunca vai chegar aqui.
  if (estadoAtual === 'documento_farmacia') {
    if (!texto.trim() && !opcoes.anexo) {
      return {
        resposta: 'Pode escrever o nome do paciente e o que precisa ser corrigido.',
      }
    }
    await salvarEstado(admin, conversationId, {
      booking_state: 'atendente',
      booking_options: null,
      auto_replies_while_waiting: 0,
    })
    return {
      resposta:
        '✅ Registrado. Vou passar para o Dr. Rafael.\n\n' +
        'O documento corrigido é enviado ao paciente, não por este canal.\n\n' +
        'Atendemos de segunda a sexta, das 8h às 18h.',
      atencao: 'farmacia',
    }
  }

  // Para qual filho.
  if (estadoAtual === 'documento_paciente') {
    const ids = Array.isArray((opcoes.opcoesAtuais as { pacientes?: unknown } | null)?.pacientes)
      ? ((opcoes.opcoesAtuais as { pacientes: string[] }).pacientes)
      : []
    const candidatos = ids
      .map((id) => opcoes.pacientes.find((p) => p.id === id))
      .filter((p): p is Paciente => Boolean(p))

    if (opcoes.anexo && !texto.trim()) {
      return {
        resposta: '📎 Recebi. Só me diga antes para qual paciente é o pedido.',
      }
    }

    // O nome escrito vale tanto quanto o numero.
    //
    // A pessoa acabou de LER os nomes na tela; responder "Pedro" e o reflexo,
    // e so o numero era aceito. Primeiro nome basta, e por prefixo, porque
    // ninguem digita "Pedro Souza" inteiro quando o filho se chama Pedro.
    const escrito = normalizar(texto)
    const porNome = escrito
      ? candidatos.find((p) => {
          const nome = normalizar(p.name)
          return nome === escrito || nome.startsWith(`${escrito} `) || escrito === nome.split(' ')[0]
        })
      : undefined

    const indice = escolha(texto, candidatos.length)
    const escolhido = porNome ?? (indice === null ? undefined : candidatos[indice])
    if (!escolhido) {
      return {
        resposta: await naoEntendi(
          admin,
          clinicId,
          texto,
          'Responda com o número do paciente da lista acima.',
        ),
      }
    }
    return await perguntarTipoDoDocumento(admin, conversationId, {
      pacienteId: escolhido.id,
      paciente: escolhido.name,
    })
  }

  // Receita ou exame.
  if (estadoAtual === 'documento_tipo') {
    const pedido = pedidoEmAndamento(opcoes.opcoesAtuais)

    if (opcoes.anexo && !texto.trim()) {
      return {
        resposta:
          '📎 Recebi. Antes de guardar, me diga o que você precisa:\n\n' +
          '*1* 💊 2ª via de receita\n' +
          '*2* 🔬 Pedido de exame',
        botoes: [
          { id: '1', titulo: '2ª via de receita' },
          { id: '2', titulo: 'Pedido de exame' },
        ],
      }
    }

    // A palavra vem antes do numero, e nao o contrario.
    //
    // "2ª via de receita" e o rotulo do proprio botao, e escolha() raspa os
    // digitos da frase: o "2" do "2ª" virava a opcao 2, e quem pediu receita
    // recebia "qual exame?". Ler a palavra primeiro resolve sem mexer na
    // leitura de numeros do resto do robo.
    const escrito = normalizar(texto)
    const porPalavra = /receita|remedio|medicamento/.test(escrito)
      ? 'receita'
      : /exame|laborat|ultrassom|endoscopia|sangue/.test(escrito)
        ? 'exame'
        : null

    const escolhido = escolha(texto, 2)
    if (!porPalavra && escolhido === null) {
      return {
        resposta: await naoEntendi(
          admin,
          clinicId,
          texto,
          'Responda *1* para 2ª via de receita, ou *2* para pedido de exame.',
        ),
        botoes: [
          { id: '1', titulo: '2ª via de receita' },
          { id: '2', titulo: 'Pedido de exame' },
        ],
      }
    }
    const tipo = porPalavra ?? (escolhido === 0 ? 'receita' : 'exame')
    await salvarEstado(admin, conversationId, {
      booking_state: 'documento_item',
      booking_options: { pedido: { ...pedido, tipo } },
    })
    return {
      resposta:
        tipo === 'receita'
          ? 'Qual medicamento? Pode escrever como está na receita.'
          : 'Qual exame? Pode escrever como está no pedido.',
    }
  }

  // Qual medicamento ou exame. Texto livre - e de proposito: ninguem tem a
  // lista de remedios da clinica na cabeca, e uma lista tocavel aqui daria
  // trabalho para acertar o que a pessoa ja sabe dizer numa linha.
  if (estadoAtual === 'documento_item') {
    const pedido = pedidoEmAndamento(opcoes.opcoesAtuais)
    const item = texto.trim()
    if (!item) {
      // A foto da receita quando o robo pede o nome do remedio e o reflexo
      // mais natural que existe - e era o que apagava o pedido inteiro. Aqui
      // ela e recebida, o estado fica de pe, e o robo explica por que ainda
      // precisa do nome: ele nao le imagem, e quem vai ler e o medico.
      const pediu = pedido.tipo === 'exame' ? 'o nome do exame' : 'o nome do medicamento'
      return {
        resposta: opcoes.anexo
          ? `📎 Recebi. Me diga também ${pediu}, escrito - assim o pedido chega completo.`
          : `Pode escrever ${pediu}.`,
      }
    }

    // Controlado sai do automatico aqui, e nao no fim.
    //
    // Continuar perguntando a exigencia e devolver "em ate 1 dia util" seria
    // prometer o que a lei nao deixa cumprir: a receita de controlado sai em
    // receituario proprio, a farmacia retem a via original, e PDF nenhum
    // substitui o papel que ficou no balcao. A familia iria a farmacia com um
    // arquivo no celular para ouvir nao - e a culpa seria nossa, por ter
    // prometido.
    //
    // O pedido nao se perde: vira conversa com a equipe, com o que ela ja
    // escreveu registrado acima.
    if (pedido.tipo === 'receita' && medicamentoControlado(item)) {
      await salvarEstado(admin, conversationId, {
        booking_state: 'atendente',
        booking_options: null,
        auto_replies_while_waiting: 0,
      })
      return {
        resposta:
          `Anotei: *${item}*.\n\n` +
          'Esse tipo de receita sai em receituário especial e a farmácia fica com a via ' +
          'original, então a 2ª via não pode ser resolvida por aqui automaticamente.\n\n' +
          'Já avisei a equipe: alguém do consultório responde por aqui para combinar como ' +
          'retirar.\n\n' +
          'Atendemos de segunda a sexta, das 8h às 18h.',
        atencao: 'documento',
      }
    }

    return await perguntarExigencia(admin, conversationId, { ...pedido, item })
  }

  // O que a farmacia ou o laboratorio exigiu. Aceita foto: a imagem do
  // documento recusado costuma dizer mais que a explicacao repassada de
  // cabeca por quem esta no balcao.
  if (estadoAtual === 'documento_exigencia') {
    const pedido = pedidoEmAndamento(opcoes.opcoesAtuais)
    const resposta = texto.trim()
    if (!resposta && !opcoes.anexo) {
      return await perguntarExigencia(admin, conversationId, pedido)
    }
    // "Nao" aqui e resposta completa, nao recusa: quer dizer que nada foi
    // exigido, e o pedido segue do mesmo jeito.
    const nada = /^(n|nao|não|nada|nenhuma|negativo)$/i.test(normalizar(resposta))
    const exigencia = nada ? '' : resposta
    return await registrarPedido(
      admin,
      conversationId,
      pedido,
      exigencia || (opcoes.anexo ? 'enviou foto do documento' : ''),
    )
  }

  // ---- Informacoes: de qual unidade? ----
  if (estadoAtual === 'informacoes_unidade') {
    const ids = Array.isArray(opcoes.opcoesAtuais) ? (opcoes.opcoesAtuais as string[]) : []
    const indice = escolha(texto, ids.length)
    if (indice === null) {
      if (pediuVoltar(texto)) return await mostrarMenu(admin, conversationId, saudacao)
      return {
        resposta: await naoEntendi(
          admin,
          clinicId,
          texto,
          'Responda com o número da unidade da lista acima.\n\n' + VOLTA,
        ),
      }
    }
    return await responderInformacoes(admin, clinicId, conversationId, ids[indice], opcoes.textos.informacoes)
  }

  // ---- Minha consulta ----
  if (estadoAtual === 'minha_consulta') {
    const ids = Array.isArray(opcoes.opcoesAtuais) ? (opcoes.opcoesAtuais as string[]) : []
    const t = normalizar(texto)
    const querRemarcar = t === 'remarcar' || t === 'trocar' || t === 'mudar'
    const querCancelar = t === 'cancelar' || t === 'desmarcar'

    // A consulta em foco, e nao "a unica que a pessoa tem".
    //
    // booking_options comeca com todas e passa a ter uma so depois que ela
    // escolhe pelo numero. Enquanto a condicao olhava para opcoes.consultas,
    // quem tinha duas consultas escolhia a segunda, digitava CANCELAR e ouvia
    // "nao entendi, digite CANCELAR" - e os tres botoes daquela tela levavam
    // de volta ao mesmo lugar. Laco fechado, e justamente para a mae com dois
    // filhos em acompanhamento, que e o caso comum aqui.
    const emFoco = ids.length === 1
      ? opcoes.consultas.find((c) => c.id === ids[0]) ?? null
      : null

    if (emFoco && (querCancelar || querRemarcar)) {
      return await pedirConfirmacaoCancelamento(
        admin, clinicId, conversationId, emFoco, querRemarcar,
      )
    }

    const indice = escolha(texto, ids.length)
    const alvo = indice === null ? null : opcoes.consultas.find((c) => c.id === ids[indice])
    if (alvo) {
      await salvarEstado(admin, conversationId, { booking_options: [alvo.id] })
      const timezone = await fusoDaClinica(admin, clinicId)
      return {
        resposta:
          `${descreverConsulta(alvo, timezone)}\n\n` +
          'Digite CANCELAR para desmarcar, REMARCAR para trocar a data, ou *0* para voltar.',
      botoes: [
        { id: 'REMARCAR', titulo: 'Remarcar' },
        { id: 'CANCELAR', titulo: 'Cancelar consulta' },
        { id: 'MENU', titulo: 'Voltar ao menu' },
      ],
      }
    }

    return {
      resposta: await naoEntendi(
        admin,
        clinicId,
        texto,
        'Digite CANCELAR para desmarcar, REMARCAR para trocar a data, ' +
          'ou *0* para voltar ao início.',
      ),
      botoes: [
        { id: 'REMARCAR', titulo: 'Remarcar' },
        { id: 'CANCELAR', titulo: 'Cancelar consulta' },
        { id: 'MENU', titulo: 'Voltar ao menu' },
      ],
    }
  }

  // ---- Confirmacao do cancelamento ----
  if (estadoAtual === 'confirmar_cancelamento') {
    const t = normalizar(texto)
    // O sim escrito como gente escreve.
    //
    // A comparacao exata exigia a palavra sozinha: "sim, pode cancelar por
    // favor" virava "sua consulta continua marcada", e no caminho da
    // remarcacao jogava no menu quem tinha acabado de confirmar. Ninguem
    // responde uma pergunta de confirmacao em uma palavra seca.
    //
    // O "nao" e testado ANTES: sem isso, "nao, pode cancelar nao" casaria com
    // "pode cancelar" e desmarcaria a consulta de quem estava recusando. Errar
    // aqui apaga uma vaga que ninguem pediu para apagar.
    const negou = /^(n|nao|nada|negativo|deixa|espera|melhor nao)\b/.test(t)
    const confirmou =
      !negou &&
      (/^(sim|s|isso|claro|confirmo|confirmar|quero|ok|pode)\b/.test(t) ||
        t.includes('pode cancelar') ||
        t.includes('pode desmarcar'))
    if (!confirmou) {
      return await mostrarMenu(
        admin, conversationId, saudacao,
        'Tudo bem, sua consulta continua marcada. Posso ajudar em mais alguma coisa?',
      )
    }

    const ids = Array.isArray(opcoes.opcoesAtuais) ? (opcoes.opcoesAtuais as string[]) : []
    const alvo = opcoes.consultas.find((c) => c.id === ids[0]) ?? opcoes.consultas[0]
    if (!alvo) {
      return await mostrarMenu(admin, conversationId, saudacao, 'Não encontrei mais essa consulta.')
    }

    // Remarcar nao cancela agora: primeiro escolhe a nova data, e a antiga cai
    // so quando a nova estiver garantida.
    if (opcoes.consultaASubstituir === alvo.id) {
      return await iniciarAgendamento(
        admin, clinicId, conversationId, opcoes.pacientes, opcoes.consultas, true,
      )
    }

    const ok = await cancelarConsulta(admin, alvo.id)
    // Menu ativo, e nao estado zerado: a resposta abaixo oferece "digite 2".
    await voltarAoMenuAtivo(admin, conversationId)
    if (!ok) {
      return {
        resposta:
          'Não consegui cancelar agora. Já avisei a nossa equipe, que resolve isso por aqui.\n\n' + VOLTA,
        atencao: 'falha',
      }
    }
    return {
      // A vaga que abriu interessa a recepcao: por isso a conversa acende.
      resposta:
        'Consulta cancelada. Obrigado por avisar!\n\n' +
        'Se quiser marcar outra data, digite 2. ' + VOLTA,
      atencao: 'cancelou_sozinho',
    }
  }

  // ---- Ja tem consulta marcada ----
  if (estadoAtual === 'ja_tem_consulta') {
    const escolhido = escolha(texto, 2)
    if (escolhido === 0) {
      const alvo = opcoes.consultas[0]
      if (!alvo) return await mostrarMenu(admin, conversationId, saudacao)
      return await pedirConfirmacaoCancelamento(admin, clinicId, conversationId, alvo, true)
    }
    if (escolhido === 1) {
      return await iniciarAgendamento(
        admin, clinicId, conversationId, opcoes.pacientes, opcoes.consultas, true,
      )
    }
    return {
      resposta: await naoEntendi(
        admin,
        clinicId,
        texto,
        'Responda 1 para remarcar, 2 para marcar mais uma consulta, ' +
          'ou MENU para voltar ao início.',
      ),
    }
  }

  // ---- Escolha do paciente ----
  if (estadoAtual === 'aguardando_paciente') {
    if (pediuVoltar(texto)) return await mostrarMenu(admin, conversationId, saudacao)

    const ids = Array.isArray(opcoes.opcoesAtuais) ? (opcoes.opcoesAtuais as string[]) : []
    const indice = escolha(texto, ids.length)
    if (indice === null) {
      return {
        resposta: await naoEntendi(
          admin,
          clinicId,
          texto,
          'Responda com o número do paciente da lista acima.\n\n' + VOLTA,
        ),
      }
    }

    const escolhido = opcoes.pacientes.find((p) => p.id === ids[indice])
    if (!escolhido) {
      return await mostrarMenu(
        admin,
        conversationId,
        saudacao,
        'Esse paciente não está mais disponível. Vamos recomeçar:',
      )
    }

    await salvarEstado(admin, conversationId, { booking_patient_id: escolhido.id })
    return await perguntarUnidade(admin, clinicId, conversationId)
  }

  // ---- Escolha da unidade ----
  if (estadoAtual === 'aguardando_unidade') {
    const ids = Array.isArray(opcoes.opcoesAtuais) ? (opcoes.opcoesAtuais as string[]) : []

    // "3" aqui e ambiguo: pode ser a terceira unidade ou "falar com a equipe".
    // A lista manda, porque foi ela que a pessoa acabou de ler.
    const indice = escolha(texto, ids.length)
    if (indice === null) {
      if (pediuVoltar(texto)) {
        return opcoes.pacientes.length > 1
          ? await perguntarPaciente(admin, conversationId, opcoes.pacientes)
          : await mostrarMenu(admin, conversationId, saudacao)
      }
      return {
        resposta: await naoEntendi(
          admin,
          clinicId,
          texto,
          'Responda com o número da unidade da lista acima.\n\n' + VOLTA,
        ),
      }
    }

    const unidades = await opcoesDeAtendimento(admin, clinicId)
    const escolhida = unidades.find((u) => u.id === ids[indice])
    if (!escolhida) {
      return await mostrarMenu(
        admin,
        conversationId,
        saudacao,
        'Essa unidade não está mais disponível. Vamos recomeçar:',
      )
    }
    return await perguntarConvenioOuDia(admin, clinicId, conversationId, escolhida)
  }

  // ---- Convenio: particular ou pelo plano? ----
  //
  // So aparece em unidade que aceita convenio. A resposta nao muda o preco nem
  // o horario: muda o que a recepcao precisa ter em maos quando a pessoa
  // chegar. Sem ela, a familia aparece com a carteirinha e a recepcao descobre
  // na hora se fatura pelo plano ou cobra particular.
  if (estadoAtual === 'aguardando_convenio') {
    const unidadeId = unidadeEmAndamento
    const unidades = await opcoesDeAtendimento(admin, clinicId)
    const escolhida = unidades.find((u) => u.id === unidadeId)
    if (!escolhida) {
      return await mostrarMenu(
        admin,
        conversationId,
        saudacao,
        'Perdi o fio da conversa, desculpe. Vamos recomeçar:',
      )
    }

    const plano = (escolhida.accepts_insurance ?? '').trim()
    const indice = escolha(texto, 2)
    const escrito = texto.trim().toLowerCase()
    // Aceita o numero, o nome do plano digitado e a palavra "particular": quem
    // responde por escrito nao deve ser mandado de volta para a lista.
    const pelaPalavra =
      plano && escrito.includes(plano.toLowerCase()) ? 0
        : /particular|sem convenio|sem convênio|nao tenho|não tenho/.test(escrito) ? 1
          : null
    const resposta = indice ?? pelaPalavra

    if (resposta === null) {
      if (pediuVoltar(texto)) return await mostrarMenu(admin, conversationId, saudacao)
      return {
        resposta: await naoEntendi(
          admin,
          clinicId,
          texto,
          `Responda *1* para ${plano} ou *2* para particular.\n\n` + VOLTA,
        ),
      }
    }

    await salvarEstado(admin, conversationId, {
      booking_insurance: resposta === 0 ? plano : '',
    })
    return await perguntarDia(admin, clinicId, conversationId, escolhida)
  }

  // ---- Escolha do dia ----
  if (estadoAtual === 'aguardando_dia') {
    if (pediuVoltar(texto)) {
      return await perguntarUnidade(admin, clinicId, conversationId)
    }

    const dias = Array.isArray(opcoes.opcoesAtuais) ? (opcoes.opcoesAtuais as string[]) : []

    // "31/08" e uma resposta natural. Aqui nao ha o risco do horario - uma data
    // nunca cai dentro da faixa de indices - mas entender custa pouco.
    const data = dataEscrita(texto)
    const porData = data
      ? dias.findIndex((chave) => {
          const [, mes, dia] = chave.split('-').map(Number)
          return dia === data.dia && mes === data.mes
        })
      : -1

    const indice = porData >= 0 ? porData : escolha(texto, dias.length)
    if (indice === null) {
      return {
        resposta: await naoEntendi(
          admin,
          clinicId,
          texto,
          'Responda com o número do dia da lista acima.\n' +
            'Digite VOLTAR para escolher outra unidade, ou 0 para o início.',
        ),
      }
    }
    if (!unidadeEmAndamento) {
      return await mostrarMenu(
        admin,
        conversationId,
        saudacao,
        'Perdi o fio da conversa, desculpe. Vamos recomeçar:',
      )
    }
    return await perguntarHorario(
      admin,
      clinicId,
      conversationId,
      unidadeEmAndamento,
      dias[indice],
    )
  }

  // ---- Escolha do horario ----
  if (estadoAtual === 'aguardando_horario') {
    if (pediuVoltar(texto)) {
      if (!unidadeEmAndamento) {
        return await perguntarUnidade(admin, clinicId, conversationId)
      }
      const unidade = await unidadePorId(admin, unidadeEmAndamento)
      if (!unidade) return await perguntarUnidade(admin, clinicId, conversationId)
      return await perguntarDia(admin, clinicId, conversationId, unidade)
    }

    const lista = Array.isArray(opcoes.opcoesAtuais) ? (opcoes.opcoesAtuais as Horario[]) : []

    // Hora escrita vem antes do indice, e nao depois: num dia com dez ou mais
    // horarios, "10h" tambem e um indice valido - e apontaria para outra hora.
    const pedida = horaEscrita(texto)
    if (pedida) {
      const timezone = await fusoDaClinica(admin, clinicId)
      const daHora = lista.filter((h) => {
        const [hh, mm] = formatarHora(h.inicio, timezone).split(':').map(Number)
        return hh === pedida.hora && (pedida.minuto === null || mm === pedida.minuto)
      })

      if (daHora.length === 1) {
        if (!unidadeEmAndamento) {
          return await mostrarMenu(admin, conversationId, saudacao, 'Perdi o fio da conversa, desculpe. Vamos recomeçar:')
        }
        return await marcar(
          admin, clinicId, conversationId, unidadeEmAndamento,
          pacienteDaConsulta, opcoes.telefone, opcoes.nomeDoPerfil, daHora[0],
          opcoes.consultaASubstituir, opcoes.convenioEmAndamento ?? '',
        )
      }

      // Ambiguidade de "10h" e entre 10:00 e 10:40, e nao entre os quinze do
      // dia. Repetir a lista inteira aqui empurraria de volta o trabalho que a
      // pessoa ja tinha feito.
      if (daHora.length > 1) {
        const opcoesHora = daHora.map((h) => formatarHora(h.inicio, timezone))
        return {
          resposta:
            `Nesse horário temos ${opcoesHora.slice(0, -1).join(', ')} e ${opcoesHora.at(-1)}.\n\n` +
            'Responda com o horário exato, ou com o número da lista acima.',
        }
      }

      const linhas = lista
        .map((h, i) => `${i + 1} - ${formatarHora(h.inicio, timezone)}`)
        .join('\n')
      return {
        resposta:
          `Esse horário não está entre os livres deste dia. Os disponíveis são:\n\n${linhas}\n\n` +
          'Responda com o número, ou digite VOLTAR para escolher outro dia.',
      }
    }

    const indice = escolha(texto, lista.length)
    if (indice === null) {
      return {
        resposta: await naoEntendi(
          admin,
          clinicId,
          texto,
          'Responda com o número do horário da lista acima.\n' +
            'Digite VOLTAR para escolher outro dia, ou 0 para o início.',
        ),
      }
    }
    if (!unidadeEmAndamento) {
      return await mostrarMenu(
        admin,
        conversationId,
        saudacao,
        'Perdi o fio da conversa, desculpe. Vamos recomeçar:',
      )
    }
    return await marcar(
      admin,
      clinicId,
      conversationId,
      unidadeEmAndamento,
      pacienteDaConsulta,
      opcoes.telefone,
      opcoes.nomeDoPerfil,
      lista[indice],
      opcoes.consultaASubstituir,
      opcoes.convenioEmAndamento ?? '',
    )
  }

  return null
}
