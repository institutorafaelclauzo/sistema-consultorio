import '../_shared/whatsapp.ts'
import { adminClient, digits, sha256HmacHex, safeEqual } from '../_shared/whatsapp.ts'
import { type Estado, type Toque, tratarConversa } from '../_shared/atendimento.ts'
import { montarConteudo } from '../_shared/conteudo.ts'
import {
  avisoDaResposta,
  respostaAoAcompanhamento,
  equipeFalouRecentemente as equipeFalouHaPouco,
  interpretarResposta,
  mudancaDaConsulta,
  respondendoEnvioNosso as dentroDaJanelaDeResposta,
} from '../_shared/lembrete.ts'

function text(body: string, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })
}

type Midia = { id?: string; mime_type?: string; caption?: string; filename?: string }

type WebhookMessage = {
  type?: string
  text?: { body?: string }
  image?: Midia
  document?: Midia
  audio?: Midia
  video?: Midia
  sticker?: Midia
  voice?: Midia
  button?: { text?: string; payload?: string }
  interactive?: {
    button_reply?: { id?: string; title?: string }
    list_reply?: { id?: string; title?: string }
  }
}

type DeliveryError = { title?: string; message?: string }

/**
 * Identificador do que a pessoa tocou, quando ela tocou em vez de digitar.
 *
 * Os ids sao escritos iguais ao que o robo ja aceita por escrito ("2", "SIM",
 * "CANCELAR"), entao toque e digitacao entram pelo mesmo caminho e nenhuma
 * regra precisou ser duplicada. O texto legivel continua indo para o historico.
 */
function idDoToque(message: WebhookMessage): string {
  if (message.type === 'interactive') {
    return (
      message.interactive?.button_reply?.id ??
      message.interactive?.list_reply?.id ??
      ''
    )
  }
  // Botao de modelo aprovado: a Meta manda o payload configurado no template.
  if (message.type === 'button') return message.button?.payload ?? ''
  return ''
}

/**
 * A mensagem e um arquivo, e nao texto.
 *
 * Foto, documento, audio, video, figurinha: o robo nao le nenhum deles. Servem
 * para decidir entregar para a equipe em vez de responder o menu. Localizacao e
 * contato ficam de fora porque tambem nao sao pergunta - mas sao raros o
 * bastante para nao valer regra propria hoje.
 */
function ehAnexo(message: WebhookMessage) {
  return ['image', 'document', 'audio', 'video', 'sticker', 'voice'].includes(String(message.type))
}

/** O bloco de midia da mensagem, qualquer que seja o tipo dela. */
function midiaDaMensagem(message: WebhookMessage): Midia | null {
  return (
    message.image ?? message.document ?? message.audio ??
    message.video ?? message.sticker ?? message.voice ?? null
  )
}

/**
 * Traz o arquivo da Meta para o nosso acervo.
 *
 * Precisa acontecer AGORA, no recebimento. A Meta nao entrega o arquivo no
 * webhook: entrega um id, e a URL que esse id resgata vive poucos minutos.
 * Guardar so o id para baixar depois nao funciona - quando alguem da equipe
 * abrisse a conversa, o link ja teria morrido.
 *
 * Sao duas chamadas: o id devolve uma URL, e a URL devolve os bytes. As duas
 * exigem o token, inclusive a segunda, que e o detalhe que costuma passar
 * despercebido.
 *
 * Nunca interrompe o recebimento. Se o download falhar, a mensagem entra do
 * jeito antigo, marcada como anexo e sem arquivo - melhor a equipe saber que
 * chegou algo do que perder a mensagem inteira por causa do anexo.
 */
