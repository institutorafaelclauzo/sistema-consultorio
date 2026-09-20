// Bateria completa do atendimento automatico do WhatsApp.
//
// Cada caso descreve o que a pessoa digita e o que a resposta PRECISA conter.
// A ideia nao e imprimir tela bonita: e falhar sozinho quando o robo mudar de
// comportamento sem querer.
//
// Como rodar:  npm run test:bot
//
// O banco aqui e falso e mora neste arquivo. Isso e proposital: o objetivo e
// exercitar as DECISOES do robo (o que responder, o que gravar, quando ficar
// calado), e nao o Supabase.
import { tratarConversa, iniciarQuestionario } from './atendimento.build.mjs'

// ---------------------------------------------------------------
// Banco falso
// ---------------------------------------------------------------

function fazerAdmin({
  unidades,
  slotsPorUnidade,
  falharSlots = false,
  erroInsert = null,
  remarcacoesAnteriores = 0,
  respostasProntas = [],
  telemedicina = { ativa: false, texto: '' },
  // Colunas que este banco falso NÃO tem. Recusa o update inteiro quando
  // alguma aparece, que é exatamente o que o Postgres faz.
  colunasAusentes = [],
}) {
  const conversa = {
    booking_state: null,
    booking_options: null,
    booking_unit_id: null,
    booking_patient_id: null,
    booking_replaces_id: null,
    menu_sent_at: null,
  }
  const marcadas = []
  const canceladas = []
  // O que foi gravado na ficha do paciente. Antes o banco falso nem conhecia a
  // tabela: a ficha so era exercitada ate a PRIMEIRA pergunta, e o que
  // acontecia com a resposta ninguem via.
  const fichas = []

  const chain = (resultado) => ({
    select: () => chain(resultado),
    eq: (_col, valor) => chain(resultado._porId ? { ...resultado, single: resultado._porId(valor) } : resultado),
    is: () => chain(resultado),
    order: () => chain(resultado),
    limit: () => chain(resultado),
    maybeSingle: async () => ({ data: resultado.single ?? null, error: resultado.erro ?? null }),
    then: (r) => r({ data: resultado.list ?? (resultado.erro ? null : []), error: resultado.erro ?? null }),
  })

  const admin = {
    from(tabela) {
      if (tabela === 'whatsapp_conversations') {
        return {
          update: (campos) => {
            const faltando = colunasAusentes.filter((c) => c in campos)
            if (faltando.length > 0) {
              return {
                eq: async () => ({
                  error: { code: '42703', message: `column ${faltando[0]} does not exist` },
                }),
              }
            }
            Object.assign(conversa, campos)
            return { eq: async () => ({}) }
          },
        }
      }
      if (tabela === 'clinic_units') {
        return {
          select: (colunas = '') => {
            // Postgres recusa a consulta INTEIRA quando uma coluna não existe.
            const faltando = colunasAusentes.find((c) => String(colunas).includes(c))
            if (faltando) {
              return chain({
                list: null,
                single: null,
                erro: { code: '42703', message: `column ${faltando} does not exist` },
              })
            }
            return chain({
              list: unidades,
              single: unidades[0],
              _porId: (id) => unidades.find((u) => u.id === id) ?? null,
            })
          },
        }
      }
      // Ficha do paciente. Recebe o que a familia responde quando ja existe
      // cadastro - e, desde 16/09/2026, e o unico destino quando a equipe
      // dispara o questionario para quem nao tem consulta marcada.
      if (tabela === 'patients') {
        return {
          select: () => chain({ single: null, list: [] }),
          update: (campos) => ({
            eq: async (_coluna, valor) => {
              fichas.push({ id: valor, ...campos })
              return { error: null }
            },
          }),
        }
      }
      if (tabela === 'clinics') {
        return { select: () => chain({ single: { timezone: 'America/Sao_Paulo' } }) }
      }
      // Respostas prontas: o que a clinica cadastrou para o robo responder
      // sozinho. Vazio por padrao - a maioria dos casos nao passa por aqui.
      if (tabela === 'bot_answers') {
        return { select: () => chain({ list: respostasProntas }) }
      }
      // Telemedicina: desligada por padrao, para os casos antigos continuarem
      // vendo so as unidades fisicas.
      if (tabela === 'clinic_settings') {
        return {
          select: () =>
            chain({
              single: {
                telemedicine_enabled: telemedicina.ativa,
                telemedicine_info_text: telemedicina.texto,
              },
            }),
        }
      }
      if (tabela === 'appointments') {
        return {
          // A consulta lida de volta. Alem do contador de remarcacoes, traz o
          // horario e a unidade: e com eles que o fim do questionario decide se
          // monta um comprovante. O horario e FUTURO de proposito, para o teste
          // do questionario manual provar que quem segura o comprovante e a
          // regra do "manual", e nao a data.
          select: () =>
            chain({
              single: {
                reschedule_count: remarcacoesAnteriores,
                starts_at: '2027-09-14T18:00:00Z',
                modality: 'presencial',
                clinic_units: { name: 'Livance Ibirapuera - São Paulo', address: 'Rua Y, 30' },
              },
            }),
          // A consulta marcada e lida de volta: e o id dela que a ficha de
          // dados (nome, nascimento, CPF...) usa para saber onde guardar.
          insert: (linha) => ({
            select: () => ({
              maybeSingle: async () => {
                if (erroInsert) return { data: null, error: erroInsert }
                // Coluna que este banco não tem recusa o INSERT inteiro, como
                // o Postgres faz. Sem isto, o plano B de marcar() passaria
                // sem nunca ter sido exercitado.
                const faltando = colunasAusentes.find((c) => c in linha)
                if (faltando) {
                  return {
                    data: null,
                    error: { code: '42703', message: `column ${faltando} does not exist` },
                  }
                }
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
            }),
          }),
        }
      }
      throw new Error('tabela nao prevista: ' + tabela)
    },
    async rpc(nome, args) {
      if (nome === 'liberar_reservas_vencidas') return { data: 0, error: null }
      if (nome === 'available_slots') {
        if (falharSlots) {
          return { data: null, error: { code: '42501', message: 'permission denied for table clinics' } }
        }
        return { data: slotsPorUnidade[args.p_unit_id] ?? [], error: null }
      }
      throw new Error('rpc nao prevista: ' + nome)
    },
  }
  return { admin, conversa, marcadas, canceladas, fichas }
}

const TRES_UNIDADES = [
  { id: 'u-santos', name: 'Liferty · Santos', address: 'Av. Ana Costa, 100' },
  { id: 'u-andre', name: 'Livance · Santo André', address: 'Rua X, 20' },
  // Nome longo de proposito: 30 caracteres, igual ao da unidade real. Foi ele
  // que estourou o limite de 24 da Meta e fez a lista chegar sem botao.
  { id: 'u-vila', name: 'Livance Ibirapuera - São Paulo', address: 'Rua Y, 30' },
]
const UMA_UNIDADE = [TRES_UNIDADES[0]]

const diasSantos = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-07', '2026-09-08']
const horasManha = ['11:00', '11:40', '12:20', '13:00', '13:40', '14:20'] // UTC -> 08h a 11h20 BRT
const SLOTS_CHEIOS = {
  'u-santos': diasSantos.flatMap((d) =>
    horasManha.map((h) => ({ slot_start: `${d}T${h}:00Z`, slot_end: `${d}T${h}:40Z` })),
  ),
  'u-andre': [],
  'u-vila': [],
}
const SLOTS_VAZIOS = { 'u-santos': [], 'u-andre': [], 'u-vila': [] }

const TEXTOS = {
  saudacao: 'Olá! Aqui é o consultório do Dr. Rafael Clauzo, médico do Instituto Clauzo.',
  saudacaoConhecida: 'Olá, {nome}! Aqui é o consultório do Dr. Rafael Clauzo.',
  informacoes: 'O valor da consulta é R$ 450,00.\n13 3273-6828',
}

// Ana tem a ficha completa: e o paciente de anos, que nao deve ser
// interrogado de novo. Pedro so tem o nome, e serve para exercitar a ficha.
const ANA = {
  id: 'p1',
  name: 'Ana Paula Souza',
  nascimento: '2019-03-12',
  responsavel: 'Marina Souza',
  cpf: '39053344705',
  email: 'marina@exemplo.com',
}
const PEDRO = { id: 'p2', name: 'Pedro Souza' }

// ---------------------------------------------------------------
// Motor de casos
// ---------------------------------------------------------------

let passou = 0
const falhas = []
const achados = []

/**
 * `passos` e uma lista de [mensagem, esperado].
 * `esperado` pode ser:
 *   - string  -> a resposta precisa conter esse trecho
 *   - array   -> precisa conter todos
 *   - null    -> o robo precisa ficar em silencio
 */
async function caso(titulo, passos, opcoes = {}) {
  const { admin, conversa, marcadas, canceladas, fichas } = fazerAdmin({
    unidades: opcoes.unidades ?? TRES_UNIDADES,
    slotsPorUnidade: opcoes.slots ?? SLOTS_CHEIOS,
    falharSlots: opcoes.falharSlots,
    erroInsert: opcoes.erroInsert,
    remarcacoesAnteriores: opcoes.remarcacoesAnteriores ?? 0,
    respostasProntas: opcoes.respostasProntas ?? [],
    telemedicina: opcoes.telemedicina ?? { ativa: false, texto: '' },
    colunasAusentes: opcoes.colunasAusentes ?? [],
  })

  // A conversa começa como se o menu já tivesse aparecido alguma vez.
  //
  // Desde 16/09/2026 a PRIMEIRA mensagem de alguém sempre recebe o menu, sem
  // atalho: quem chega pelo botão do site, com "gostaria de agendar" escrito
  // pronto, precisa ver a apresentação e as outras opções antes de ser levado
  // para dentro do agendamento. Os casos abaixo testam o que acontece DEPOIS
  // disso, então nascem com o menu já visto. Quem quiser testar a primeira
  // mensagem passa `primeiraMensagem: true`.
  conversa.menu_sent_at = opcoes.primeiraMensagem ? null : '2026-08-31T12:00:00Z'

  const transcricao = []
  let ultimoToque = { resposta: '', botoes: undefined, lista: undefined }

  // O webhook real relê as consultas futuras a cada mensagem, entao uma que foi
  // cancelada some da lista. O banco falso precisa fazer o mesmo, senao o teste
  // pergunta ao robo sobre uma consulta que ja nao existe.
  let consultas = opcoes.consultas ?? []

  // Terceiro item do passo: ajustes que valem só daquela mensagem em diante.
  // Serve para simular alguém da equipe entrando no meio da conversa, que é
  // quando o robô precisa se calar.
  let ajustes = {}
  for (const [texto, esperado, mudanca] of passos) {
    if (mudanca) ajustes = { ...ajustes, ...mudanca }
    consultas = consultas.filter((c) => !canceladas.includes(c.id))
    const r = await tratarConversa({
      admin,
      clinicId: 'c1',
      conversationId: 'conv1',
      estadoAtual: conversa.booking_state,
      opcoesAtuais: conversa.booking_options,
      unidadeEmAndamento: conversa.booking_unit_id,
      modalidadeEmAndamento: conversa.booking_modality ?? null,
      pacienteEmAndamento: conversa.booking_patient_id ?? null,
      // A consulta cuja ficha esta sendo preenchida. Faltava aqui: sem ela, a
      // segunda resposta da familia caia no "nao ha onde guardar" e o teste
      // nunca via o questionario ate o fim.
      consultaEmCadastro: conversa.booking_intake_id ?? null,
      convenioEmAndamento: conversa.booking_insurance ?? null,
      consultas,
      consultaASubstituir: conversa.booking_replaces_id ?? null,
      // Quantas respostas prontas o robo ja deu nesta espera pela equipe. Sai
      // do banco falso, como no webhook de verdade, para o limite de tres ser
      // contado entre uma mensagem e outra.
      respostasNaEspera: conversa.auto_replies_while_waiting ?? 0,
      // A mensagem e um anexo? No teste, o texto "[ANEXO]" faz as vezes da foto
      // que a Meta entrega sem corpo nenhum.
      anexo: texto === '[ANEXO]',
      // ... e sem corpo nenhum e literal: foto sem legenda chega com texto
      // vazio. Mandar a palavra "[ANEXO]" como se fosse o que a pessoa
      // escreveu faria o robo guardar isso como resposta dela - foi assim que
      // o pedido de 2a via registrou "[ANEXO]" no lugar do motivo.
      // O banco falso guarda menu_sent_at como o de verdade: assim o teste sabe
      // se aquela mensagem e a primeira da conversa.
      jaViuOMenu: Boolean(conversa.menu_sent_at),
      podeIniciarMenu: ajustes.podeIniciarMenu ?? opcoes.podeIniciarMenu ?? true,
      texto: texto === '[ANEXO]' ? '' : texto,
      telefone: opcoes.telefone ?? '5511999999999',
      pacientes: opcoes.pacientes ?? [],
      nomeDoPerfil: opcoes.nomeDoPerfil ?? 'Paula Medina',
      textos: opcoes.textos ?? TEXTOS,
    })

    const resposta = r?.resposta ?? null
    ultimoToque = { resposta: r?.resposta ?? '', botoes: r?.botoes, lista: r?.lista, concluida: r?.concluida, atencao: r?.atencao }
    transcricao.push(`  > ${texto}\n    ${resposta ? resposta.replace(/\n/g, '\n    ') : '(silêncio)'}`)

    if (esperado === null) {
      if (resposta !== null) {
        falhas.push(`${titulo} | "${texto}" deveria ser silêncio, veio: ${resposta.slice(0, 60)}`)
      } else passou++
      continue
    }

    const trechos = Array.isArray(esperado) ? esperado : [esperado]
    for (const trecho of trechos) {
      if (resposta && resposta.includes(trecho)) passou++
      else {
        falhas.push(
          `${titulo} | "${texto}" deveria conter "${trecho}"\n     veio: ${(resposta ?? '(silêncio)').slice(0, 140)}`,
        )
      }
    }
  }

  if (opcoes.verificar) {
    opcoes.verificar({ marcadas, canceladas, conversa, transcricao, titulo, ultimoToque, fichas })
  }
  return { marcadas, canceladas, conversa, transcricao, fichas }
}

// ---------------------------------------------------------------
// 1. Menu
// ---------------------------------------------------------------

await caso('Primeiro contato mostra o menu', [
  ['Oi', ['Aqui é o consultório', '*1* 💬 Dúvidas', '*2* 🗓️ Marcar', '*3* 🗣️ Falar com alguém', '*4* 🔄 Ver, remarcar']],
])

await caso('Paciente cadastrado é chamado pelo nome', [['Oi', 'Olá, Ana!']], { pacientes: [ANA] })

await caso('Dois pacientes no telefone: saudação sem nome', [['Oi', 'Aqui é o consultório']], {
  pacientes: [ANA, PEDRO],
})

// Com mais de uma unidade, a opcao 1 pergunta onde antes de responder: o
// valor de Santos nao e o de Sao Paulo. O texto geral da clinica continua
// valendo para a unidade que nao tem texto proprio.
await caso('Opção 1 pergunta a unidade e depois entrega as informações', [
  ['Oi', 'Como podemos ajudar'],
  ['1', ['Para qual atendimento', '*1* Liferty · Santos', '*3* Livance Ibirapuera']],
  ['1', ['R$ 450,00', 'ver outra unidade']],
])

// Com um atendimento só, o robô não oferece "ver outra unidade": o *1* levava
// de volta à mesmíssima mensagem, que convidava de novo a ver a outra unidade
// que não existe. Digita 1, lê o mesmo texto, digita 1, lê o mesmo texto.
await caso('Opção 1 com uma unidade só responde direto, e sem oferecer outra', [
  ['Oi', 'Como podemos ajudar'],
  ['1', ['R$ 450,00', 'voltar ao início']],
], {
  unidades: UMA_UNIDADE,
  verificar: ({ ultimoToque, titulo }) => {
    if (ultimoToque.resposta.includes('outra unidade')) {
      falhas.push(`${titulo} | ofereceu uma unidade que não existe`)
    } else passou++
    const ids = (ultimoToque.lista?.linhas ?? []).map((l) => l.id)
    if (ids.includes('1')) falhas.push(`${titulo} | a lista ainda tem a linha "Outra unidade"`)
    else passou++
  },
})

// O fecho comum (telefones, horario, como agendar) vai no fim do texto de
// qualquer unidade: e o campo antigo de informacoes, editado uma vez so.
await caso('O fecho comum vai no fim do texto da unidade', [
  ['Oi', 'Como podemos ajudar'],
  ['1', 'Para qual atendimento'],
  ['3', ['R$ 550,00', '13 3273-6828']],
], {
  unidades: [TRES_UNIDADES[0], TRES_UNIDADES[1], { ...TRES_UNIDADES[2], info_text: '*Consulta em São Paulo: R$ 550,00.*' }],
})

await caso('Texto próprio da unidade vence o texto geral', [
  ['Oi', 'Como podemos ajudar'],
  ['1', 'Para qual atendimento'],
  ['3', ['R$ 550,00', 'Vila Clementino']],
], {
  unidades: [
    TRES_UNIDADES[0],
    TRES_UNIDADES[1],
    { ...TRES_UNIDADES[2], info_text: '*Consulta em São Paulo: R$ 550,00.*\nVila Clementino.' },
  ],
})

await caso('Opção 3 chama a equipe e sinaliza', [
  ['Oi', 'Como podemos ajudar'],
  ['3', ['direcionando você para um atendente', 'segunda a sexta']],
  ['tenho uma dúvida', null],
])

await caso('Resposta sem sentido no menu não deixa no vácuo', [
  ['Oi', 'Como podemos ajudar'],
  ['blablabla', ['Não entendi', '*1* 💬 Dúvidas']],
  ['7', ['Não entendi', '*2* 🗓️ Marcar']],
])

await caso('MENU volta ao início de qualquer etapa', [
  ['agendar', 'Em qual unidade'],
  ['1', 'Datas disponíveis'],
  ['MENU', 'Como podemos ajudar'],
])

await caso('0 também volta ao menu', [
  ['agendar', 'Em qual unidade'],
  ['0', 'Como podemos ajudar'],
])

await caso('ATENDENTE funciona no meio do agendamento', [
  ['agendar', 'Em qual unidade'],
  ['atendente', 'direcionando você'],
])

await caso('CANCELAR no meio do fluxo devolve ao menu', [
  ['agendar', 'Em qual unidade'],
  ['cancelar', ['parei por aqui', '*1* 💬 Dúvidas']],
])

// ---------------------------------------------------------------
// 2. Agendamento
// ---------------------------------------------------------------

await caso(
  'Cadastrado marca direto e a consulta sai confirmada',
  [
    ['Oi', 'Olá, Ana!'],
    ['2', 'Em qual unidade'],
    ['1', 'Datas disponíveis'],
    ['1', 'Horários de'],
    ['1', ['Consulta marcada!', 'Av. Ana Costa', 'confirmar sua presença']],
  ],
  {
    pacientes: [ANA],
    verificar: ({ marcadas, titulo }) => {
      const m = marcadas[0]
      if (!m) return falhas.push(`${titulo} | nenhuma consulta gravada`)
      if (m.confirmed_by_clinic !== true) falhas.push(`${titulo} | deveria nascer confirmada`)
      else passou++
      if (m.hold_expires_at !== null) falhas.push(`${titulo} | cadastrado não deve ter reserva provisória`)
      else passou++
      if (m.patient_id !== 'p1') falhas.push(`${titulo} | patient_id errado: ${m.patient_id}`)
      else passou++
    },
  },
)

await caso(
  'Sem cadastro também sai com a consulta confirmada na hora',
  [
    ['Oi', 'Aqui é o consultório'],
    ['2', 'Em qual unidade'],
    ['1', 'Datas disponíveis'],
    ['1', 'Horários de'],
    // Nada de "solicitacao": quem chega pelo WhatsApp e quem menos conhece a
    // clinica, e sai daqui com o horario garantido. O comprovante inteiro vem
    // depois da ficha, para ser a ultima coisa da conversa.
    ['1', ['está guardado', 'perguntas rápidas', 'nome completo do paciente']],
  ],
  {
    verificar: ({ marcadas, titulo }) => {
      const m = marcadas[0]
      if (!m) return falhas.push(`${titulo} | nenhuma consulta gravada`)
      if (m.confirmed_by_clinic !== true) falhas.push(`${titulo} | deveria nascer confirmada`)
      else passou++
      if (m.hold_expires_at !== null) falhas.push(`${titulo} | não deve mais reservar provisoriamente`)
      else passou++
      if (m.contact_name !== 'Paula Medina')
        falhas.push(`${titulo} | deveria usar o nome do WhatsApp, veio "${m.contact_name}"`)
      else passou++
    },
  },
)

await caso(
  'Dois irmãos: pergunta e grava no escolhido',
  [
    ['Oi', 'Como podemos ajudar'],
    ['2', ['Para quem é a consulta', '*1* Ana Paula Souza', '*2* Pedro Souza', 'Digite *9*']],
    ['2', 'Em qual unidade'],
    ['1', 'Datas disponíveis'],
    ['1', 'Horários de'],
    ['2', 'está guardado'],
  ],
  {
    pacientes: [ANA, PEDRO],
    verificar: ({ marcadas, titulo }) => {
      const m = marcadas[0]
      if (m?.patient_id !== 'p2') falhas.push(`${titulo} | gravou no paciente errado: ${m?.patient_id}`)
      else passou++
      if (m?.contact_name !== 'Pedro Souza')
        falhas.push(`${titulo} | nome errado na consulta: ${m?.contact_name}`)
      else passou++
    },
  },
)

await caso(
  'Uma unidade só: pula a pergunta de unidade',
  [
    ['Oi', 'Como podemos ajudar'],
    ['2', 'Datas disponíveis'],
  ],
  { unidades: UMA_UNIDADE },
)

await caso('Unidade sem agenda: continua na lista, não trava', [
  ['agendar', 'Em qual unidade'],
  ['2', ['não temos horários abertos em Livance · Santo André', 'outra unidade da lista']],
  ['1', 'Datas disponíveis'],
])

await caso(
  'Nenhuma unidade com agenda: manda para a equipe',
  [
    ['agendar', ['não temos horários abertos para agendamento', '*9*']],
  ],
  { slots: SLOTS_VAZIOS },
)

await caso(
  'Banco recusando a consulta: admite a falha em vez de mentir',
  [['agendar', ['Tive um problema para consultar a agenda', 'Já avisei a nossa equipe']]],
  { falharSlots: true },
)

await caso(
  'Horário tomado por outro entre a lista e a escolha',
  [
    ['agendar', 'Em qual unidade'],
    ['1', 'Datas disponíveis'],
    ['1', 'Horários de'],
    ['1', ['acabou de ser ocupado', 'Digite *2* para ver os horários atualizados']],
  ],
  { erroInsert: { code: '23505' } },
)

await caso(
  'Falha inesperada ao gravar: nao promete o que nao cumpriu',
  [
    ['agendar', 'Em qual unidade'],
    ['1', 'Datas disponíveis'],
    ['1', 'Horários de'],
    ['1', ['Não consegui concluir o agendamento', 'equipe']],
  ],
  { erroInsert: { code: '42501', message: 'boom' } },
)

await caso('VOLTAR sobe um nível de cada vez', [
  ['agendar', 'Em qual unidade'],
  ['1', 'Datas disponíveis'],
  ['1', 'Horários de'],
  ['VOLTAR', 'Datas disponíveis'],
  ['VOLTAR', 'Em qual unidade'],
  ['VOLTAR', 'Como podemos ajudar'],
])

await caso(
  'VOLTAR com dois irmãos sobe até a escolha do paciente',
  [
    ['agendar', 'Para quem é a consulta'],
    ['1', 'Em qual unidade'],
    ['VOLTAR', 'Para quem é a consulta'],
    ['VOLTAR', 'Como podemos ajudar'],
  ],
  { pacientes: [ANA, PEDRO] },
)

await caso('Número fora da faixa em cada etapa', [
  ['agendar', 'Em qual unidade'],
  ['99', ['Não entendi', 'número da unidade']],
  ['1', 'Datas disponíveis'],
  ['99', ['Não entendi', 'número do dia']],
  ['1', 'Horários de'],
  ['99', ['Não entendi', 'número do horário']],
])

// ---------------------------------------------------------------
// 3. Silêncio
// ---------------------------------------------------------------

// Quem escolhe a opcao 3 e quem realmente cala o robo - e so ele. A bandeira de
// atencao deixou de silenciar em 30/08/2026: ela acende tambem para quem
// cancelou sozinho, e essa pessoa nao esta esperando ninguem falar.
await caso('Quem pediu atendente: robô não fala por cima', [
  ['Oi', 'Como podemos ajudar'],
  ['3', 'direcionando você'],
  ['tudo bem?', null],
  ['e aí?', null],
])


await caso('Mas MENU fura o silêncio e o fluxo volta a responder', [
  ['Oi', 'Como podemos ajudar'],
  ['3', 'direcionando você'],
  ['tudo bem?', null],
  ['MENU', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
])


await caso('Respondendo acompanhamento: nada de menu', [['Estou bem, obrigada', null]], {
  podeIniciarMenu: false,
})

await caso(
  'Mas quem pede para agendar é atendido mesmo assim',
  [['agendar', 'Em qual unidade']],
  { podeIniciarMenu: false },
)

// ---------------------------------------------------------------
// 4. Bordas de texto
// ---------------------------------------------------------------

await caso('Aceita "1." e "opção 2"', [
  ['Oi', 'Como podemos ajudar'],
  ['1.', 'Para qual atendimento'],
  ['1', 'R$ 450,00'],
  ['opção 2', 'Em qual unidade'],
])

await caso('Mensagem de áudio não quebra o fluxo', [
  ['Oi', 'Como podemos ajudar'],
  ['[audio]', 'Não entendi'],
])

await caso(
  'Sem textos configurados, ainda existe uma saudação',
  [['Oi', ['Aqui é o consultório do Dr. Rafael Clauzo, Instituto Clauzo', '*1* 💬 Dúvidas']]],
  { textos: { saudacao: '', saudacaoConhecida: '', informacoes: '' } },
)

await caso(
  'Opção 1 sem texto cadastrado não devolve mensagem vazia',
  [
    ['Oi', 'Como podemos ajudar'],
    ['1', '*1* 💬 Dúvidas'],
  ],
  { textos: { ...TEXTOS, informacoes: '' }, unidades: UMA_UNIDADE },
)

// ---------------------------------------------------------------
// 4b. Minha consulta (opcao 4)
// ---------------------------------------------------------------

const CONSULTA_ANA = {
  id: 'a1',
  inicio: '2026-09-01T11:00:00Z',
  unidade: 'Liferty · Santos',
  endereco: 'Av. Ana Costa, 100',
  paciente: 'Ana Paula Souza',
  confirmada: true,
}

await caso('Sem consulta marcada, a opção 4 não deixa no vácuo', [
  ['Oi', 'Como podemos ajudar'],
  ['4', ['Não encontrei nenhuma consulta marcada', 'Digite *2* para agendar']],
])

await caso(
  'Com consulta marcada, a opção 4 mostra os dados',
  [
    ['Oi', 'Como podemos ajudar'],
    ['4', ['Sua consulta', 'Ana Paula Souza', 'Liferty · Santos', 'CANCELAR', 'REMARCAR']],
  ],
  { consultas: [CONSULTA_ANA] },
)

await caso(
  'Cancelar exige confirmação explícita',
  [
    ['Oi', 'Como podemos ajudar'],
    ['4', 'Sua consulta'],
    ['CANCELAR', ['Confirma o cancelamento', 'Responda SIM']],
    ['não', ['continua marcada', '*1* 💬 Dúvidas']],
  ],
  {
    consultas: [CONSULTA_ANA],
    verificar: ({ canceladas, titulo }) => {
      if (canceladas.length > 0) falhas.push(`${titulo} | cancelou sem o SIM`)
      else passou++
    },
  },
)

await caso(
  'Cancelar com SIM desmarca e acende a conversa',
  [
    ['Oi', 'Como podemos ajudar'],
    ['4', 'Sua consulta'],
    ['CANCELAR', 'Responda SIM'],
    ['SIM', ['Consulta cancelada', 'digite 2']],
  ],
  {
    consultas: [CONSULTA_ANA],
    verificar: ({ canceladas, titulo }) => {
      if (canceladas[0] !== 'a1') falhas.push(`${titulo} | não cancelou a consulta certa`)
      else passou++
    },
  },
)

// Quem desiste no meio das perguntas fica com a consulta marcada e a ficha
// vazia. Até 16/09/2026 a remarcação pulava a ficha inteira, e virava a porta
// dos fundos para nunca mais responder nada: foi o caso do Sandro, que saiu na
// primeira pergunta, remarcou e recebeu "Consulta remarcada!" sem cadastro.
await caso('Remarcação de quem não completou o cadastro volta a perguntar', [
  ['Oi', 'Como podemos ajudar'],
  ['4', 'Sua consulta'],
  ['REMARCAR', 'Vamos remarcar'],
  ['SIM', 'Em qual unidade'],
  ['1', 'Datas disponíveis'],
  ['1', 'Horários de'],
  ['1', ['está guardado', 'nome completo do paciente']],
], {
  // Consulta existente sem paciente vinculado: é o contato que marcou pelo
  // WhatsApp e abandonou as perguntas.
  consultas: [{ ...CONSULTA_ANA, paciente: 'Sandro' }],
  pacientes: [],
})

// E quem já tem tudo continua sem ser interrogado na remarcação.
await caso(
  'Remarcar leva a contagem adiante em vez de zerar',
  [
    ['Oi', 'Como podemos ajudar'],
    ['4', 'Sua consulta'],
    ['REMARCAR', 'Vamos remarcar'],
    ['SIM', 'Em qual unidade'],
    ['1', 'Datas disponíveis'],
    ['1', 'Horários de'],
    ['1', 'Consulta remarcada!'],
  ],
  {
    consultas: [CONSULTA_ANA],
    pacientes: [ANA],
    // A antiga ja tinha trocado de data duas vezes.
    remarcacoesAnteriores: 2,
    verificar: ({ marcadas, titulo }) => {
      const nova = marcadas[0] ?? {}
      // Remarcar cria linha nova e cancela a antiga. Sem carregar a contagem, a
      // terceira troca de data apareceria na agenda como se fosse a primeira.
      if (nova.reschedule_count !== 3) {
        falhas.push(`${titulo} | esperava contagem 3, veio ${nova.reschedule_count}`)
      } else passou++
      if (nova.rescheduled_from !== 'a1') {
        falhas.push(`${titulo} | perdeu o vínculo com a consulta anterior`)
      } else passou++
    },
  },
)

await caso(
  'Marcação nova nasce com contagem zero',
  [
    ['agendar', 'Em qual unidade'],
    ['1', 'Datas disponíveis'],
    ['1', 'Horários de'],
    ['1', 'Consulta marcada!'],
  ],
  {
    pacientes: [ANA],
    verificar: ({ marcadas, titulo }) => {
      const nova = marcadas[0] ?? {}
      if (nova.reschedule_count !== 0 || nova.rescheduled_from !== null) {
        falhas.push(`${titulo} | consulta nova não deveria contar remarcação`)
      } else passou++
    },
  },
)

await caso(
  'Remarcar so cancela a antiga depois que a nova entra',
  [
    ['Oi', 'Como podemos ajudar'],
    ['4', 'Sua consulta'],
    ['REMARCAR', ['Vamos remarcar', 'só será cancelada depois']],
    ['SIM', 'Em qual unidade'],
    ['1', 'Datas disponíveis'],
    ['1', 'Horários de'],
    ['1', 'Consulta remarcada!'],
  ],
  {
    consultas: [CONSULTA_ANA],
    pacientes: [ANA],
    verificar: ({ marcadas, canceladas, titulo }) => {
      if (marcadas.length !== 1) falhas.push(`${titulo} | deveria marcar exatamente uma`)
      else passou++
      if (canceladas[0] !== 'a1') falhas.push(`${titulo} | não cancelou a antiga`)
      else passou++
    },
  },
)

await caso(
  'Quem já tem consulta é avisado antes de criar outra',
  [
    ['Oi', 'Como podemos ajudar'],
    ['2', ['Você já tem uma consulta marcada', '1 - Remarcar', '2 - Marcar mais uma']],
  ],
  { consultas: [CONSULTA_ANA], pacientes: [ANA] },
)

await caso(
  'Escolhendo "marcar mais uma", segue o fluxo normal',
  [
    ['Oi', 'Como podemos ajudar'],
    ['2', 'Você já tem uma consulta'],
    ['2', 'Em qual unidade'],
    ['1', 'Datas disponíveis'],
    ['1', 'Horários de'],
    ['1', 'Consulta marcada!'],
  ],
  {
    consultas: [CONSULTA_ANA],
    pacientes: [ANA],
    verificar: ({ canceladas, titulo }) => {
      if (canceladas.length > 0) falhas.push(`${titulo} | não devia cancelar a existente`)
      else passou++
    },
  },
)

// Regressao de 30/08/2026: o cancelamento acende a bandeira de atencao, e a
// bandeira silencia o robo quando nao ha etapa aberta. A mensagem prometia
// "digite 2" e o robo emudecia. O menu tem de continuar ativo depois de toda
// mensagem que oferece um numero.
await caso(
  'Depois de cancelar, o "2" prometido continua funcionando',
  [
    ['Oi', 'Como podemos ajudar'],
    ['4', 'Sua consulta'],
    ['CANCELAR', 'Responda SIM'],
    ['SIM', ['Consulta cancelada', 'digite 2']],
    ['2', 'Em qual unidade'],
  ],
  { consultas: [CONSULTA_ANA], pacientes: [ANA] },
)

await caso(
  'Depois de cancelar, um "Oi" novo não cai no vácuo',
  [
    ['Oi', 'Como podemos ajudar'],
    ['4', 'Sua consulta'],
    ['CANCELAR', 'Responda SIM'],
    ['SIM', 'Consulta cancelada'],
    ['Oi', ['*1* 💬 Dúvidas', '*2* 🗓️ Marcar']],
  ],
  { consultas: [CONSULTA_ANA], pacientes: [ANA] },
)

await caso(
  'Horário tomado por outro: o "2" prometido também funciona',
  [
    ['agendar', 'Em qual unidade'],
    ['1', 'Datas disponíveis'],
    ['1', 'Horários de'],
    ['1', 'Digite *2* para ver os horários atualizados'],
    ['2', 'Em qual unidade'],
  ],
  { erroInsert: { code: '23505' } },
)

// ---------------------------------------------------------------
// 4c. Botoes e listas tocaveis
//
// A Meta recusa a mensagem INTEIRA quando um limite estoura, entao os limites
// sao verificados aqui: 3 botoes, 10 linhas, titulo de botao com 20, linha com
// 24, descricao com 72.
// ---------------------------------------------------------------

/**
 * Toda lista precisa terminar com a volta ao menu.
 *
 * Sem ela, quem so toca fica preso: o texto oferece "0", mas quem nao le o
 * texto - que e justamente quem usa a lista - nao tem por onde sair.
 */
function conferirSaida(toque, titulo) {
  const linhas = toque?.lista?.linhas
  if (!linhas) return
  // O proprio menu nao precisa de linha para voltar ao menu.
  if (toque.lista.rotulo === 'Ver opções') return
  const fim = linhas[linhas.length - 1]
  if (fim.id !== '0') falhas.push(`${titulo} | lista sem saída tocável no fim (último id: ${fim.id})`)
  else passou++
}

function conferirLimites(toque, titulo) {
  conferirSaida(toque, titulo)
  for (const b of toque.botoes ?? []) {
    if (b.titulo.length > 20) falhas.push(`${titulo} | botão "${b.titulo}" passa de 20 caracteres`)
    else passou++
  }
  if ((toque.botoes ?? []).length > 3) falhas.push(`${titulo} | mais de 3 botões`)

  const lista = toque.lista
  if (lista) {
    if (lista.rotulo.length > 20) falhas.push(`${titulo} | rótulo "${lista.rotulo}" passa de 20`)
    else passou++
    if (lista.linhas.length > 10) falhas.push(`${titulo} | lista com mais de 10 linhas`)
    else passou++
    for (const l of lista.linhas) {
      if (l.titulo.length > 24) falhas.push(`${titulo} | linha "${l.titulo}" passa de 24`)
      else passou++
      if ((l.descricao ?? '').length > 72) falhas.push(`${titulo} | descrição longa em "${l.titulo}"`)
      else passou++
    }
  }
}

await caso(
  'Menu vem como lista tocável com as cinco opções',
  [['Oi', 'Como podemos ajudar']],
  {
    verificar: ({ ultimoToque, titulo }) => {
      const linhas = ultimoToque.lista?.linhas ?? []
      if (linhas.length !== 5) falhas.push(`${titulo} | esperava 5 linhas, veio ${linhas.length}`)
      else passou++
      // Os ids precisam ser exatamente o que o robô aceita digitado.
      if (linhas.map((l) => l.id).join(',') !== '1,2,3,4,5') {
        falhas.push(`${titulo} | ids fora do padrão: ${linhas.map((l) => l.id).join(',')}`)
      } else passou++
      conferirLimites(ultimoToque, titulo)
    },
  },
)

await caso(
  'Tocar na lista funciona igual a digitar o número',
  [
    ['Oi', 'Como podemos ajudar'],
    // O webhook manda o id do toque no lugar do texto - aqui é o mesmo "2".
    ['2', 'Em qual unidade'],
  ],
  {
    verificar: ({ ultimoToque, titulo }) => {
      if (!ultimoToque.lista) falhas.push(`${titulo} | unidade deveria vir como lista`)
      else passou++
      conferirLimites(ultimoToque, titulo)
    },
  },
)

await caso(
  'Minha consulta oferece três botões',
  [
    ['Oi', 'Como podemos ajudar'],
    ['4', 'Sua consulta'],
  ],
  {
    consultas: [CONSULTA_ANA],
    verificar: ({ ultimoToque, titulo }) => {
      const ids = (ultimoToque.botoes ?? []).map((b) => b.id).join(',')
      if (ids !== 'REMARCAR,CANCELAR,MENU') falhas.push(`${titulo} | botões inesperados: ${ids}`)
      else passou++
      conferirLimites(ultimoToque, titulo)
    },
  },
)

await caso(
  'Confirmação de cancelamento vira sim/não tocável',
  [
    ['Oi', 'Como podemos ajudar'],
    ['4', 'Sua consulta'],
    ['CANCELAR', 'Responda SIM'],
  ],
  {
    consultas: [CONSULTA_ANA],
    verificar: ({ ultimoToque, titulo }) => {
      const ids = (ultimoToque.botoes ?? []).map((b) => b.id).join(',')
      if (ids !== 'SIM,MENU') falhas.push(`${titulo} | botões inesperados: ${ids}`)
      else passou++
      conferirLimites(ultimoToque, titulo)
    },
  },
)

await caso(
  'Dia vem como lista, e horário também quando cabe',
  [
    ['agendar', 'Em qual unidade'],
    ['1', 'Datas disponíveis'],
    ['1', 'Horários de'],
  ],
  {
    verificar: ({ ultimoToque, titulo }) => {
      const linhas = ultimoToque.lista?.linhas ?? []
      // 6 horarios + a linha de volta que toda lista carrega no fim
      // Seis horarios mais as duas saidas: falar com a equipe e voltar ao menu.
      if (linhas.length !== 8) falhas.push(`${titulo} | esperava 6 horários + 2 saídas, veio ${linhas.length}`)
      else passou++
      conferirLimites(ultimoToque, titulo)
    },
  },
)

// ---------------------------------------------------------------
// 5. Coisas que quero OBSERVAR, nao afirmar
// ---------------------------------------------------------------

const r1 = await caso('Paciente quer cancelar consulta fora do lembrete', [['cancelar minha consulta', []]])
achados.push(
  'Cancelar/remarcar fora da janela do lembrete:\n' +
    r1.transcricao.join('\n'),
)

const r2 = await caso('Paciente pergunta quando é a consulta dele', [['quando é minha consulta?', []]])
achados.push('Consultar a propria consulta:\n' + r2.transcricao.join('\n'))

const r3 = await caso('Responde com o horário em vez do número da linha', [
  ['agendar', []],
  ['1', []],
  ['1', []],
  ['08:40', []],
])
achados.push('Responder "08:40" em vez de "2":\n' + r3.transcricao.slice(-1).join('\n'))

// ---------------------------------------------------------------------------
// O 9 como saida universal
//
// Ele so pode significar "falar com a equipe" porque nenhuma lista chega a nove
// opcoes. Se um dia alguem aumentar MAX_DIAS ou MAX_HORARIOS_DIA, e aqui que
// isso vai doer, e nao numa conversa real em que o paciente pediu o nono
// horario e caiu na fila da secretaria.
// ---------------------------------------------------------------------------

await caso('O 9 chama a equipe a partir do menu', [
  ['Oi', 'Como podemos ajudar'],
  ['9', 'atendente da clínica'],
])

await caso('O 9 chama a equipe no meio do agendamento', [
  ['agendar', 'Em qual unidade'],
  ['9', 'atendente da clínica'],
])

await caso('Unidade de nome longo continua com botão e sem estourar o limite', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
])

// ---------------------------------------------------------------------------
// Respostas prontas
//
// O robo responde a pergunta escrita quando a clinica cadastrou aquele assunto.
// Tres coisas precisam continuar valendo: acertar o assunto, calar a boca em
// assunto clinico, e nao inventar quando nada bate.
// ---------------------------------------------------------------------------

const TELE = { ativa: true, texto: '*Telemedicina: R$ 450,00.* Retorno presencial em 30 dias.' }

const RESPOSTAS = [
  {
    id: 'r1',
    subject: 'Valor e pagamento',
    keywords: ['valor', 'quanto', 'custa', 'preco', 'pix', 'cartao', 'pagamento'],
    answer: 'A consulta particular custa R$ 450,00. Aceitamos pix e cartão.',
  },
  {
    id: 'r2',
    subject: 'Convênios',
    keywords: ['convenio', 'plano', 'reembolso', 'carteirinha'],
    answer: 'O atendimento é particular. Emitimos recibo para reembolso.',
  },
]

await caso('Pergunta de valor recebe a resposta pronta', [
  ['Quanto custa a consulta?', 'custa R$ 450,00'],
], { respostasProntas: RESPOSTAS })

await caso('Acento e plural não atrapalham', [
  ['Vocês atendem convênios?', 'particular. Emitimos recibo'],
], { respostasProntas: RESPOSTAS })

await caso('Depois da resposta pronta o 2 ainda marca consulta', [
  ['Qual o valor?', 'custa R$ 450,00'],
  ['2', 'Em qual unidade'],
], { respostasProntas: RESPOSTAS })

await caso('Pergunta clínica não é respondida, mas recebe o caminho certo', [
  ['Meu filho está com dor de barriga, posso dar dipirona?', ['quem responde é o Dr. Rafael', 'Digite *3*']],
], { respostasProntas: RESPOSTAS })

await caso('Palavra de valor junto de sintoma não recebe o preço', [
  ['Ele está com febre, quanto custa a consulta?', 'quem responde é o Dr. Rafael'],
], { respostasProntas: RESPOSTAS })

await caso('Assunto que ninguém cadastrou cai no menu, sem inventar', [
  ['Vocês têm convênio com o meu banco de leite?', 'particular. Emitimos recibo'],
], { respostasProntas: RESPOSTAS })

await caso('Sintoma junto de "quero marcar" continua podendo marcar pelo menu', [
  ['oi, meu filho tem refluxo, queria marcar uma consulta', 'quem responde é o Dr. Rafael'],
  ['2', 'Em qual unidade'],
], { respostasProntas: RESPOSTAS })

await caso('Sem nada cadastrado, tudo segue como antes', [
  ['Quanto custa a consulta?', 'Como podemos ajudar'],
])

await caso('Pergunta escrita depois do menu também é respondida', [
  ['Oi', 'Como podemos ajudar'],
  ['e o valor?', 'custa R$ 450,00'],
], { respostasProntas: RESPOSTAS })

// ---------------------------------------------------------------
// Resposta pronta enquanto a equipe nao chega
// ---------------------------------------------------------------

// A fila pode durar a noite inteira, e nela a pessoa escreve as duvidas de
// sempre. Tres respostas prontas ela recebe; da quarta em diante o robo cala.
// Se tres textos prontos nao resolveram, o quarto tambem nao resolve.
await caso('Esperando a equipe: três respostas prontas, depois silêncio', [
  ['Oi', 'Como podemos ajudar'],
  ['3', 'direcionando você'],
  ['Vocês atendem convênio?', ['particular', 'continua na fila']],
  ['Qual o valor?', ['R$ 450,00', 'continua na fila']],
  ['Aceitam cartão?', 'continua na fila'],
  ['E o reembolso do plano?', null],
], { respostasProntas: RESPOSTAS })

// A resposta pronta nao tira a pessoa da fila: a etapa continua 'atendente' e a
// equipe continua devendo resposta. Por isso o "bom dia" seguinte cai no
// silencio, e nao no menu.
await caso('Resposta pronta na fila não solta a conversa da equipe', [
  ['Oi', 'Como podemos ajudar'],
  ['3', 'direcionando você'],
  ['Vocês atendem convênio?', 'continua na fila'],
  ['bom dia', null],
], { respostasProntas: RESPOSTAS })

// Com alguem da equipe escrevendo agora, nem palavra-chave aparece: seria o
// robo falando por cima da atendente.
await caso('Equipe conversando: o robô não responde nem palavra-chave', [
  ['Vocês atendem convênio?', null],
], { respostasProntas: RESPOSTAS, podeIniciarMenu: false })

// O mesmo vale no menu, e ali a trava nao existia. Caso real de 15/09/2026: a
// equipe explicou a mao que a Trasmontano e atendida, e meia hora depois o robo
// repetiu a resposta pronta de convenio por cima dela.
await caso('Equipe conversando: nem resposta pronta nem "não entendi" no menu', [
  ['Unimed não?', null],
], { respostasProntas: RESPOSTAS, podeIniciarMenu: false })

// Numero de menu a pessoa escolheu de propósito, entao continua valendo mesmo
// com a equipe na conversa.
await caso('Mas o número do menu continua valendo', [
  ['Oi', 'Como podemos ajudar'],
  // A equipe entra na conversa a partir daqui.
  ['2', 'Em qual unidade', { podeIniciarMenu: false }],
])

// Pergunta curta na fila continua respondida: uma palavra basta quando a pessoa
// nao esta pedindo para marcar.
await caso('"Convênio?" na fila é respondido mesmo casando com uma palavra só', [
  ['Oi', 'Como podemos ajudar'],
  ['3', 'direcionando você'],
  ['convênio?', ['particular', 'continua na fila']],
], { respostasProntas: RESPOSTAS })

// E o pedido de marcar continua em silêncio, porque "retorno" sozinho não é
// pergunta.
await caso('"Quero marcar retorno para o Anthony" na fila continua em silêncio', [
  ['Oi', 'Como podemos ajudar'],
  ['3', 'direcionando você'],
  ['quero marcar retorno para o Anthony', null],
], { respostasProntas: [...RESPOSTAS, {
  id: 'r4',
  subject: 'O que levar',
  keywords: ['levar', 'documento', 'retorno', 'exames'],
  answer: 'Leve um documento com foto do responsável.',
}] })

// ---------------------------------------------------------------
// "Quero marcar" escrito como as pessoas escrevem
// ---------------------------------------------------------------
//
// Ate 15/09/2026 so valia a frase exata. "Quero marcar retorno para o Anthony"
// caia na resposta pronta de documentos, porque "retorno" e palavra-chave dela.

for (const frase of [
  'quero marcar retorno para o Anthony Silveira',
  'queria marcar uma consulta',
  'gostaria de agendar para o meu filho',
  'tem horarios essa semana?',
  'MARCAR',
]) {
  await caso(`"${frase}" abre o agendamento`, [[frase, 'Em qual unidade']])
}

// Mas a PRIMEIRA mensagem, não. O botão do site manda "Vim pelo site e gostaria
// de agendar uma consulta" já escrito, e a conversa começava em "Em qual
// unidade?", sem apresentação e sem as outras opções. Quem chega tem que ver o
// menu antes de ser levado para dentro de um fluxo.
await caso('Primeira mensagem sempre vê o menu, mesmo pedindo para agendar', [
  ['Olá! Vim pelo site do Dr. Rafael e gostaria de agendar uma consulta.', 'Como podemos ajudar'],
], { primeiraMensagem: true })

// E o menu vence a resposta pronta: "retorno" é palavra-chave do texto de
// documentos, e quem pediu para marcar não perguntou o que levar.
await caso('Pedido de agendamento na primeira mensagem não vira resposta pronta', [
  ['quero marcar retorno para o Anthony', 'Como podemos ajudar'],
], { primeiraMensagem: true, respostasProntas: RESPOSTAS })

// E da segunda em diante o atalho volta a valer: ela já sabe o que existe ali.
await caso('Depois do menu, o atalho volta a valer', [
  ['Olá! Vim pelo site do Dr. Rafael e gostaria de agendar uma consulta.', 'Como podemos ajudar'],
  ['quero agendar', 'Em qual unidade'],
], { primeiraMensagem: true })

// Remarcar e desmarcar contem "marcar" e sao o oposto: quem pede isso ja tem
// consulta. Vao para o menu, onde o *4* cuida do assunto.
for (const frase of ['quero remarcar', 'preciso desmarcar minha consulta']) {
  await caso(`"${frase}" não abre consulta nova`, [[frase, 'Como podemos ajudar']])
}

// Preco continua sendo preco: "consulta" sozinha nao abre a agenda.
await caso('"Quanto custa a consulta?" continua respondendo o valor', [
  ['Quanto custa a consulta?', 'custa R$ 450,00'],
], { respostasProntas: RESPOSTAS })

// ---------------------------------------------------------------
// Anexo: foto, exame, áudio
// ---------------------------------------------------------------

// O robo nao le arquivo nenhum. Responder o menu a uma foto de exame e dizer
// "nao vi o que voce mandou, escolha uma opcao".
await caso('Foto vai para a equipe, não recebe menu', [
  ['[ANEXO]', ['Recebi o que você enviou', 'equipe']],
])

// Segunda foto na mesma espera nao merece outro "vou entregar": a equipe ja
// esta com a conversa.
await caso('Segunda foto na fila não repete o aviso', [
  ['[ANEXO]', 'Recebi o que você enviou'],
  ['[ANEXO]', null],
])

// Anexo no meio de um agendamento tambem entrega: alguma coisa fora do comum
// esta acontecendo, e a pessoa quer que alguem olhe.
await caso('Foto no meio do agendamento também entrega para a equipe', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
  ['[ANEXO]', 'Recebi o que você enviou'],
])

