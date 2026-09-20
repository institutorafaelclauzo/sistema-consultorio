// Simulação de conversas inteiras, com os textos REAIS da clínica.
//
// Diferente de atendimento.test.mjs, aqui nada é verificado automaticamente: o
// objetivo é imprimir a conversa como ela chega no celular da família, do "oi"
// até o comprovante, para alguém LER e julgar se faz sentido. Teste que passa
// não garante que o texto está bom.
//
// Como rodar:  npm run simular
//
// Os textos abaixo são cópia fiel do que a migration grava no banco. Se a
// clínica editar na tela, o que vale é o banco - isto aqui é o ponto de
// partida.

import { tratarConversa } from './atendimento.build.mjs'

// ---------------------------------------------------------------
// Os textos reais
// ---------------------------------------------------------------

const FECHO =
  '⚡ *Agendar por aqui é mais rápido*: digite *2* e escolha unidade, dia e horário na hora.\n\n' +
  '🙋 Quer falar com alguém da equipe? Digite *9*.\n\n' +
  '⏰ Segunda a sexta, 8h às 18h. Fora desse horário, respondemos no próximo dia útil.'

const SANTOS =
  '💙 *Consulta em Santos: R$ 450,00.* Inclui retorno em até 30 dias.\n\n' +
  '💳 Pagamento somente em pix ou dinheiro. Não atendemos convênio, mas emitimos recibo com CRM e CNPJ para você pedir reembolso ao seu plano.\n\n' +
  '📍 Liferty · Santos — Al. Armênio Mendes, 66, sala 2912, Aparecida. Estacionamento particular no local.\n\n' +
  '📋 Leve um documento com foto do responsável, a carteirinha de vacinação da criança e os exames anteriores, se houver.'

const SAO_PAULO =
  '💙 *Consulta em São Paulo: R$ 550,00.* Inclui retorno em até 30 dias.\n\n' +
  '💳 Pagamento somente em pix ou dinheiro. Não atendemos convênio, mas emitimos recibo com CRM e CNPJ para você pedir reembolso ao seu plano.\n\n' +
  '📍 Livance · Ibirapuera — R. Agostinho Rodrigues Filho, 550, Vila Clementino. Estacionamento particular no local.\n\n' +
  '📋 Leve um documento com foto do responsável, a carteirinha de vacinação da criança e os exames anteriores, se houver.'

const TELE_TEXTO =
  '💙 *Telemedicina: R$ 450,00.* Inclui um retorno presencial em até 30 dias, em Santos ou São Paulo.\n\n' +
  '💳 Pagamento por pix. Não atendemos convênio, mas emitimos recibo com CRM e CNPJ para você pedir reembolso ao seu plano.\n\n' +
  '💻 A consulta é por vídeo, no horário marcado. Você recebe o link aqui pelo WhatsApp.\n\n' +
  '📋 Tenha em mãos a carteirinha de vacinação da criança e os exames anteriores, se houver.'

const UNIDADES = [
  { id: 'u-santos', name: 'Liferty · Santos', address: 'Al. Armênio Mendes, 66, sala 2912', info_text: SANTOS },
  { id: 'u-sp', name: 'Livance · Ibirapuera', address: 'R. Agostinho Rodrigues Filho, 550', info_text: SAO_PAULO },
]

const RESPOSTAS_PRONTAS = [
  {
    id: 'r1',
    subject: 'Valor e pagamento',
    keywords: ['valor', 'valores', 'preco', 'preço', 'custa', 'custo', 'quanto', 'pagamento', 'pagar', 'pix', 'cartao', 'recibo', 'reembolso', 'particular'],
    answer: 'Santos R$ 450, São Paulo R$ 550, telemedicina R$ 450.',
    ask_unit: true,
  },
  {
    id: 'r2',
    subject: 'Convênios',
    keywords: ['convenio', 'convênio', 'convenios', 'plano', 'planos', 'unimed', 'bradesco', 'amil', 'sulamerica', 'porto', 'notredame', 'carteirinha', 'credenciado'],
    answer:
      'Não atendemos convênio: o atendimento é particular, com pagamento em pix ou dinheiro.\n\n' +
      'Emitimos recibo com CRM e CNPJ para você pedir reembolso ao seu plano. O valor devolvido depende do seu contrato.',
    ask_unit: false,
  },
  {
    id: 'r3',
    subject: 'Endereço e estacionamento',
    keywords: ['endereco', 'endereço', 'onde', 'local', 'chegar', 'estacionamento', 'estacionar', 'mapa'],
    answer:
      'Atendemos em duas unidades, as duas com estacionamento particular no local:\n\n' +
      '📍 *Livance · Ibirapuera* — R. Agostinho Rodrigues Filho, 550, Vila Clementino, São Paulo.\n\n' +
      '📍 *Liferty · Santos* — Al. Armênio Mendes, 66, sala 2912, Aparecida, Santos.',
    ask_unit: false,
  },
  {
    id: 'r4',
    subject: 'O que levar e como é a consulta',
    keywords: ['levar', 'documento', 'documentos', 'exame', 'exames', 'vacina', 'vacinacao', 'retorno', 'duracao', 'demora'],
    answer:
      'Leve um documento com foto do responsável, a carteirinha de vacinação da criança e os exames anteriores, se houver.\n\n' +
      'O retorno está incluído e pode ser feito em até 30 dias.',
    ask_unit: false,
  },
]

