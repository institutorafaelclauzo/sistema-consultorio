import { adminClient, corsHeaders, json, userClient } from '../_shared/whatsapp.ts'
import { iniciarQuestionario, mostrarMenu } from '../_shared/atendimento.ts'
import { montarConteudo } from '../_shared/conteudo.ts'

/**
 * Resposta livre da equipe para um paciente, a partir da tela de Conversas.
 *
 * A regra que manda aqui e a janela de atendimento da Meta: texto livre so pode
 * ser enviado ate 24 horas depois da ULTIMA mensagem do paciente. Passado isso,
 * so template aprovado. A funcao recusa antes de chamar a Meta para o erro
 * chegar na tela em portugues, e nao como um codigo cru da Graph API.
 */

const JANELA_HORAS = 24
const LIMITE_CARACTERES = 4096

/** O que o questionario precisa saber da ficha: o que ja esta preenchido. */
type PacienteDaFicha = {
  id: string
  name: string
  nascimento: string | null
  responsavel: string | null
  cpf: string | null
  email: string | null
}

type ReplyRequest = {
  conversationId?: string
  /**
   * Verdadeiro quando quem escreve e o sistema, e nao alguem da equipe. Muda
   * so a marca da mensagem: o menu automatico usa isso para saber se ha gente
   * de carne e osso na conversa.
   */
  automatico?: boolean
  text?: string
  /**
   * Em vez de texto, manda o menu do robo (a lista tocavel de opcoes) e volta
   * a conversa para o estado "menu". Serve para quando a equipe reabriu a
   * conversa e quer devolver a pessoa ao atendimento automatico.
   */
  menu?: boolean
  /**
   * Em vez de texto, refaz as perguntas do cadastro (nome, nascimento,
   * responsavel, CPF, e-mail) na conversa. Serve para quem marcou e abandonou
   * a ficha: a recepcao dispara pelo botao em vez de ligar.
   */
  questionario?: boolean
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405)

  try {
    const authorization = req.headers.get('Authorization') ?? ''
    if (!authorization.startsWith('Bearer ')) return json({ error: 'Sessão obrigatória.' }, 401)

    const body = (await req.json()) as ReplyRequest
    const querMenu = body.menu === true
    const querQuestionario = body.questionario === true
    let texto = (body.text ?? '').trim()
    if (!body.conversationId) return json({ error: 'Conversa não informada.' }, 400)
    // So exige texto digitado quando e a equipe escrevendo. O menu e o
    // questionario chegam aqui sem texto de proposito: quem monta a mensagem e
    // o robo, mais abaixo. Sem esta ressalva o botao Questionario batia nesta
    // linha e voltava "Escreva a mensagem antes de enviar" sem nunca enviar.
    if (!texto && !querMenu && !querQuestionario) {
      return json({ error: 'Escreva a mensagem antes de enviar.' }, 400)
    }
    if (texto.length > LIMITE_CARACTERES) {
      return json({ error: `A mensagem passa de ${LIMITE_CARACTERES} caracteres.` }, 400)
    }

    // A RLS e a autorizacao: so aparece conversa de clinica onde o usuario e
    // membro ativo. Se nao vier nada, ele nao pode responder.
    const scoped = userClient(authorization)
    const { data: visivel, error: visivelError } = await scoped
      .from('whatsapp_conversations')
      .select('id,clinic_id,patient_id,wa_id,status')
      .eq('id', body.conversationId)
      .maybeSingle()

    if (visivelError) {
      console.error('RLS lookup failed', visivelError)
      return json({ error: 'Falha ao verificar a conversa.', code: 'RLS_LOOKUP_FAILED' }, 500)
    }
    if (!visivel) {
      return json({ error: 'Esta conversa não pertence à sua clínica.', code: 'NOT_VISIBLE' }, 403)
    }
    if (visivel.status === 'opted_out') {
      return json({
        error: 'Este contato pediu para não receber mensagens.',
        code: 'OPTED_OUT',
      }, 409)
    }

    const admin = adminClient()

    // Ultima mensagem RECEBIDA. Nao serve o last_message_at da conversa, que
    // tambem se move quando a clinica envia - isso faria a janela parecer
    // aberta para sempre.
    const { data: ultimaEntrada } = await admin
      .from('whatsapp_messages')
      .select('created_at')
      .eq('conversation_id', visivel.id)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!ultimaEntrada) {
      return json({
        error: 'Este contato ainda não escreveu para a clínica, então só é possível enviar um modelo aprovado.',
        code: 'NO_INBOUND',
      }, 409)
    }

    const fechaEm = new Date(new Date(ultimaEntrada.created_at).getTime() + JANELA_HORAS * 3600 * 1000)
    if (Date.now() > fechaEm.getTime()) {
      return json({
        error: 'A janela de 24 horas fechou. Para retomar, é preciso enviar um modelo aprovado pela Meta.',
        code: 'WINDOW_CLOSED',
        windowClosedAt: fechaEm.toISOString(),
      }, 409)
    }

    const { data: settings } = await admin
      .from('clinic_settings')
      .select('whatsapp_phone_number_id,whatsapp_autoreply_text')
      .eq('clinic_id', visivel.clinic_id)
      .single()

    // Menu do robo: o mesmo texto e a mesma lista que o paciente ve quando
    // escreve "menu", e a conversa volta para o estado inicial. A partir daqui
    // o robo responde ao que a pessoa tocar.
    let toques: Parameters<typeof montarConteudo>[1] | undefined
    if (querMenu) {
      const menu = await mostrarMenu(admin, visivel.id, (settings?.whatsapp_autoreply_text ?? '').trim())
      texto = menu?.resposta ?? ''
      toques = menu?.lista ? { lista: menu.lista } : undefined
    }

    // Questionario do cadastro, disparado pela equipe.
    //
    // As respostas precisam de um destino, e ha dois: a consulta e a ficha do
    // paciente. Basta um.
    //
    // Ate 16/09/2026 exigia consulta FUTURA, e isso deixava de fora justamente
    // quem a equipe mais quer alcancar: o paciente antigo que nunca deu o CPF e
    // nao tem nada marcado. Agora a busca e, nesta ordem: consulta futura,
    // consulta passada (a mais recente), ficha. So recusa quem nao tem nenhuma
    // das tres - ai nao ha onde guardar nada, e marcar vem primeiro.
    if (querQuestionario) {
      const agora = new Date().toISOString()
      const telefone = visivel.wa_id

      // A ficha que recebe as respostas quando nao ha consulta nenhuma.
      //
      // Procurada pelo TELEFONE, com a mesma regra do webhook (com e sem o 55
      // do pais). Tem de ser a mesma: e o webhook que vai reconhecer a pessoa
      // quando a resposta chegar, e um cadastro que ele nao encontra faria o
      // robo perguntar e jogar fora o que a familia digitasse.
      const digitos = (telefone ?? '').replace(/\D/g, '')
      const semPais = digitos.startsWith('55') ? digitos.slice(2) : digitos
      const { data: fichas } = await admin
        .from('patients')
        .select('id,name,nascimento:birth_date,responsavel:guardian_name,cpf,email')
        .eq('clinic_id', visivel.clinic_id)
        .is('archived_at', null)
        .or(`phone_digits.eq.${digitos},phone_digits.eq.${semPais}`)
        .order('name')
      const encontradas = (fichas ?? []) as unknown as PacienteDaFicha[]
      const paciente = encontradas.length === 1 ? encontradas[0] : null

      // A consulta onde pendurar as respostas: a proxima futura; nao havendo,
      // a ultima que ja passou. Qualquer uma serve - o que ela dá é um lugar
      // para o dado ficar até alguém conferir.
      const donoDaConsulta = visivel.patient_id ?? paciente?.id ?? null
      const buscarConsulta = async (futura: boolean) => {
        let busca = admin.from('appointments').select('id').eq('clinic_id', visivel.clinic_id)
        busca = donoDaConsulta
          ? busca.eq('patient_id', donoDaConsulta)
          : busca.eq('contact_phone', telefone)
        busca = futura
          ? busca.eq('status', 'scheduled').gte('starts_at', agora).order('starts_at', { ascending: true })
          : busca.lt('starts_at', agora).order('starts_at', { ascending: false })
        const { data } = await busca.limit(1).maybeSingle()
        return data as { id: string } | null
      }
      const consulta = (await buscarConsulta(true)) ?? (await buscarConsulta(false))

      if (!consulta && !paciente) {
        return json({
          error: encontradas.length > 1
            // Mae com dois filhos cadastrados no mesmo celular: perguntar "qual
            // é o CPF?" sem saber de quem seria gravar no irmao errado.
            ? 'Há mais de um paciente cadastrado neste telefone, e sem consulta marcada não dá para saber de quem são as respostas. Marque a consulta primeiro.'
            : 'Esta pessoa ainda não tem cadastro nem consulta nenhuma, então as respostas não teriam onde ficar. Marque a consulta primeiro - o robô já pergunta tudo na hora.',
          code: 'SEM_DESTINO',
        }, 409)
      }

      const inicio = await iniciarQuestionario(admin, visivel.id, consulta?.id ?? null, paciente)
      // Sem resultado nao ha primeira pergunta para mandar: ou o cadastro ja
      // esta completo, ou a montagem da pergunta falhou. Nos dois casos e
      // melhor a equipe ler o motivo do que a familia receber um vazio.
      if (!inicio?.resultado) {
        return json({
          error: 'O cadastro desta pessoa já está completo. Não há o que perguntar.',
          code: 'CADASTRO_COMPLETO',
        }, 409)
      }
      const quantas =
        inicio.faltam.length === 1 ? 'uma pergunta rápida' : `${inicio.faltam.length} perguntas rápidas`
      texto =
        `📋 Para completar o cadastro, ${quantas}.\n\n` + (inicio.resultado.resposta ?? '')
      toques = inicio.resultado.botoes ? { botoes: inicio.resultado.botoes } : undefined
    }

    if (!settings?.whatsapp_phone_number_id) {
      return json({ error: 'Configuração do WhatsApp incompleta.', code: 'INCOMPLETE' }, 409)
    }

    const token = Deno.env.get('WHATSAPP_ACCESS_TOKEN')?.trim()
    if (!token) return json({ error: 'Token do WhatsApp não configurado.', code: 'NO_TOKEN' }, 503)

    const graphVersion = Deno.env.get('META_GRAPH_VERSION')?.trim() || 'v25.0'
    const agora = new Date().toISOString()

    const resposta = await fetch(
      `https://graph.facebook.com/${graphVersion}/${settings.whatsapp_phone_number_id}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: visivel.wa_id,
          ...montarConteudo(texto, toques),
        }),
      },
    )

    const corpo = await resposta.json()

    if (!resposta.ok) {
      const motivo = corpo?.error?.message || 'Meta recusou o envio.'
      await admin.from('whatsapp_messages').insert({
        clinic_id: visivel.clinic_id,
        conversation_id: visivel.id,
        patient_id: visivel.patient_id,
        direction: 'outbound',
        automatic: body.automatico === true || querMenu || querQuestionario,
        message_type: toques ? 'interactive' : 'text',
        body: texto,
        status: 'failed',
        failed_at: agora,
        failure_reason: motivo,
      })
      return json({ error: 'A Meta recusou o envio.', code: 'META_REJECTED', details: motivo }, 502)
    }

    const { data: salva, error: salvaError } = await admin
      .from('whatsapp_messages')
      .insert({
        clinic_id: visivel.clinic_id,
        conversation_id: visivel.id,
        patient_id: visivel.patient_id,
        external_message_id: corpo?.messages?.[0]?.id ?? null,
        direction: 'outbound',
        automatic: body.automatico === true || querMenu || querQuestionario,
        message_type: toques ? 'interactive' : 'text',
        body: texto,
        status: 'accepted',
        sent_at: agora,
      })
      .select('id,status,created_at')
      .single()

    if (salvaError) {
      console.error('Message insert failed', salvaError)
      return json({
        error: 'A mensagem foi enviada mas não pôde ser registrada.',
        code: 'SAVE_FAILED',
      }, 500)
    }

    // Respondeu: a conversa deixa de pedir atencao e some o contador de novas.
    await admin
      .from('whatsapp_conversations')
      .update({ needs_attention: false, unread_count: 0, last_message_at: agora })
      .eq('id', visivel.id)

    return json({ ok: true, message: salva, windowClosesAt: fechaEm.toISOString() })
  } catch (error) {
    console.error(error)
    return json({ error: 'Não foi possível enviar a mensagem agora.' }, 500)
  }
})