// MENU continua furando tudo, inclusive a entrega do anexo.
await caso('Depois do anexo, MENU ainda volta ao início', [
  ['[ANEXO]', 'Recebi o que você enviou'],
  ['0', 'Como podemos ajudar'],
])

// ---------------------------------------------------------------
// Pergunta no meio de uma escolha
// ---------------------------------------------------------------

// Quem escreve "convenio" quando o robo espera um numero nao errou: mudou de
// assunto. A resposta vem primeiro e a pergunta da etapa e repetida abaixo.
await caso('Pergunta no meio da escolha da unidade é respondida', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
  ['Vocês atendem convênio?', ['particular', 'número da unidade']],
  ['1', 'Datas disponíveis'],
], { respostasProntas: RESPOSTAS })

await caso('E também no meio da escolha do dia e do horário', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
  ['1', 'Datas disponíveis'],
  ['Qual o valor?', ['R$ 450,00', 'número do dia']],
  ['1', 'Horários de'],
  ['Aceitam cartão?', ['R$ 450,00', 'número do horário']],
  ['1', 'nome completo do paciente'],
], { respostasProntas: RESPOSTAS })

// Sintoma continua sem resposta automática, mesmo no meio de uma escolha: é
// consulta médica. E desde 20/09/2026 o robô diz POR QUE não responde, em vez
// de "não entendi" - a mãe que escreve um sintoma não errou a forma de
// responder, e mandá-la reler o menu não avisa ninguém.
await caso('Sintoma no meio da escolha não vira resposta automática', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
  ['ele está com febre, quanto custa?', ['não posso orientar', 'número da unidade']],
], { respostasProntas: RESPOSTAS })