const TEXTOS = {
  saudacao: 'Olá! 👋 Aqui é o consultório do Dr. Rafael Clauzo, Instituto Clauzo.',
  saudacaoConhecida: 'Olá, {nome}! 👋 Aqui é o consultório do Dr. Rafael Clauzo.',
  informacoes: FECHO,
}

// Agenda de verdade: Santos às quartas de manhã, São Paulo às sextas à tarde.
const slots = (dias, horas) =>
  dias.flatMap((d) => horas.map((h) => ({ slot_start: `${d}T${h}:00Z`, slot_end: `${d}T${h}:40Z` })))

const SLOTS = {
  'u-santos': slots(['2026-09-16', '2026-09-23'], ['11:00', '11:40', '12:20', '13:00']),
  'u-sp': slots(['2026-09-18', '2026-09-25'], ['17:00', '17:40', '18:20']),
}

// ---------------------------------------------------------------
// Banco falso
// ---------------------------------------------------------------

function fazerAdmin({ pacientes = [], teleAtiva = true }) {
  const conversa = {
    booking_state: null,
    booking_options: null,
    booking_unit_id: null,
    booking_modality: null,
    booking_patient_id: null,
    booking_replaces_id: null,
    booking_intake_id: null,
    menu_sent_at: null,
  }
  const marcadas = []
  const canceladas = []
  const cadastrados = []

  const chain = (resultado) => ({
    select: () => chain(resultado),
    eq: (_c, valor) => chain(resultado._porId ? { ...resultado, single: resultado._porId(valor) } : resultado),
    is: () => chain(resultado),
    order: () => chain(resultado),
    limit: () => chain(resultado),
    maybeSingle: async () => ({ data: resultado.single ?? null, error: null }),
    then: (r) => r({ data: resultado.list ?? [], error: null }),
  })

  const admin = {
    from(tabela) {
      if (tabela === 'whatsapp_conversations') {
        return {
          update: (campos) => {
            Object.assign(conversa, campos)
            return { eq: async () => ({}) }
          },
        }
      }
      if (tabela === 'clinic_units') {
        return {
          select: () =>
            chain({
              list: UNIDADES,
              single: UNIDADES[0],
              _porId: (id) => UNIDADES.find((u) => u.id === id) ?? null,
            }),
        }
      }
      if (tabela === 'clinics') return { select: () => chain({ single: { timezone: 'America/Sao_Paulo' } }) }
      if (tabela === 'clinic_settings') {
        return {
          select: () =>
            chain({ single: { telemedicine_enabled: teleAtiva, telemedicine_info_text: TELE_TEXTO } }),
        }
      }
      if (tabela === 'bot_answers') return { select: () => chain({ list: RESPOSTAS_PRONTAS }) }
      if (tabela === 'patients') {
        return {
          select: () => chain({ list: pacientes, single: null, _porId: () => null }),
          insert: (linha) => ({
            select: () => ({
              maybeSingle: async () => {
                cadastrados.push(linha)
                return { data: { id: `paciente-${cadastrados.length}` }, error: null }
              },
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        }
      }
      if (tabela === 'appointments') {
        return {
          // Devolve a ULTIMA consulta marcada nesta conversa: e ela que o
          // comprovante final relê. Com um valor fixo aqui, a simulação
          // mostraria um horário que ninguém escolheu.
          select: () =>
            chain({
              single: (() => {
                const ultima = marcadas.at(-1)
                const unidade = UNIDADES.find((u) => u.id === ultima?.unit_id) ?? UNIDADES[0]
                return {
                  reschedule_count: 0,
                  starts_at: ultima?.starts_at ?? '2026-09-16T11:00:00Z',
                  modality: ultima?.modality ?? 'presencial',
                  clinic_units: { name: unidade.name, address: unidade.address },
                }
              })(),
            }),
          insert: (linha) => ({
            select: () => ({
              maybeSingle: async () => {
                marcadas.push(linha)
                return { data: { id: `consulta-${marcadas.length}` }, error: null }
              },
            }),
          }),
          update: (campos) => ({
            eq: (_c, valor) => ({
              eq: async () => {
                if (campos.status === 'cancelled') canceladas.push(valor)
                return { error: null }
              },
              then: (r) => r({ error: null }),
            }),
          }),
        }
      }
      throw new Error('tabela nao prevista: ' + tabela)
    },
    async rpc(nome, args) {
      if (nome === 'liberar_reservas_vencidas') return { data: 0, error: null }
      if (nome === 'available_slots') return { data: SLOTS[args.p_unit_id] ?? [], error: null }
      throw new Error('rpc nao prevista: ' + nome)
    },
  }
  return { admin, conversa, marcadas, canceladas, cadastrados }
}

// ---------------------------------------------------------------
// Impressão
// ---------------------------------------------------------------

const LARGURA = 78
const linha = (c = '─') => c.repeat(LARGURA)

function bloco(texto, prefixo) {
  return texto
    .split('\n')
    .map((l) => prefixo + l)
    .join('\n')
}

async function conversar(titulo, mensagens, opcoes = {}) {
  const { admin, conversa, marcadas, canceladas, cadastrados } = fazerAdmin(opcoes)
  console.log('\n' + linha('━'))
  console.log('  ' + titulo.toUpperCase())
  console.log(linha('━'))

  let consultas = opcoes.consultas ?? []

  for (const texto of mensagens) {
    consultas = consultas.filter((c) => !canceladas.includes(c.id))
    console.log('\n' + bloco(texto, '  ▶ PACIENTE: ').replace('  ▶ PACIENTE: ', '  ▶ PACIENTE: '))

    const r = await tratarConversa({
      admin,
      clinicId: 'c1',
      conversationId: 'conv1',
      estadoAtual: conversa.booking_state,
      opcoesAtuais: conversa.booking_options,
      unidadeEmAndamento: conversa.booking_unit_id,
      modalidadeEmAndamento: conversa.booking_modality ?? null,
      pacienteEmAndamento: conversa.booking_patient_id ?? null,
      consultas,
      consultaASubstituir: conversa.booking_replaces_id ?? null,
      consultaEmCadastro: conversa.booking_intake_id ?? null,
      respostasNaEspera: conversa.auto_replies_while_waiting ?? 0,
      // "[ANEXO]" faz as vezes da foto que a Meta entrega sem corpo nenhum -
      // e sem corpo e literal: foto sem legenda chega com o texto vazio.
      anexo: texto === '[ANEXO]',
      jaViuOMenu: Boolean(conversa.menu_sent_at),
      podeIniciarMenu: true,
      texto: texto === '[ANEXO]' ? '' : texto,
      telefone: '5513999990000',
      pacientes: opcoes.pacientes ?? [],
      nomeDoPerfil: opcoes.nomeDoPerfil ?? 'Marina',
      textos: TEXTOS,
    })

    if (!r) {
      console.log('    (o robô fica em silêncio)')
      continue
    }
    console.log(bloco(r.resposta, '    '))
    if (r.botoes) console.log('    [botões] ' + r.botoes.map((b) => b.titulo).join(' | '))
    // Titulo e descricao: a descricao e o que explica para onde a linha leva, e
    // esconde-la aqui ja deixou passar um "Voce viu: Santos" numa linha que
    // servia justamente para ver as OUTRAS unidades.
    if (r.lista)
      console.log(
        `    [lista "${r.lista.rotulo}"] ` +
          r.lista.linhas.map((l) => (l.descricao ? `${l.titulo} (${l.descricao})` : l.titulo)).join(' | '),
      )
    if (r.atencao) console.log(`    ⚑ conversa marcada para a equipe: ${r.atencao}`)
  }

  if (marcadas.length) {
    console.log('\n  ── o que foi gravado ──')
    for (const m of marcadas) {
      console.log(`    consulta: ${m.starts_at} · unidade ${m.unit_id} · ${m.modality} · ${m.contact_name}`)
    }
  }
  if (cadastrados.length) {
    for (const c of cadastrados) console.log(`    cadastro criado: ${c.name}`)
  }
  if (canceladas.length) console.log(`    canceladas: ${canceladas.join(', ')}`)
}

// ---------------------------------------------------------------
// As jornadas
// ---------------------------------------------------------------

const ANA = {
  id: 'p1',
  name: 'Ana Paula Souza',
  nascimento: '2019-03-12',
  responsavel: 'Marina Souza',
  cpf: '39053344705',
  email: 'marina@exemplo.com',
}

await conversar('1. Mãe nova pergunta o valor e marca em Santos', [
  'Oi, boa tarde',
  '1',
  '1',
  '2',
  '1',
  '1',
  '2',
  'Helena Souza Lima',
  '14/03/2021',
  'Marina Souza Lima',
  'pular',
  'marina@exemplo.com',
])

await conversar('2. Pergunta escrita, sem passar pelo menu', ['quanto custa a consulta?', '2'])

await conversar('3. Convênio e endereço: resposta direta, sem perguntar onde', [
  'vocês atendem unimed?',
  'onde fica o consultório?',
])

await conversar('4. Telemedicina: informações e urgência', ['Boa noite', '1', '3', 'urgência'])

await conversar('5. Telemedicina: marcando de verdade', ['Oi', '2', '3', '1', '1'], { pacientes: [ANA] })

await conversar('6. Urgência como primeira mensagem', [
  'socorro, é urgente, meu filho está muito mal',
])

await conversar('7. Pergunta clínica não é respondida pelo robô', [
  'meu filho está com dor de barriga há 3 dias, posso dar dipirona?',
])

await conversar('8. Paciente conhecido vê e cancela a consulta', ['Olá', '4', 'cancelar', 'sim'], {
  pacientes: [ANA],
  consultas: [
    {
      id: 'c-1',
      inicio: '2026-09-16T11:00:00Z',
      unidade: 'Liferty · Santos',
      endereco: 'Al. Armênio Mendes, 66',
      paciente: 'Ana Paula Souza',
      confirmada: true,
    },
  ],
})

await conversar('9. Telemedicina desligada: o robô não a oferece', ['Oi', '2'], { teleAtiva: false })

await conversar('10. Urgência no meio da fila da equipe', ['Oi', '3', 'é urgente, ele está muito mal'])

// A quarta pergunta cai no silêncio de propósito: se três textos prontos não
// resolveram, o quarto também não resolve, e quem precisa responder é gente.
await conversar('11. Esperando a equipe: três respostas prontas, depois silêncio', [
  'Oi',
  '3',
  'vocês atendem unimed?',
  'onde fica o consultório?',
  'o que preciso levar?',
  'e quanto tempo demora a consulta?',
])

// Mudar de assunto no meio de uma escolha: o robô responde e repete a pergunta.
await conversar('12. Pergunta no meio da escolha da unidade', [
  'Oi',
  '1',
  'Convenio',
  '1',
])

// Foto de exame: o robô não lê, então entrega para a equipe em vez de mandar
// menu para quem acabou de enviar o ultrassom do filho.
await conversar('13. Mandou uma foto do exame', ['Oi', '[ANEXO]', '[ANEXO]'])

// Como a pessoa pede para marcar quando ninguém explicou o formato.
for (const frase of [
  'quero marcar retorno para Anthony Silveira da Cunha',
  'queria marcar uma consulta',
  'gostaria de agendar para o meu filho',
  'quero remarcar',
  'marcar',
]) {
  await conversar(`14. "${frase}"`, [frase], { pacientes: [ANA] })
}

// 2ª via de receita e pedido de exame: o caminho que nasceu do laboratório
// devolvendo o pedido por causa do CID.
await conversar('15. 2ª via de receita, com a farmácia exigindo correção', [
  'Oi',
  '5',
  '1',
  'Domperidona 1mg/ml',
  'a farmácia disse que a validade venceu',
], { pacientes: [ANA] })

await conversar('16. Pedido de exame, sem exigência nenhuma', [
  'Oi',
  '5',
  '2',
  'Ultrassom de abdome total',
  'não',
], { pacientes: [ANA] })

await conversar('17. Controlado: sai do automático antes de prometer prazo', [
  'Oi',
  '5',
  '1',
  'Rivotril',
], { pacientes: [ANA] })

await conversar('18. Farmácia escrevendo de um número desconhecido', [
  'Oi',
  '5',
  '2',
  'paciente Gabriel Souza, o CID não confere com o exame pedido',
])

await conversar('19. Número desconhecido que diz ser o responsável', ['Oi', '5', '1'])

await conversar('20. Foto do documento recusado no lugar da explicação', [
  'Oi',
  '5',
  '1',
  'Omeprazol',
  '[ANEXO]',
], { pacientes: [ANA] })

console.log('\n' + linha('━'))
console.log('  fim da simulação')
console.log(linha('━') + '\n')