async function guardarAnexo(
  admin: ReturnType<typeof adminClient>,
  clinicId: string,
  messageId: string,
  midia: Midia,
): Promise<{ path: string; mime: string } | null> {
  const token = Deno.env.get('WHATSAPP_ACCESS_TOKEN')?.trim()
  if (!token || !midia.id) return null
  const graphVersion = Deno.env.get('META_GRAPH_VERSION')?.trim() || 'v25.0'

  try {
    const aviso = await fetch(`https://graph.facebook.com/${graphVersion}/${midia.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!aviso.ok) {
      console.error('Meta recusou o endereco da midia', aviso.status, await aviso.text())
      return null
    }
    const { url, mime_type } = await aviso.json() as { url?: string; mime_type?: string }
    if (!url) return null

    // O download tambem vai autenticado: sem o token a Meta devolve 401.
    const arquivo = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!arquivo.ok) {
      console.error('Nao consegui baixar a midia', arquivo.status)
      return null
    }
    const bytes = new Uint8Array(await arquivo.arrayBuffer())
    const mime = midia.mime_type ?? mime_type ?? 'application/octet-stream'
    const path = `${clinicId}/${messageId}`

    const { error } = await admin.storage
      .from('whatsapp-anexos')
      .upload(path, bytes, { contentType: mime, upsert: true })
    if (error) {
      console.error('Nao consegui guardar a midia no acervo', error)
      return null
    }
    return { path, mime }
  } catch (causa) {
    console.error('Falha ao trazer a midia', causa)
    return null
  }
}

function messageBody(message: WebhookMessage) {
  if (message.type === 'text') return message.text?.body ?? ''
  if (message.type === 'button') return message.button?.text ?? message.button?.payload ?? ''
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? ''
  }
  // A legenda da foto e a mensagem de verdade: "olha o exame dele" diz mais
  // do que "[image]", e antes ela era jogada fora.
  const midia = midiaDaMensagem(message)
  const legenda = (midia?.caption ?? '').trim()
  if (legenda) return legenda
  if (midia?.filename) return midia.filename
  return `[${message.type || 'mensagem'}]`
}


const statusRank: Record<string, number> = {
  queued: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
}

Deno.serve(async (req) => {
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const verifyToken = Deno.env.get('WHATSAPP_VERIFY_TOKEN')?.trim()
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')
    if (verifyToken && mode === 'subscribe' && token === verifyToken && challenge) return text(challenge)
    return text('Webhook verification failed', 403)
  }

  if (req.method !== 'POST') return text('Method not allowed', 405)

  const rawBody = await req.text()
  const appSecret = Deno.env.get('META_APP_SECRET')?.trim()
  const providedSignature = req.headers.get('x-hub-signature-256') ?? ''
  if (!appSecret || !providedSignature.startsWith('sha256=')) return text('Unauthorized', 401)

  const expected = `sha256=${await sha256HmacHex(appSecret, rawBody)}`
  if (!safeEqual(expected, providedSignature)) return text('Invalid signature', 401)

  try {
    const payload = JSON.parse(rawBody)
    const admin = adminClient()

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue
        const value = change.value ?? {}
        const phoneNumberId = String(value.metadata?.phone_number_id ?? '')
        if (!phoneNumberId) continue

        const { data: settings } = await admin
          .from('clinic_settings')
          .select(
            'clinic_id,whatsapp_autoreply_enabled,whatsapp_autoreply_text,whatsapp_autoreply_known_text,whatsapp_menu_info_text',
          )
          .eq('whatsapp_phone_number_id', phoneNumberId)
          .maybeSingle()
        if (!settings?.clinic_id) continue
        const clinicId = settings.clinic_id

        // A Meta manda em `contacts` o nome que a pessoa configurou no WhatsApp
        // dela. Nao e nome verificado, mas para um contato sem cadastro e a
        // unica coisa que a equipe tem para saber com quem esta falando.
        const nomePorWaId = new Map<string, string>()
        for (const contato of value.contacts ?? []) {
          const id = digits(String(contato?.wa_id ?? ''))
          const nome = String(contato?.profile?.name ?? '').trim()
          if (id && nome) nomePorWaId.set(id, nome.slice(0, 120))
        }

        for (const message of value.messages ?? []) {
          const externalId = String(message.id ?? '')
          if (!externalId) continue

          // Reacao (o emoji apertado em cima de uma mensagem) nao e conversa.
          //
          // A Meta manda a reacao pelo mesmo caminho de uma mensagem de texto.
          // Como ela nao tem corpo, virava "[reaction]" e o robo respondia o
          // menu inteiro. Aconteceu com o Gabriel em 15/09/2026: ele respondeu
          // "Estou bem" ao acompanhamento, recebeu o "que bom saber", reagiu com
          // um emoji e levou de volta "Como podemos ajudar hoje?", como se
          // tivesse perguntado alguma coisa.
          //
          // Ignorada por inteiro, e nao so na resposta: guardar "[reaction]" no
          // historico suja a leitura de quem abre a conversa depois para
          // entender o caso.
          if (message.type === 'reaction') continue

          const { error: eventError } = await admin.from('whatsapp_webhook_events').insert({
            event_key: `message:${externalId}`,
            event_kind: 'message',
            payload: { entry_id: entry.id, change },
          })
          if (eventError?.code === '23505') continue
          if (eventError) throw eventError

          const waId = digits(String(message.from ?? ''))
          const localDigits = waId.startsWith('55') ? waId.slice(2) : waId
          // Todos os pacientes deste telefone, e nao o primeiro que aparecer.
          // Numa gastropediatria a mae cadastra os dois filhos com o proprio
          // celular; escolher sozinho marcava consulta no nome do irmao errado.
          const { data: patientRows } = await admin
            .from('patients')
            .select('id,name,birth_date,guardian_name,cpf,email')
            .eq('clinic_id', clinicId)
            .is('archived_at', null)
            .or(`phone_digits.eq.${waId},phone_digits.eq.${localDigits}`)
            .order('name')

          const pacientes = (patientRows ?? []).map((p) => {
            const linha = p as Record<string, unknown>
            return {
              id: p.id as string,
              name: (p.name as string) ?? '',
              // O que o cadastro ja tem. O robo so pergunta o que falta.
              nascimento: (linha.birth_date as string | null) ?? null,
              responsavel: (linha.guardian_name as string | null) ?? null,
              cpf: (linha.cpf as string | null) ?? null,
              email: (linha.email as string | null) ?? null,
            }
          })
          // Para ligar a conversa e as mensagens basta um: sao da familia toda.
          // Quem precisa de precisao e a consulta, e essa o robo pergunta.
          const patient = pacientes[0] ?? null

          // Consultas futuras deste telefone. Alimentam a opcao 4 do menu e o
          // aviso de "voce ja tem uma marcada" antes de criar uma segunda.
          const { data: futurasRows } = await admin
            .from('appointments')
            .select('id,starts_at,unit_id,contact_name,patient_id,confirmed_by_clinic')
            .eq('clinic_id', clinicId)
            .eq('status', 'scheduled')
            .gte('starts_at', new Date().toISOString())
            .or(`contact_phone.eq.${waId},contact_phone.eq.${localDigits}`)
            .order('starts_at')

          const idsUnidades = [...new Set((futurasRows ?? []).map((a) => a.unit_id))]
          const unidadesPorId = new Map<string, { name: string; address: string }>()
          if (idsUnidades.length > 0) {
            const { data: us } = await admin
              .from('clinic_units')
              .select('id,name,address')
              .in('id', idsUnidades)
            for (const u of us ?? []) unidadesPorId.set(u.id, { name: u.name, address: u.address })
          }

          const nomePorPacienteId = new Map(pacientes.map((p) => [p.id, p.name]))
          const consultas = (futurasRows ?? []).map((a) => ({
            id: a.id as string,
            inicio: a.starts_at as string,
            unidade: unidadesPorId.get(a.unit_id)?.name ?? 'nossa unidade',
            endereco: unidadesPorId.get(a.unit_id)?.address ?? '',
            paciente:
              (a.patient_id ? nomePorPacienteId.get(a.patient_id) : null) ??
              (a.contact_name as string) ??
              '',
            confirmada: Boolean(a.confirmed_by_clinic),
          }))

          // Estado da conversa ANTES de gravar esta mensagem. E o que diz se a
          // pessoa e nova: depois do upsert a linha ja existe sempre.
          //
          // A coluna nova vem num segundo pedido, e nao junto das outras. O
          // Postgres nao ignora coluna que nao existe: recusa a consulta
          // INTEIRA. Em 19/09/2026 esta linha pediu booking_insurance antes de
          // a migration rodar, linhaAnterior voltou nula, e o webhook passou a
          // tratar TODA mensagem como a primeira da conversa - com a regra de
          // "primeira mensagem sempre mostra o menu", o paciente digitava 1 e
          // recebia o menu, tres vezes seguidas, sem nenhum erro aparente.
          //
          // Perder o convenio e um arranhao. Perder o estado da conversa
          // desliga o atendimento inteiro. Por isso os dois pedidos.
          const COLUNAS_ESTAVEIS =
            'id,booking_state,booking_options,booking_unit_id,booking_patient_id,' +
            'booking_replaces_id,booking_intake_id,booking_modality,needs_attention,' +
            'attention_reason,profile_name,booking_updated_at,auto_replies_while_waiting,' +
            'menu_sent_at'

          const { data: linhaAnterior } = await admin
            .from('whatsapp_conversations')
            .select(COLUNAS_ESTAVEIS)
            .eq('clinic_id', clinicId)
            .eq('wa_id', waId)
            .maybeSingle()

          // O convenio vem num pedido proprio, e nao junto: se a coluna ainda
          // nao existe, so ele se perde.
          let convenioEmAndamento: string | null = null
          if (linhaAnterior) {
            const { data: extra } = await admin
              .from('whatsapp_conversations')
              .select('booking_insurance')
              .eq('clinic_id', clinicId)
              .eq('wa_id', waId)
              .maybeSingle()
            convenioEmAndamento =
              (extra as { booking_insurance?: string | null } | null)?.booking_insurance ?? null
          }

          // Etapa vencida: depois de 24h parada, a conversa recomeca do zero.
          //
          // A varredura de hora em hora (liberar_conversas_travadas) limpa o
          // banco e a tela, mas ela roda no minuto 10. Sem esta conferencia,
          // quem escrevesse 24h05 depois cairia na etapa velha ate a hora
          // cheia seguinte - o robo cobrando o CPF de um agendamento que a
          // pessoa ja esqueceu, ou calado porque a equipe "assumiu" ontem.
          //
          // 24h e a janela da Meta: passou dela, a sessao anterior acabou de
          // verdade e esta mensagem inaugura outra.
          const carimbo = linhaAnterior?.booking_updated_at as string | null | undefined
          // 48h quando a clinica e que ficou devendo resposta: o anexo que
          // alguem precisa abrir, o "Preciso de ajuda" respondido ao
          // acompanhamento, e o pedido de 2a via ou de exame - da familia ou da
          // farmacia. Nesses a equipe costuma precisar de mais de um dia util, e
          // o robo voltando a falar no meio seria atropelo. Nos outros, 24h.
          //
          // A MESMA LISTA vive em liberar_conversas_travadas(), no banco. As
          // duas precisam concordar: esta decide se a proxima mensagem da
          // familia reabre o menu, aquela limpa conversa parada. Em 20/09/2026
          // os motivos novos entraram so na do banco, e o efeito era este -
          // pedido feito sexta as 18h, familia escreve domingo, 40h > 24h, e o
          // robo respondia com a saudacao inteira como se nada estivesse
          // pendente. Exatamente o que a migration dizia estar evitando.
          const motivoDaEspera = String(linhaAnterior?.attention_reason ?? '')
          const ESPERA_LONGA = ['anexo', 'ajuda', 'documento', 'farmacia']
          const horasDeEspera = ESPERA_LONGA.includes(motivoDaEspera) ? 48 : 24
          const etapaVenceu = Boolean(
            linhaAnterior?.booking_state &&
              (!carimbo || Date.now() - new Date(carimbo).getTime() > horasDeEspera * 60 * 60 * 1000),
          )
          const conversaAnterior =
            linhaAnterior && etapaVenceu
              ? {
                  ...linhaAnterior,
                  booking_state: null,
                  booking_options: null,
                  booking_unit_id: null,
                  booking_patient_id: null,
                  booking_replaces_id: null,
                  booking_intake_id: null,
                  booking_modality: null,
                }
              : linhaAnterior
          if (etapaVenceu) convenioEmAndamento = null

          // A ultima coisa que NOS mandamos foi um lembrete de consulta ou um
          // acompanhamento? So nesse caso "1", "2" e "3" significam confirmar,
          // remarcar e cancelar. Fora dele sao opcoes de menu.
          //
          // Antes isso era decidido por "esta no meio de um agendamento?", o
          // que deixava o numero ambiguo em toda conversa parada. Amarrar a
          // leitura ao que acabamos de perguntar acaba com a duvida.
          let respondendoEnvioNosso = false
          // Alguem da EQUIPE escreveu para esta pessoa ha pouco: conversa humana
          // em andamento, e o robo nao entra no meio dela oferecendo menu.
          //
          // A pergunta precisa ser sobre gente. Ate 30/08/2026 ela era so "saiu
          // alguma mensagem daqui?", e o robo se calava por causa da propria
          // voz: respondeu 11:36, a pessoa escreveu "Oi" as 14:28 e nao recebeu
          // nada.
          let equipeFalouRecentemente = false
          if (conversaAnterior?.id) {
            const [ultimoNossoResult, ultimoHumanoResult] = await Promise.all([
              admin
                .from('whatsapp_messages')
                .select('followup_id,appointment_id,created_at')
                .eq('conversation_id', conversaAnterior.id)
                .eq('direction', 'outbound')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle(),
              admin
                .from('whatsapp_messages')
                .select('created_at')
                .eq('conversation_id', conversaAnterior.id)
                .eq('direction', 'outbound')
                .eq('automatic', false)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle(),
            ])

            respondendoEnvioNosso = dentroDaJanelaDeResposta(ultimoNossoResult.data)
            equipeFalouRecentemente = equipeFalouHaPouco(ultimoHumanoResult.data)
          }

          const body = messageBody(message)
          // O que a pessoa quis dizer. Vindo de toque, e o id do botao; digitado,
          // e o proprio texto. O `body` segue sendo o que aparece no historico.
          const escolhido = idDoToque(message) || body
          // Uma chamada so, e a regra mora em _shared/lembrete.ts, coberta por
          // testes. Aqui ficou apenas o desempacotar.
          const resposta = interpretarResposta(escolhido, respondendoEnvioNosso)
          const { respondeuLembrete, optedOut, isWell, pediuAjuda, motivoAtencao } = resposta
          const receivedAt = message.timestamp
            ? new Date(Number(message.timestamp) * 1000).toISOString()
            : new Date().toISOString()

          // A bandeira de atencao so sobe aqui, nunca desce: quem baixa e a
          // equipe, abrindo a conversa na tela. Antes cada nova mensagem do
          // paciente apagava o pedido anterior - quem escrevia duas vezes
          // sumia da lista de quem esperava retorno.
          // A bandeira so sobe, nunca desce por mensagem do paciente: quem
          // baixa e a equipe, abrindo a conversa na tela.
          const marcarAtencao =
            Boolean(conversaAnterior?.needs_attention) || Boolean(motivoAtencao)

          // Sem nome novo no evento, mantem o que ja estava gravado em vez de
          // apagar: nem todo evento traz o bloco `contacts`.
          const nomeDoPerfil = nomePorWaId.get(waId) ?? ''

          const { data: conversation, error: conversationError } = await admin
            .from('whatsapp_conversations')
            .upsert({
              clinic_id: clinicId,
              patient_id: patient?.id ?? null,
              wa_id: waId,
              display_phone: waId,
              status: optedOut ? 'opted_out' : 'open',
              needs_attention: marcarAtencao,
              last_message_at: receivedAt,
              ...(nomeDoPerfil ? { profile_name: nomeDoPerfil } : {}),
            }, { onConflict: 'clinic_id,wa_id' })
            .select('id,unread_count')
            .single()
          if (conversationError) throw conversationError

          const atualizacaoConversa: Record<string, unknown> = {
            unread_count: (conversation.unread_count ?? 0) + 1,
            needs_attention: marcarAtencao,
            status: optedOut ? 'opted_out' : 'open',
          }
          if (motivoAtencao) atualizacaoConversa.attention_reason = motivoAtencao
          if (nomeDoPerfil) atualizacaoConversa.profile_name = nomeDoPerfil
          await admin
            .from('whatsapp_conversations')
            .update(atualizacaoConversa)
            .eq('id', conversation.id)

          // O arquivo e buscado ANTES de gravar a mensagem: a URL da Meta dura
          // poucos minutos, e se a gravacao demorasse ela ja teria expirado.
          const midia = midiaDaMensagem(message)
          const anexo = midia && externalId
            ? await guardarAnexo(admin, clinicId, externalId, midia)
            : null

          const { error: messageError } = await admin.from('whatsapp_messages').insert({
            clinic_id: clinicId,
            conversation_id: conversation.id,
            patient_id: patient?.id ?? null,
            external_message_id: externalId,
            direction: 'inbound',
            message_type: message.type || 'text',
            body,
            status: 'delivered',
            delivered_at: receivedAt,
            ...(anexo ? { media_path: anexo.path, media_mime: anexo.mime } : {}),
          })
          if (messageError?.code !== '23505' && messageError) throw messageError

          if (patient?.id && optedOut) {
            await admin.from('patients').update({ whatsapp_opt_out_at: receivedAt }).eq('id', patient.id)
          }

          /** Envia texto livre. Vale porque a mensagem que acabou de chegar
              abriu a janela de 24h - nao precisa de modelo aprovado. */
          async function responder(
            texto: string,
            appointmentId: string | null = null,
            toques?: { botoes?: Toque[]; lista?: { rotulo: string; linhas: Toque[] } },
          ) {
            const token = Deno.env.get('WHATSAPP_ACCESS_TOKEN')?.trim()
            if (!token || !texto.trim()) return false
            const graphVersion = Deno.env.get('META_GRAPH_VERSION')?.trim() || 'v25.0'
            const enviadoEm = new Date().toISOString()

            const envio = await fetch(
              `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  messaging_product: 'whatsapp',
                  recipient_type: 'individual',
                  to: waId,
                  ...montarConteudo(texto, toques),
                }),
              },
            )
            const corpoEnvio = await envio.json()

            await admin.from('whatsapp_messages').insert({
              clinic_id: clinicId,
              conversation_id: conversation.id,
              patient_id: patient?.id ?? null,
              appointment_id: appointmentId,
              external_message_id: envio.ok ? corpoEnvio?.messages?.[0]?.id ?? null : null,
              direction: 'outbound',
              message_type: 'text',
              body: texto,
              // Quem falou foi o robo. E o que impede ele de se confundir com a
              // secretaria e ficar mudo depois da propria mensagem.
              automatic: true,
              status: envio.ok ? 'accepted' : 'failed',
              sent_at: envio.ok ? enviadoEm : null,
              failed_at: envio.ok ? null : enviadoEm,
              failure_reason: envio.ok ? null : corpoEnvio?.error?.message ?? 'Meta recusou o envio.',
            })
            return envio.ok
          }

          // ---- Atendimento automatico ----
          //
          // Um unico ponto decide o que responder: menu, informacoes,
          // agendamento ou silencio. Antes eram dois blocos independentes que
          // podiam falar juntos.
          //
          // Nao roda quando a pessoa esta respondendo um lembrete: ali "1" e
          // confirmacao de consulta, e o trecho mais abaixo cuida disso.
          // "Preciso de ajuda" tambem fica de fora: e o bloco do acompanhamento,
          // mais abaixo, que responde e entrega a conversa a equipe. Deixar o
          // menu falar antes mandava "como podemos ajudar hoje?" para quem
          // acabou de dizer que precisa de ajuda.
          if (!optedOut && !respondeuLembrete && !isWell && !pediuAjuda && settings.whatsapp_autoreply_enabled) {
            const resultado = await tratarConversa({
              admin,
              clinicId,
              conversationId: conversation.id,
              estadoAtual: (conversaAnterior?.booking_state ?? null) as Estado | null,
              opcoesAtuais: conversaAnterior?.booking_options ?? null,
              unidadeEmAndamento: conversaAnterior?.booking_unit_id ?? null,
              podeIniciarMenu: !respondendoEnvioNosso && !equipeFalouRecentemente,
              texto: escolhido,
              telefone: waId,
              pacientes,
              pacienteEmAndamento: conversaAnterior?.booking_patient_id ?? null,
              consultas,
              consultaASubstituir: conversaAnterior?.booking_replaces_id ?? null,
              consultaEmCadastro: conversaAnterior?.booking_intake_id ?? null,
              convenioEmAndamento,
              modalidadeEmAndamento: (conversaAnterior?.booking_modality ?? null) as 'presencial' | 'telemedicina' | null,
              // Quantas respostas prontas o robo ja deu nesta espera pela
              // equipe. Etapa vencida recomeca do zero junto com o resto.
              respostasNaEspera: etapaVenceu
                ? 0
                : Number(conversaAnterior?.auto_replies_while_waiting ?? 0),
              anexo: ehAnexo(message),
              // Etapa vencida zera o menu junto: depois de um dia parada, a
              // conversa recomeca do zero e a pessoa ve a apresentacao de novo.
              jaViuOMenu: !etapaVenceu && Boolean(linhaAnterior?.menu_sent_at),
              nomeDoPerfil: nomeDoPerfil || conversaAnterior?.profile_name || '',
              textos: {
                saudacao: settings.whatsapp_autoreply_text ?? '',
                saudacaoConhecida: settings.whatsapp_autoreply_known_text ?? '',
                informacoes: settings.whatsapp_menu_info_text ?? '',
              },
            })

            if (resultado) {
              await responder(resultado.resposta, null, {
                botoes: resultado.botoes,
                lista: resultado.lista,
              })
              // Atendimento fechado pelo robô, sem nada pendente para a
              // equipe. A conversa passa a "Resolvida", como se alguém
              // tivesse clicado em Concluir.
              //
              // Não é definitivo, e é por isso que dá para fazer sozinho: a
              // próxima mensagem da família devolve status 'open' algumas
              // linhas acima, no mesmo bloco que trata a mensagem recebida. O
              // que se ganha é a lista mostrando só o que ainda espera gente.
              //
              // A bandeira de atenção vence: se o mesmo resultado pedir a
              // equipe, quem manda é o pedido, e o `else` abaixo garante isso.
              if (resultado.concluida && !resultado.atencao) {
                await admin
                  .from('whatsapp_conversations')
                  .update({
                    status: 'resolved',
                    needs_attention: false,
                    attention_reason: null,
                  })
                  .eq('id', conversation.id)
              }
              if (resultado.atencao) {
                const { error: erroDaBandeira } = await admin
                  .from('whatsapp_conversations')
                  .update({ needs_attention: true, attention_reason: resultado.atencao })
                  .eq('id', conversation.id)
                // Motivo novo, banco antigo.
                //
                // A coluna tem CHECK com a lista de motivos aceitos, e a lista
                // cresce por migration. A funcao costuma subir antes: entre um
                // deploy e outro, gravar 'documento' faz o Postgres recusar o
                // UPDATE inteiro - e a conversa fica sem bandeira nenhuma, que
                // e o mesmo que o pedido nao ter chegado.
                //
                // 'atendente' e o motivo mais antigo que existe e sempre passa.
                // Perder a etiqueta exata e um arranhao; perder o pedido de
                // vista e o defeito que tudo isto veio corrigir.
                if (erroDaBandeira) {
                  console.warn('Motivo de atencao recusado pelo banco; marcando como atendente', erroDaBandeira)
                  await admin
                    .from('whatsapp_conversations')
                    .update({ needs_attention: true, attention_reason: 'atendente' })
                    .eq('id', conversation.id)
                }
              }
            }
          }

          // Confirmar, remarcar ou cancelar referem-se sempre a ultima consulta
          // sobre a qual mandamos lembrete nesta conversa.
          //
          // Nao exige paciente cadastrado. Quem manda aqui e a consulta: o
          // lembrete passou a sair tambem para quem marcou sem cadastro, e
          // exigir cadastro para LER a resposta fazia a confirmacao sumir em
          // silencio. Foi o que aconteceu em 31/08/2026 - o paciente confirmou
          // as 10:00 e so foi cadastrado depois.
          if (respondeuLembrete) {
            const { data: ultimoLembrete } = await admin
              .from('whatsapp_messages')
              .select('appointment_id')
              .eq('conversation_id', conversation.id)
              .eq('direction', 'outbound')
              .not('appointment_id', 'is', null)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()

            if (ultimoLembrete?.appointment_id) {
              // Cancelar muda o status: o indice unico de horario ignora
              // canceladas, entao a vaga volta a aparecer como livre na hora.
              const mudanca = mudancaDaConsulta(resposta, receivedAt)

              await admin
                .from('appointments')
                .update(mudanca)
                .eq('id', ultimoLembrete.appointment_id)
                .eq('status', 'scheduled')
            }

            await responder(avisoDaResposta(resposta))
          }

          // "Preciso de ajuda" explicito, e nao qualquer coisa que acendeu a
          // bandeira de atencao: um pedido de remarcacao nao reabre um
          // acompanhamento clinico.
          if (patient?.id && (isWell || pediuAjuda)) {
            const { data: lastOutbound } = await admin
              .from('whatsapp_messages')
              .select('followup_id')
              .eq('conversation_id', conversation.id)
              .eq('direction', 'outbound')
              .not('followup_id', 'is', null)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()
            if (lastOutbound?.followup_id) {
              await admin.from('followups').update(isWell
                ? { status: 'completed', completed_at: receivedAt }
                : { status: 'opened' })
                .eq('id', lastOutbound.followup_id)

              // Responde ao botao. "Preciso de ajuda" tambem entrega a conversa
              // a equipe, como o 9 do menu faria: o robo se cala ate alguem
              // assumir, em vez de mandar menu por cima de um pedido de ajuda.
              const texto = respostaAoAcompanhamento(resposta)
              if (texto) await responder(texto)
              if (pediuAjuda) {
                await admin
                  .from('whatsapp_conversations')
                  .update({
                    booking_state: 'atendente',
                    booking_options: null,
                    // Sem o carimbo a espera pela equipe ja nasceria vencida.
                    booking_updated_at: new Date().toISOString(),
                    // Espera nova, contagem nova de respostas prontas.
                    auto_replies_while_waiting: 0,
                  })
                  .eq('id', conversation.id)
              }
            }
          }

          // "Nao quero receber" apertado no acompanhamento: confirma de volta.
          // Sem isso a pessoa apertava e o silencio parecia que nao pegou.
          if (optedOut && patient?.id) {
            const texto = respostaAoAcompanhamento(resposta)
            if (texto) await responder(texto)
          }
        }

        for (const delivery of value.statuses ?? []) {
          const externalId = String(delivery.id ?? '')
          const status = String(delivery.status ?? '')
          if (!externalId || statusRank[status] === undefined) continue

          const eventKey = `status:${externalId}:${status}:${delivery.timestamp ?? ''}`
          const { error: eventError } = await admin.from('whatsapp_webhook_events').insert({
            event_key: eventKey,
            event_kind: `status_${status}`,
            payload: { entry_id: entry.id, change },
          })
          if (eventError?.code === '23505') continue
          if (eventError) throw eventError

          const { data: stored } = await admin
            .from('whatsapp_messages')
            .select('id,status,followup_id')
            .eq('external_message_id', externalId)
            .maybeSingle()
          if (!stored || statusRank[status] < (statusRank[stored.status] ?? 0)) continue

          const at = delivery.timestamp
            ? new Date(Number(delivery.timestamp) * 1000).toISOString()
            : new Date().toISOString()
          const errorText = delivery.errors
            ?.map((item: DeliveryError) => item.title || item.message)
            .filter(Boolean)
            .join('; ') || null
          const update: Record<string, unknown> = { status }
          if (status === 'sent') update.sent_at = at
          if (status === 'delivered') update.delivered_at = at
          if (status === 'read') update.read_at = at
          if (status === 'failed') {
            update.failed_at = at
            update.failure_reason = errorText || 'Falha informada pela Meta.'
          }
          await admin.from('whatsapp_messages').update(update).eq('id', stored.id)

          if (stored.followup_id) {
            const followupUpdate: Record<string, unknown> = {}
            if (status === 'delivered') followupUpdate.whatsapp_delivered_at = at
            if (status === 'read') followupUpdate.whatsapp_read_at = at
            if (status === 'failed') {
              followupUpdate.whatsapp_failed_at = at
              followupUpdate.whatsapp_failure_reason = errorText || 'Falha informada pela Meta.'
            }
            if (Object.keys(followupUpdate).length) {
              await admin.from('followups').update(followupUpdate).eq('id', stored.followup_id)
            }
          }
        }
      }
    }

    return text('EVENT_RECEIVED')
  } catch (error) {
    console.error(error)
    // A non-2xx response asks Meta to retry transient failures.
    return text('Processing failed', 500)
  }
})