// Urgencia nunca entra na conta: ela responde sempre, mesmo depois do limite.
await caso('Urgência responde mesmo com o limite estourado', [
  ['Oi', 'Como podemos ajudar'],
  ['3', 'direcionando você'],
  ['Vocês atendem convênio?', 'continua na fila'],
  ['Qual o valor?', 'continua na fila'],
  ['Aceitam cartão?', 'continua na fila'],
  ['E o reembolso do plano?', null],
  ['é urgente, ele está passando mal', 'urgente'],
], { respostasProntas: RESPOSTAS })

// O assunto marcado para perguntar a unidade nao responde o texto dele: faz a
// mesma pergunta da opcao 1 e entrega o texto do lugar escolhido.
const RESPOSTAS_POR_UNIDADE = [
  { ...RESPOSTAS[0], ask_unit: true },
  RESPOSTAS[1],
]

await caso('"Quanto custa" pergunta onde antes de responder', [
  ['Quanto custa a consulta?', ['Para qual atendimento', 'Liferty · Santos', 'Telemedicina']],
  ['4', 'Retorno presencial em 30 dias'],
], { respostasProntas: RESPOSTAS_POR_UNIDADE, telemedicina: TELE })

await caso('"Quanto custa" com um lugar só responde o texto do assunto', [
  ['Quanto custa a consulta?', 'custa R$ 450,00'],
], { respostasProntas: RESPOSTAS_POR_UNIDADE, unidades: UMA_UNIDADE })

// ---------------------------------------------------------------------------
// Telemedicina
//
// Nao tem agenda propria: usa os horarios das unidades fisicas. A consulta e
// gravada na unidade que cedeu o horario, com modalidade 'telemedicina'. E a
// unica etapa com saida de urgencia.
// ---------------------------------------------------------------------------

const SLOTS_DUAS = {
  'u-santos': [
    { slot_start: '2026-08-31T11:00:00Z', slot_end: '2026-08-31T11:40:00Z' },
    { slot_start: '2026-08-31T11:40:00Z', slot_end: '2026-08-31T12:20:00Z' },
  ],
  'u-andre': [],
  'u-vila': [
    { slot_start: '2026-09-02T13:00:00Z', slot_end: '2026-09-02T13:40:00Z' },
  ],
}

await caso('Telemedicina aparece na lista de unidades quando ligada', [
  ['agendar', ['Em qual unidade', 'Telemedicina (por vídeo)']],
], { telemedicina: TELE })

await caso('Telemedicina desligada não aparece', [
  ['agendar', 'Em qual unidade'],
], {
  verificar: ({ transcricao, titulo }) => {
    if (transcricao.join('').includes('Telemedicina')) falhas.push(`${titulo} | listou telemedicina desligada`)
    else passou++
  },
})

await caso('Telemedicina junta os dias das duas unidades', [
  ['agendar', 'Em qual unidade'],
  ['4', ['Datas disponíveis para telemedicina', '31/08', '02/09', 'urgência']],
], { telemedicina: TELE, slots: SLOTS_DUAS })

await caso('Telemedicina marca na unidade que cedeu o horário, como telemedicina', [
  ['agendar', 'Em qual unidade'],
  ['4', 'Datas disponíveis para telemedicina'],
  ['2', 'Horários de'],
  ['1', ['Consulta marcada', 'por vídeo', 'link da consulta']],
], {
  telemedicina: TELE,
  slots: SLOTS_DUAS,
  pacientes: [ANA],
  verificar: ({ marcadas, titulo }) => {
    const m = marcadas[0]
    if (!m) return falhas.push(`${titulo} | nada foi marcado`)
    if (m.unit_id !== 'u-vila') falhas.push(`${titulo} | unidade errada: ${m.unit_id}`)
    else passou++
    if (m.modality !== 'telemedicina') falhas.push(`${titulo} | modalidade errada: ${m.modality}`)
    else passou++
  },
})

await caso('Urgência na telemedicina transfere para a equipe', [
  ['agendar', 'Em qual unidade'],
  ['4', 'Datas disponíveis para telemedicina'],
  ['é urgente', ['transferindo você para um atendente', 'urgência']],
  ['meu filho não para de vomitar', null],
], {
  telemedicina: TELE,
  slots: SLOTS_DUAS,
  verificar: ({ conversa, titulo }) => {
    if (conversa.booking_state !== 'atendente') falhas.push(`${titulo} | estado ${conversa.booking_state}`)
    else passou++
  },
})

// Nasceu na telemedicina, mas vale em qualquer etapa: quem escreve "urgente"
// escolhendo o dia em Santos tambem e transferido, com a bandeira.
await caso('Urgência vale em qualquer etapa', [
  ['agendar', 'Em qual unidade'],
  ['1', 'Datas disponíveis em Liferty'],
  ['urgente', 'transferindo você para um atendente'],
], { telemedicina: TELE, slots: SLOTS_DUAS })

await caso('Urgência como primeira mensagem também transfere', [
  ['é urgente, meu filho está passando mal', 'transferindo você para um atendente'],
])

await caso('Informações da telemedicina vêm do texto próprio', [
  ['Oi', 'Como podemos ajudar'],
  ['1', ['Para qual atendimento', 'Telemedicina']],
  ['4', ['Retorno presencial em 30 dias', 'urgência']],
  ['urgente', 'transferindo você para um atendente'],
], { telemedicina: TELE })

// ---------------------------------------------------------------


// ---------------------------------------------------------------
// Questionário disparado pela equipe (botão "Questionário")
// ---------------------------------------------------------------
//
// O caminho normal é o robô perguntar logo depois de marcar. Este é o outro:
// alguém da recepção aperta o botão na tela de Respostas e o robô refaz as
// perguntas na conversa que já existe.

// Pedro tem ficha e nenhuma consulta marcada - o caso que o botão não atendia
// até 16/09/2026, porque exigia consulta FUTURA. As respostas vão para a
// ficha, que é o único destino que existe aqui.
{
  const titulo = 'Questionário sem consulta grava na ficha'
  const { admin, conversa, fichas } = fazerAdmin({
    unidades: TRES_UNIDADES,
    slotsPorUnidade: SLOTS_CHEIOS,
  })
  conversa.menu_sent_at = '2026-08-31T12:00:00Z'

  const inicio = await iniciarQuestionario(admin, 'conv1', null, PEDRO)
  if (!inicio?.resultado?.resposta?.includes('nascimento')) {
    falhas.push(`${titulo} | a primeira pergunta deveria ser o nascimento, veio: ${inicio?.resultado?.resposta?.slice(0, 80)}`)
  } else passou++

  // Sem "Voltar ao menu": a pessoa não estava em fluxo nenhum, e um pedido de
  // quatro dados não deve virar porta de entrada para o menu inteiro.
  if ((inicio?.resultado?.botoes ?? []).some((b) => b.id === 'MENU')) {
    falhas.push(`${titulo} | o questionário manual não deve oferecer "Voltar ao menu"`)
  } else passou++

  // Sem consulta, quem diz de quem são as respostas é o vínculo na conversa.
  if (conversa.booking_patient_id !== PEDRO.id) {
    falhas.push(`${titulo} | deveria amarrar a conversa ao paciente, veio ${conversa.booking_patient_id}`)
  } else passou++

  const responder = async (texto) => {
    const r = await tratarConversa({
      admin,
      clinicId: 'c1',
      conversationId: 'conv1',
      estadoAtual: conversa.booking_state,
      opcoesAtuais: conversa.booking_options,
      unidadeEmAndamento: conversa.booking_unit_id,
      modalidadeEmAndamento: null,
      pacienteEmAndamento: conversa.booking_patient_id ?? null,
      consultas: [],
      consultaASubstituir: null,
      consultaEmCadastro: conversa.booking_intake_id ?? null,
      respostasNaEspera: 0,
      jaViuOMenu: true,
      podeIniciarMenu: true,
      texto,
      telefone: '5511999999999',
      pacientes: [PEDRO],
      nomeDoPerfil: 'Paula Medina',
      textos: TEXTOS,
    })
    return r?.resposta ?? ''
  }

  await responder('12/05/2019')
  await responder('Marina Souza')
  await responder('390.533.447-05')
  const fecho = await responder('marina@exemplo.com')

  const gravado = Object.assign({}, ...fichas.map((f) => ({ ...f })))
  for (const [campo, valor] of [
    ['birth_date', '2019-05-12'],
    ['guardian_name', 'Marina Souza'],
    ['cpf', '39053344705'],
  ]) {
    if (gravado[campo] !== valor) {
      falhas.push(`${titulo} | ${campo} deveria ser "${valor}", veio "${gravado[campo]}"`)
    } else passou++
  }
  // Todas as gravações são na ficha do Pedro, e não na de outra pessoa.
  if (fichas.some((f) => f.id !== PEDRO.id)) {
    falhas.push(`${titulo} | gravou em ficha alheia: ${fichas.map((f) => f.id).join(', ')}`)
  } else passou++

  // Sem consulta, o robô não pode dizer "anotamos na sua consulta": quem lê
  // sairia procurando por uma consulta que não existe.
  if (fecho.includes('na sua consulta')) {
    falhas.push(`${titulo} | o fecho fala de consulta que não existe: ${fecho.slice(0, 120)}`)
  } else passou++
  if (!fecho.includes('no seu cadastro')) {
    falhas.push(`${titulo} | o fecho deveria falar do cadastro, veio: ${fecho.slice(0, 120)}`)
  } else passou++
}

// Com consulta em mãos o questionário manual grava nela - mas não anuncia
// "Consulta marcada!" no fim. Em 16/09/2026 anunciou: pegou a consulta do dia
// 14, dois dias ANTES, e a família leu um comprovante de algo que ninguém
// tinha acabado de marcar.
{
  const titulo = 'Questionário manual não anuncia consulta'
  const { admin, conversa, fichas } = fazerAdmin({
    unidades: TRES_UNIDADES,
    slotsPorUnidade: SLOTS_CHEIOS,
  })
  conversa.menu_sent_at = '2026-08-31T12:00:00Z'

  await iniciarQuestionario(admin, 'conv1', 'consulta-antiga', PEDRO)

  const responder = async (texto) => {
    const r = await tratarConversa({
      admin,
      clinicId: 'c1',
      conversationId: 'conv1',
      estadoAtual: conversa.booking_state,
      opcoesAtuais: conversa.booking_options,
      unidadeEmAndamento: conversa.booking_unit_id,
      modalidadeEmAndamento: null,
      pacienteEmAndamento: conversa.booking_patient_id ?? null,
      consultas: [],
      consultaASubstituir: null,
      consultaEmCadastro: conversa.booking_intake_id ?? null,
      respostasNaEspera: 0,
      jaViuOMenu: true,
      podeIniciarMenu: true,
      texto,
      telefone: '5511999999999',
      pacientes: [PEDRO],
      nomeDoPerfil: 'Paula Medina',
      textos: TEXTOS,
    })
    return r?.resposta ?? ''
  }

  await responder('12/05/2019')
  await responder('Marina Souza')
  await responder('PULAR')
  const fecho = await responder('PULAR')

  if (fecho.includes('Consulta marcada')) {
    falhas.push(`${titulo} | anunciou comprovante: ${fecho.slice(0, 140)}`)
  } else passou++
  if (!fecho.includes('Tudo certo')) {
    falhas.push(`${titulo} | deveria agradecer e encerrar, veio: ${fecho.slice(0, 140)}`)
  } else passou++
  // O que a família respondeu tem de ter chegado à ficha mesmo assim.
  if (!fichas.some((f) => f.birth_date === '2019-05-12')) {
    falhas.push(`${titulo} | o nascimento não chegou à ficha`)
  } else passou++
}

// Cadastro completo não vira mensagem: a Ana tem tudo, e perguntar de novo a
// quem a clínica atende há anos é o robô dizendo que não a conhece.
{
  const titulo = 'Questionário não pergunta a quem já tem tudo'
  const { admin } = fazerAdmin({ unidades: TRES_UNIDADES, slotsPorUnidade: SLOTS_CHEIOS })
  const inicio = await iniciarQuestionario(admin, 'conv1', null, ANA)
  if (inicio !== null) {
    falhas.push(`${titulo} | deveria devolver null, veio ${JSON.stringify(inicio)?.slice(0, 100)}`)
  } else passou++
}


// ---------------------------------------------------------------
// Idade atendida não pode cair no texto de convênio
// ---------------------------------------------------------------
//
// Em 18/09/2026 a Crislaine perguntou três vezes se o consultório atende bebê
// de três meses, e nas três recebeu a resposta de convênio, porque 'atende'
// estava na lista de palavras de plano de saúde. Ela só foi respondida por
// gente às 00:03, seis horas depois. Este bloco é aquela conversa.

const RESPOSTAS_IDADE = [
  {
    id: 'r-conv',
    subject: 'Convênios',
    keywords: [
      'convenio', 'plano', 'saude', 'aceita', 'aceitam', 'carteirinha',
      'reembolso', 'particular', 'unimed', 'trasmontano', 'bradesco',
    ],
    answer: 'Atendemos Trasmontano na unidade de Santos. Outros convênios não são atendidos.',
  },
  {
    id: 'r-idade',
    subject: 'Idade atendida',
    keywords: [
      'bebe', 'bebê', 'bebes', 'bebês', 'recem', 'recém', 'nascido',
      'idade', 'meses', 'crianca', 'criança', 'adolescente', 'anos',
    ],
    answer: 'O Dr. Rafael atende desde recém-nascidos até 19 anos.',
  },
]

await caso('Pergunta de bebê recebe a idade, e não convênio', [
  ['Vocês atendem bebês?', 'recém-nascidos até 19 anos'],
], { respostasProntas: RESPOSTAS_IDADE })

await caso('"A partir de qual idade" recebe a idade', [
  ['A partir de qual idade vocês atendem?', 'recém-nascidos até 19 anos'],
], { respostasProntas: RESPOSTAS_IDADE })

await caso('Bebê de três meses: a pergunta inteira da Crislaine', [
  ['Qual valor da consulta? E vocês atendem bebês com 3 meses de vida?', 'recém-nascidos até 19 anos'],
], { respostasProntas: RESPOSTAS_IDADE })

// O outro lado da correção: tirar 'atende' da lista de convênio não pode fazer
// o robô deixar de reconhecer quem pergunta de plano.
await caso('Pergunta de convênio continua reconhecida', [
  ['Vocês aceitam convênio?', 'Trasmontano'],
], { respostasProntas: RESPOSTAS_IDADE })

await caso('Marca do plano sozinha é reconhecida', [
  ['atendem trasmontano?', 'Trasmontano'],
], { respostasProntas: RESPOSTAS_IDADE })

await caso('Plano que não é atendido também cai no texto certo', [
  ['vocês aceitam unimed?', 'Outros convênios não são atendidos'],
], { respostasProntas: RESPOSTAS_IDADE })


// ---------------------------------------------------------------
// Convênio no agendamento
// ---------------------------------------------------------------
//
// Cenário fictício herdado para testar um convênio por unidade. A
// recepção precisa saber antes da pessoa chegar se fatura pelo plano ou cobra
// particular - antes disso ela descobria na hora, com a família na frente.
//
// A pergunta é da UNIDADE: quem não aceita convênio não pergunta nada, e o
// fluxo continua com o mesmo número de passos de sempre.

const UNIDADE_COM_CONVENIO = [
  { id: 'u-santos', name: 'Liferty · Santos', address: 'Av. Ana Costa, 100', accepts_insurance: 'Trasmontano' },
]

await caso('Unidade com convênio pergunta antes das datas', [
  ['Oi', 'Como podemos ajudar'],
  ['2', ['pelo convênio', 'Trasmontano', 'Particular']],
], { unidades: UNIDADE_COM_CONVENIO, slots: { 'u-santos': SLOTS_CHEIOS['u-santos'] } })

await caso('Escolhendo o convênio, ele é gravado na consulta', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'pelo convênio'],
  ['1', 'Datas disponíveis'],
  ['1', 'Horários de'],
  ['1', 'está guardado'],
], {
  unidades: UNIDADE_COM_CONVENIO,
  slots: { 'u-santos': SLOTS_CHEIOS['u-santos'] },
  verificar: ({ marcadas, titulo }) => {
    const m = marcadas[0]
    if (!m) return falhas.push(`${titulo} | nenhuma consulta gravada`)
    if (m.insurance !== 'Trasmontano') {
      falhas.push(`${titulo} | deveria gravar Trasmontano, veio "${m.insurance}"`)
    } else passou++
  },
})

await caso('Escolhendo particular, a consulta fica sem convênio', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'pelo convênio'],
  ['2', 'Datas disponíveis'],
  ['1', 'Horários de'],
  ['1', 'está guardado'],
], {
  unidades: UNIDADE_COM_CONVENIO,
  slots: { 'u-santos': SLOTS_CHEIOS['u-santos'] },
  verificar: ({ marcadas, titulo }) => {
    const m = marcadas[0]
    if (!m) return falhas.push(`${titulo} | nenhuma consulta gravada`)
    if (m.insurance !== '') {
      falhas.push(`${titulo} | particular deveria ficar vazio, veio "${m.insurance}"`)
    } else passou++
  },
})

await caso('Responder o nome do plano por escrito também vale', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'pelo convênio'],
  ['trasmontano', 'Datas disponíveis'],
], { unidades: UNIDADE_COM_CONVENIO, slots: { 'u-santos': SLOTS_CHEIOS['u-santos'] } })

// A unidade sem convênio não ganha passo nenhum: vai direto para as datas.
await caso('Unidade sem convênio vai direto para as datas', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Datas disponíveis'],
], { unidades: UMA_UNIDADE })


// ---------------------------------------------------------------
// Coluna nova que o banco ainda não tem
// ---------------------------------------------------------------
//
// Em 19/09/2026 o robô foi ao ar gravando booking_insurance antes de a coluna
// existir. O Postgres não ignora coluna desconhecida: recusa o UPDATE inteiro.
// O estado da conversa parou de ser gravado e o robô nunca saía do menu - o
// paciente digitava 1, recebia o menu, digitava 1 de novo, recebia o menu.
// Três voltas, sem erro visível em lugar nenhum.
//
// Perder o campo novo é um arranhão. Perder o estado trava o atendimento.

await caso('Sem a coluna nova, o menu continua funcionando', [
  ['Oi', 'Como podemos ajudar'],
  ['1', 'Para qual atendimento'],
], { colunasAusentes: ['booking_insurance'] })

await caso('Sem a coluna nova, dá para marcar consulta até o fim', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
  ['1', 'Datas disponíveis'],
  ['1', 'Horários de'],
  ['1', 'está guardado'],
], { colunasAusentes: ['booking_insurance'] })

// E com a unidade que pede convênio: a pergunta acontece, a resposta não pode
// ser gravada, e mesmo assim o agendamento chega ao fim.
await caso('Sem a coluna nova, o convênio some mas o agendamento segue', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'pelo convênio'],
  ['1', 'Datas disponíveis'],
  ['1', 'Horários de'],
  ['1', 'está guardado'],
], {
  unidades: UNIDADE_COM_CONVENIO,
  slots: { 'u-santos': SLOTS_CHEIOS['u-santos'] },
  colunasAusentes: ['booking_insurance'],
})


// A unidade sem a coluna nova: o atendimento não pode parar por causa disso.
//
// Foi assim que o robô caiu em 19/09/2026. A consulta pedia accepts_insurance
// antes de a migration rodar, o Postgres recusou tudo, a lista de unidades
// voltou vazia, e a opção 1 não tinha o que mostrar: devolvia o menu. O
// paciente digitava 1, recebia o menu, digitava 1 de novo, recebia o menu.

await caso('Coluna de convênio ausente não derruba a opção 1', [
  ['Oi', 'Como podemos ajudar'],
  ['1', 'Para qual atendimento'],
], { colunasAusentes: ['accepts_insurance'] })

await caso('Coluna de convênio ausente não derruba o agendamento', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
  ['1', 'Datas disponíveis'],
  ['1', 'Horários de'],
  ['1', 'está guardado'],
], { colunasAusentes: ['accepts_insurance'] })

// ---------------------------------------------------------------
// 2ª via de receita e pedido de exame (opção 5)
// ---------------------------------------------------------------

await caso('Primeiro contato mostra também a opção 5', [
  ['Oi', ['*5* 📄 2ª via de receita ou pedido de exame']],
])

await caso('Paciente único pula a escolha e vai direto ao tipo', [
  ['Oi', 'Como podemos ajudar'],
  ['5', ['O que você precisa para *Ana Paula Souza*', '2ª via de receita', 'Pedido de exame']],
], { pacientes: [ANA] })

const pedidoDeReceita = await caso('2ª via de receita, com correção pedida pela farmácia', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['1', 'Qual medicamento'],
  ['Domperidona', 'A farmácia pediu alguma correção'],
  ['A validade venceu', [
    'Pedido registrado',
    '💊 2ª via de receita · Ana Paula Souza',
    'Domperidona',
    'A validade venceu',
    'informará o prazo de resposta',
  ]],
], {
  pacientes: [ANA],
  verificar: ({ conversa, titulo }) => {
    // Sem a bandeira o pedido não aparece na lista da clínica: fica um recado
    // no meio da conversa, que é exatamente o problema que isto resolve.
    if (conversa.booking_state !== 'atendente') {
      falhas.push(`${titulo} | deveria terminar esperando a equipe, veio ${conversa.booking_state}`)
    } else passou++
  },
})

achados.push('2ª via de receita, do menu ao comprovante:\n' + pedidoDeReceita.transcricao.join('\n'))

// Quem devolveu o documento muda com o tipo. "A farmácia pediu correção no seu
// ultrassom?" faz a mãe parar para entender uma pergunta que não era para ela.
await caso('Pedido de exame diz "exame", e não "medicamento"', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['2', 'Qual exame'],
  ['Ultrassom de abdome', 'O laboratório ou a clínica de exames pediu alguma correção'],
  ['não', ['Pedido registrado', '🔬 Pedido de exame', 'Ultrassom de abdome']],
], { pacientes: [ANA] })

// "Não" é resposta completa, não recusa: nada foi exigido e o pedido segue.
// Escrever "Pediram correção: não" no comprovante faria a clínica procurar uma
// exigência que não existe.
await caso('Sem exigência, o comprovante não inventa uma', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['1', 'Qual medicamento'],
  ['Domperidona', 'pediu alguma correção'],
  ['não', 'Pedido registrado'],
], {
  pacientes: [ANA],
  verificar: ({ transcricao, titulo }) => {
    const comprovante = transcricao[transcricao.length - 1]
    if (comprovante.includes('Pediram correção')) {
      falhas.push(`${titulo} | comprovante inventou uma exigência que ninguém fez`)
    } else passou++
  },
})

await caso('Com dois filhos, pergunta de quem é o pedido', [
  ['Oi', 'Como podemos ajudar'],
  ['5', ['Para qual paciente', 'Ana Paula Souza', 'Pedro Souza']],
  ['2', 'O que você precisa para *Pedro Souza*'],
  ['1', 'Qual medicamento'],
  ['Omeprazol', 'pediu alguma correção'],
  ['não', ['Pedido registrado', '💊 2ª via de receita · Pedro Souza', 'Omeprazol']],
], { pacientes: [ANA, PEDRO] })

// A foto sozinha basta. Quem está no balcão da farmácia fotografa o que foi
// recusado em vez de repetir de cabeça o que o atendente disse - e essa é a
// informação mais confiável das duas.
await caso('Foto do documento recusado conta como resposta', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['1', 'Qual medicamento'],
  ['Domperidona', 'pediu alguma correção'],
  ['[ANEXO]', ['Pedido registrado', 'enviou foto do documento']],
], { pacientes: [ANA] })

// A trava do anexo entrega qualquer foto à equipe e encerra o fluxo. Aqui ela
// não pode valer, ou o pedido morre no penúltimo passo.
await caso('Foto no meio do pedido não cai na entrega genérica de anexo', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['1', 'Qual medicamento'],
  ['Domperidona', 'pediu alguma correção'],
  ['[ANEXO]', 'Pedido registrado'],
], {
  pacientes: [ANA],
  verificar: ({ transcricao, titulo }) => {
    const ultima = transcricao[transcricao.length - 1]
    if (ultima.includes('já avisei a nossa equipe')) {
      falhas.push(`${titulo} | a foto virou anexo genérico e o pedido se perdeu`)
    } else passou++
  },
})

// ---- Controlado ----

// A promessa de "1 dia útil" não pode existir aqui: a receita de controlado sai
// em receituário especial, a farmácia retém a via original, e mandar um PDF
// faria a família ir ao balcão para ouvir não.
await caso('Controlado não recebe promessa de 2ª via por aqui', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['1', 'Qual medicamento'],
  ['Rivotril', ['receituário especial', 'via original', 'avisei a equipe']],
], {
  pacientes: [ANA],
  verificar: ({ transcricao, titulo, conversa }) => {
    const ultima = transcricao[transcricao.length - 1]
    if (ultima.includes('1 dia útil')) {
      falhas.push(`${titulo} | prometeu prazo de 2ª via para receita que não sai por aqui`)
    } else passou++
    if (conversa.booking_state !== 'atendente') {
      falhas.push(`${titulo} | deveria ir para a equipe, veio ${conversa.booking_state}`)
    } else passou++
  },
})

await caso('Quem diz "é controlado" também sai do automático', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['1', 'Qual medicamento'],
  ['é o remédio controlado dele', 'receituário especial'],
], { pacientes: [ANA] })

// O caminho normal não pode ser arrastado junto: domperidona, omeprazol e
// afins continuam resolvendo sozinhos.
await caso('Remédio comum não é tratado como controlado', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['1', 'Qual medicamento'],
  ['Omeprazol', 'pediu alguma correção'],
], { pacientes: [ANA] })

// Exame não passa pela peneira de controlado: "azul" pode ser o nome de um
// laboratório, e "especial" aparece em nome de exame.
await caso('Pedido de exame não é barrado pela lista de controlados', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['2', 'Qual exame'],
  ['Exame no laboratório Azul', 'pediu alguma correção'],
], { pacientes: [ANA] })

// ---- O pedido não pode evaporar no meio ----

// Mandar a foto da receita quando o robô pede o nome do medicamento é a coisa
// mais natural do mundo - e era o que apagava o pedido: o anexo caía na regra
// geral, que zera booking_options, e a etapa seguinte respondia no vazio.
await caso('Foto antes do nome do medicamento não apaga o pedido', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['1', 'Qual medicamento'],
  ['[ANEXO]', 'nome'],
  ['Domperidona', 'pediu alguma correção'],
  ['não', ['Pedido registrado', 'Domperidona']],
], { pacientes: [ANA] })

// "é urgente, ela precisa do omeprazol" não é ida ao pronto-socorro: é uma mãe
// com pressa de receita. Mandá-la ao 192 e jogar fora o pedido é errado duas
// vezes.
await caso('Pressa pela receita não vira transferência de urgência', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['1', 'Qual medicamento'],
  ['é urgente, ela precisa do omeprazol', 'pediu alguma correção'],
], {
  pacientes: [ANA],
  verificar: ({ transcricao, titulo }) => {
    if (transcricao.join('\n').includes('192')) {
      falhas.push(`${titulo} | mandou ao pronto-socorro quem só queria a receita de volta`)
    } else passou++
  },
})

// Urgência de verdade continua valendo: sintoma junto do pedido tem que sair
// do fluxo e chamar gente.
await caso('Urgência com sintoma ainda transfere, mesmo dentro do pedido', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['1', 'Qual medicamento'],
  ['é urgente, ela está vomitando sangue', 'urgência'],
], { pacientes: [ANA] })

// "cancelar" no meio do pedido é a pessoa querendo sair - e aí o pedido some
// mesmo. O que não pode é sumir em silêncio, sem ela ter pedido.
await caso('Escrever "cancelar" no meio do pedido sai do fluxo, e avisa', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['1', 'Qual medicamento'],
  ['cancelar', 'parei por aqui'],
], { pacientes: [ANA] })

// ---- Quando a resposta não é um número ----

// As duas etapas reemitiam a MESMA mensagem, sem dizer que não entenderam. No
// celular isso lê como travamento: a pessoa responde o rótulo do botão que
// acabou de ler, e recebe a pergunta de novo, idêntica.
await caso('Responder o nome do botão em vez do número não trava', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['2ª via de receita', 'Qual medicamento'],
], { pacientes: [ANA] })

await caso('Responder o nome do filho em vez do número não trava', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'Para qual paciente'],
  ['Pedro', 'O que você precisa para *Pedro Souza*'],
], { pacientes: [ANA, PEDRO] })

await caso('Resposta que não casa com nada diz que não entendeu', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'O que você precisa'],
  ['azul', 'Não entendi'],
], { pacientes: [ANA] })

// ---- A portaria ----

await caso('Número sem atendimento não entra no fluxo do paciente', [
  ['Oi', 'Como podemos ajudar'],
  ['5', ['não localizei atendimento neste número', 'Sou o paciente ou responsável', 'Sou de farmácia ou laboratório']],
])

await caso('Quem diz ser o responsável vai para a equipe', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'não localizei atendimento'],
  ['1', 'direcionando você para um atendente'],
])

await caso('Farmácia registra o pedido sem receber dado de paciente', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'não localizei atendimento'],
  ['2', ['nome do paciente', 'precisa ser corrigido']],
  ['Gabriel Souza, o CID não confere', ['Registrado', 'enviado ao paciente, não por este canal']],
])

// O robô não pode confirmar que alguém se trata na clínica para um número que
// nunca consultou aqui. Isso é dado de saúde, e quem escreveu não provou ser
// ninguém: confirmar a pedido seria entregar prontuário a quem souber um nome.
await caso('Farmácia não recebe confirmação de que o paciente existe', [
  ['Oi', 'Como podemos ajudar'],
  ['5', 'não localizei atendimento'],
  ['2', 'nome do paciente'],
  ['A Ana Paula Souza se trata aí?', 'Registrado'],
], {
  verificar: ({ transcricao, titulo }) => {
    const conversaInteira = transcricao.join('\n')
    if (/Ana Paula Souza/.test(conversaInteira.split('> A Ana Paula')[1] ?? '')) {
      falhas.push(`${titulo} | o robô repetiu o nome do paciente para um número desconhecido`)
    } else passou++
  },
})

// ---------------------------------------------------------------
// Defeitos encontrados na varredura de 20/09/2026
// ---------------------------------------------------------------

// Escolher telemedicina, voltar ao menu e escolher uma unidade FÍSICA deixava
// booking_modality valendo 'telemedicina'. Como a unidade em andamento é
// derivada da modalidade, tudo dali para frente virava vídeo: a família saía
// achando que marcou presencial em Santos e o Dr. Rafael esperava na tela.
//
// Só aparecia em unidade com convênio, que na produção é justamente Santos.
await caso('Voltar da telemedicina para uma unidade física não marca vídeo', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
  ['2', 'Datas disponíveis'],
  ['0', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
  ['1', 'pelo convênio'],
  ['2', 'Datas disponíveis'],
  ['1', 'Horários de'],
  ['1', 'está guardado'],
], {
  unidades: UNIDADE_COM_CONVENIO,
  slots: { 'u-santos': SLOTS_CHEIOS['u-santos'] },
  telemedicina: { ativa: true, texto: 'Telemedicina R$ 450' },
  verificar: ({ marcadas, titulo }) => {
    const c = marcadas.at(-1)
    if (!c) {
      falhas.push(`${titulo} | não marcou consulta nenhuma`)
      return
    }
    if (c.modality === 'telemedicina') {
      falhas.push(`${titulo} | marcou TELEMEDICINA para quem escolheu unidade física`)
    } else passou++
    if (!c.unit_id) {
      falhas.push(`${titulo} | consulta presencial gravada sem unidade`)
    } else passou++
  },
})

// Com duas consultas marcadas, CANCELAR e REMARCAR não funcionavam depois de
// escolher qual: o atalho olhava para quantas consultas a pessoa TEM, e não
// para qual delas está em foco. O robô respondia "digite CANCELAR" a quem
// tinha acabado de digitar CANCELAR, e os botões caíam no mesmo lugar - laço
// fechado, justamente para a mãe com dois filhos em acompanhamento.
const DUAS_CONSULTAS = [
  {
    id: 'c-1',
    inicio: '2026-09-28T11:00:00Z',
    unidade: 'Liferty · Santos',
    endereco: 'Av. Ana Costa, 100',
    paciente: 'Ana Paula Souza',
    confirmada: true,
  },
  {
    id: 'c-2',
    inicio: '2026-09-29T12:00:00Z',
    unidade: 'Liferty · Santos',
    endereco: 'Av. Ana Costa, 100',
    paciente: 'Pedro Souza',
    confirmada: true,
  },
]

await caso('Com duas consultas, CANCELAR funciona depois de escolher qual', [
  ['Oi', 'Como podemos ajudar'],
  ['4', 'consultas marcadas'],
  ['2', 'Digite CANCELAR'],
  ['cancelar', 'Confirma o cancelamento'],
  ['sim', 'cancelada'],
], {
  pacientes: [ANA, PEDRO],
  consultas: DUAS_CONSULTAS,
  verificar: ({ canceladas, titulo }) => {
    if (!canceladas.includes('c-2')) {
      falhas.push(`${titulo} | não cancelou a consulta escolhida (canceladas: ${canceladas})`)
    } else passou++
  },
})

await caso('Com duas consultas, REMARCAR também funciona', [
  ['Oi', 'Como podemos ajudar'],
  ['4', 'consultas marcadas'],
  ['1', 'Digite CANCELAR'],
  ['remarcar', 'Vamos remarcar'],
], { pacientes: [ANA, PEDRO], consultas: DUAS_CONSULTAS })

// "sim, pode cancelar por favor" é sim. A comparação exata devolvia "sua
// consulta continua marcada" para quem tinha acabado de confirmar - e no
// caminho da remarcação, jogava a pessoa no menu depois de ela dizer sim.
await caso('Confirmação com palavra a mais continua sendo sim', [
  ['Oi', 'Como podemos ajudar'],
  ['4', 'Digite CANCELAR'],
  ['cancelar', 'Confirma o cancelamento'],
  ['sim, pode cancelar por favor', 'cancelada'],
], {
  pacientes: [ANA],
  consultas: [DUAS_CONSULTAS[0]],
  verificar: ({ canceladas, titulo }) => {
    if (!canceladas.includes('c-1')) {
      falhas.push(`${titulo} | entendeu o sim como desistência e manteve a consulta`)
    } else passou++
  },
})

// E "não" continua sendo não: aceitar demais aqui cancelaria consulta de quem
// estava recusando.
await caso('Confirmação em negativo mantém a consulta', [
  ['Oi', 'Como podemos ajudar'],
  ['4', 'Digite CANCELAR'],
  ['cancelar', 'Confirma o cancelamento'],
  ['não, deixa pra lá', 'continua marcada'],
], {
  pacientes: [ANA],
  consultas: [DUAS_CONSULTAS[0]],
  verificar: ({ canceladas, titulo }) => {
    if (canceladas.length) falhas.push(`${titulo} | cancelou a consulta de quem disse não`)
    else passou++
  },
})

// Um dígito solto dentro de uma frase não é escolha de menu.
//
// escolha() raspava TODOS os caracteres não numéricos e lia o que sobrava.
// "meu filho de 2 anos está com sangue nas fezes" virava a opção 2 e abria o
// agendamento; "ele tem 5 anos, o que devo levar?" abria a 2ª via. A pergunta
// nunca era respondida, e um sintoma de alarme entrava como "quero marcar".
await caso('Idade no meio da frase não escolhe opção do menu', [
  ['Oi', 'Como podemos ajudar'],
  ['meu filho de 2 anos está com sangue nas fezes', 'não posso orientar'],
])

await caso('Pergunta com número não vira escolha de menu', [
  ['Oi', 'Como podemos ajudar'],
  ['ele tem 5 anos, o que devo levar?', 'Não entendi'],
])

// E o que é escolha continua sendo escolha, escrito como as pessoas escrevem.
for (const [frase, esperado] of [
  ['2', 'Em qual unidade'],
  [' 2 ', 'Em qual unidade'],
  ['opção 2', 'Em qual unidade'],
  ['2.', 'Em qual unidade'],
  ['*2*', 'Em qual unidade'],
]) {
  await caso(`Escolha escrita como "${frase}"`, [
    ['Oi', 'Como podemos ajudar'],
    [frase, esperado],
  ])
}

// A função sobe antes das migrations - é a ordem normal do projeto. Sem plano
// B, um 'insurance' que o banco ainda não tem faz o Postgres recusar o INSERT
// inteiro, e TODO agendamento pelo WhatsApp passa a responder "não consegui
// concluir agora". Perder o convênio é arranhão; perder o horário é a família
// sem consulta.
await caso('Coluna nova ausente em appointments não impede o agendamento', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
  ['1', 'Datas disponíveis'],
  ['1', 'Horários de'],
  ['1', 'está guardado'],
], {
  colunasAusentes: ['insurance'],
  verificar: ({ marcadas, titulo }) => {
    if (!marcadas.length) falhas.push(`${titulo} | não marcou nada`)
    else passou++
    if (marcadas.at(-1) && 'insurance' in marcadas.at(-1)) {
      falhas.push(`${titulo} | insistiu na coluna que o banco não tem`)
    } else passou++
  },
})

// ---------------------------------------------------------------
// O robô fecha o que ele mesmo resolveu
// ---------------------------------------------------------------

// Cadastro completo e consulta marcada: não sobrou nada para a equipe. Antes a
// conversa não ganhava marca nenhuma - "Respondida" é sobre gente da equipe, e
// "Resolvida" só vinha de alguém clicar em Concluir -, então o cartão ficava
// com cara de pendente sem ter pendência, e a recepção abria um por um.
await caso('Fim da ficha marca o atendimento como concluído', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
  ['1', 'Datas disponíveis'],
  ['1', 'Horários de'],
  ['1', 'nome completo do paciente'],
  ['Henry Hiroshi Moraes Ribeiro', 'data de nascimento'],
  ['22/04/2026', 'nome do responsável'],
  ['Higor Henrique Ribeiro', 'CPF'],
  ['16849034839', 'e-mail'],
  ['pular', ['Tudo certo', 'Consulta marcada']],
], {
  verificar: ({ ultimoToque, titulo }) => {
    if (!ultimoToque.concluida) {
      falhas.push(`${titulo} | terminou sem marcar a conversa como concluída`)
    } else passou++
  },
})

// Pular o e-mail não deixa pendência: é campo opcional, e o robô já disse isso
// a quem respondeu PULAR. Foi o caso real de 18/09/2026.
await caso('Pular campo opcional ainda conclui o atendimento', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
  ['1', 'Datas disponíveis'],
  ['1', 'Horários de'],
  ['1', 'nome completo do paciente'],
  ['Henry Hiroshi', 'data de nascimento'],
  ['22/04/2026', 'nome do responsável'],
  ['Higor Henrique', 'CPF'],
  ['pular', 'e-mail'],
  ['pular', 'Tudo certo'],
], {
  verificar: ({ ultimoToque, titulo }) => {
    if (!ultimoToque.concluida) falhas.push(`${titulo} | não marcou como concluída`)
    else passou++
  },
})

// No meio do caminho, não. Conversa em andamento não é conversa resolvida.
await caso('Meio da ficha não é conclusão', [
  ['Oi', 'Como podemos ajudar'],
  ['2', 'Em qual unidade'],
  ['1', 'Datas disponíveis'],
  ['1', 'Horários de'],
  ['1', 'nome completo do paciente'],
  ['Henry Hiroshi', 'data de nascimento'],
], {
  verificar: ({ ultimoToque, titulo }) => {
    if (ultimoToque.concluida) falhas.push(`${titulo} | fechou uma conversa que ainda estava andando`)
    else passou++
  },
})

// Quem pediu a equipe continua pedindo. A bandeira vence a conclusão, ou o
// robô fecharia a conversa de quem está esperando uma pessoa.
await caso('Pedido de atendente não é fechado pelo robô', [
  ['Oi', 'Como podemos ajudar'],
  ['3', 'direcionando você para um atendente'],
], {
  verificar: ({ ultimoToque, titulo }) => {
    if (ultimoToque.concluida) falhas.push(`${titulo} | fechou a conversa de quem pediu gente`)
    else passou++
  },
})

console.log('\n============================================')
console.log(`VERIFICAÇÕES QUE PASSARAM: ${passou}`)
console.log(`FALHAS: ${falhas.length}`)
console.log('============================================')
for (const f of falhas) console.log('\n✗ ' + f)

console.log('\n\n===== PONTOS PARA OLHAR =====')
for (const a of achados) console.log('\n' + a)

if (falhas.length) process.exitCode = 1
