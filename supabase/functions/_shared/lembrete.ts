/**
 * Como ler a resposta de quem recebeu um lembrete de consulta.
 *
 * Isto morava dentro do meta-webhook, misturado com banco e rede, e por isso
 * nunca teve teste. O preco apareceu em 31/08/2026: o Wagner confirmou a
 * consulta, a confirmacao nao chegou na plataforma, e descobrir o porque virou
 * investigacao manual em cima de dados de producao. A regra estava errada num
 * `if` que ninguem conseguia exercitar sem mandar mensagem de verdade.
 *
 * Aqui nao ha banco nem rede: entra contexto, sai decisao. O webhook continua
 * dono de buscar os dados e gravar o resultado.
 */

/** Quanto tempo depois de um envio nosso um numero ainda responde a ele. */
const JANELA_RESPOSTA_MS = 48 * 3600 * 1000
/** Enquanto alguem da equipe estiver conversando, o robo nao interrompe. */
const JANELA_CONVERSA_HUMANA_MS = 12 * 3600 * 1000

export type Resposta = {
  confirma: boolean
  remarca: boolean
  cancela: boolean
  /** Qualquer uma das tres acima. Atalho para o que o webhook faz depois. */
  respondeuLembrete: boolean
  optedOut: boolean
  isWell: boolean
  pediuAjuda: boolean
  /** O que a equipe precisa ver na plataforma, se for o caso. */
  motivoAtencao: 'remarcacao' | 'cancelamento' | 'ajuda' | null
}

export function normalizarResposta(valor: string) {
  return valor.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
}

/**
 * A ultima coisa que NOS mandamos foi um lembrete ou um acompanhamento?
 *
 * So dentro dessa janela "1", "2" e "3" significam confirmar, remarcar e
 * cancelar. Fora dela sao opcoes do menu - e essa ambiguidade e justamente o
 * motivo de a pergunta existir.
 */
export function respondendoEnvioNosso(
  ultimoEnvio: { created_at?: string | null; followup_id?: string | null; appointment_id?: string | null } | null,
  agora = Date.now(),
) {
  if (!ultimoEnvio?.created_at) return false
  if (!ultimoEnvio.followup_id && !ultimoEnvio.appointment_id) return false
  return agora - new Date(ultimoEnvio.created_at).getTime() < JANELA_RESPOSTA_MS
}

/**
 * Alguem da equipe escreveu para esta pessoa ha pouco?
 *
 * A pergunta precisa ser sobre gente. Ate 30/08/2026 ela era so "saiu alguma
 * mensagem daqui?", e o robo se calava por causa da propria voz: respondeu
 * 11:36, a pessoa escreveu "Oi" as 14:28 e nao recebeu nada.
 */
export function equipeFalouRecentemente(
  ultimaHumana: { created_at?: string | null } | null,
  agora = Date.now(),
) {
  if (!ultimaHumana?.created_at) return false
  return agora - new Date(ultimaHumana.created_at).getTime() < JANELA_CONVERSA_HUMANA_MS
}

/**
 * O que a pessoa quis dizer.
 *
 * `escolhido` e o id do botao quando ela tocou, ou o proprio texto quando ela
 * digitou - os dois entram pelo mesmo caminho de proposito.
 */
export function interpretarResposta(escolhido: string, dentroDaJanela: boolean): Resposta {
  const r = normalizarResposta(escolhido)

  // Palavra CONTIDA na resposta, e nao a resposta inteira.
  //
  // Ate 14/09/2026 a comparacao era exata: valia "confirmar", nao valia
  // "confirmar presenca". Isso amarrava o sistema ao rotulo do botao aprovado na
  // Meta - e o rotulo mora la, nao aqui. Um botao escrito "Confirmar presenca"
  // devolvia exatamente esse texto, nao batia com nada, e a consulta nao era
  // confirmada. Sem erro na tela, sem registro: o paciente tocava em confirmar e
  // para a clinica era como se ele nao tivesse respondido.
  //
  // Com "contem", o mesmo codigo entende o botao curto, o botao longo e a pessoa
  // que digitou "quero confirmar minha consulta". Trocar o texto do botao na
  // Meta deixa de ser uma mudanca que quebra o sistema em silencio.
  const tem = (...palavras: string[]) => palavras.some((p) => r.includes(p))

  // "Nao posso confirmar", "nao vou poder", "nao quero cancelar": a negacao
  // inverte o sentido da frase inteira. Melhor cair no atendimento humano do que
  // confirmar uma consulta que a pessoa acabou de dizer que nao vai comparecer.
  const negou = /(^|\s)nao(\s|$)/.test(r)

  // O numero so vale dentro da janela para nao roubar as opcoes do menu.
  const confirma = dentroDaJanela && !negou && (r === '1' || tem('confirmar', 'confirmo', 'confirmado'))
  const remarca =
    dentroDaJanela && !negou && (r === '2' || tem('remarcar', 'reagendar', 'trocar a data', 'outro horario'))
  const cancela =
    dentroDaJanela && !negou && (r === '3' || tem('cancelar', 'cancelo', 'desmarcar'))

  const pediuAjuda = tem('preciso de ajuda', 'preciso falar')

  return {
    confirma,
    remarca,
    cancela,
    respondeuLembrete: confirma || remarca || cancela,
    // "sair" continua exato: contido, ele apareceria em "vou sair de viagem" e
    // descadastraria quem so estava avisando que viaja.
    optedOut: r === 'sair' || tem('nao quero receber', 'nao quero mais receber'),
    // Nada de "tudo bem" aqui: "bom dia, tudo bem?" e cumprimento, nao resposta
    // ao acompanhamento, e trata-lo como resposta faria o robo se calar.
    isWell: tem('estou bem', 'estamos bem', 'ele esta bem', 'ela esta bem'),
    pediuAjuda,
    // Remarcar e cancelar exigem alguem da equipe: no primeiro caso ninguem
    // escolheu o novo horario ainda; no segundo a agenda abriu um buraco que a
    // recepcao pode querer preencher.
    motivoAtencao: remarca ? 'remarcacao' : cancela ? 'cancelamento' : pediuAjuda ? 'ajuda' : null,
  }
}

/** O que gravar na consulta. Cancelar muda o status; os outros so anotam. */
export function mudancaDaConsulta(resposta: Resposta, quando: string) {
  if (resposta.confirma) return { confirmed_at: quando, reschedule_requested_at: null }
  if (resposta.cancela) return { status: 'cancelled', cancelled_at: quando, confirmed_at: null }
  return { reschedule_requested_at: quando, confirmed_at: null }
}

/**
 * O que responder de volta.
 *
 * Ate 31/08/2026 o sistema anotava a resposta e nao dizia nada: quem confirmava
 * ficava sem saber se tinha dado certo.
 */
export function avisoDaResposta(resposta: Resposta) {
  const aviso = resposta.confirma
    ? 'Consulta confirmada, obrigado! Até lá.'
    : resposta.cancela
      ? 'Consulta cancelada. Se quiser marcar outra data, digite 2.'
      : 'Certo! Já avisei a nossa equipe para remarcar com você. Alguém retorna por aqui.'
  return `${aviso}\n\nDigite 0 se precisar de mais alguma coisa.`
}

/**
 * O que responder a quem apertou um botão do acompanhamento.
 *
 * Até 08/09/2026 os três botões eram anotados e nada voltava: "Estou bem"
 * fechava o acompanhamento em silêncio, "Preciso de ajuda" acendia a bandeira
 * para a equipe sem dizer isso à família, e "Não quero receber" desligava os
 * envios sem confirmar. Quem aperta um botão espera ouvir algo.
 *
 * Devolve null quando a resposta não foi a um acompanhamento: aí quem fala é
 * o menu, como sempre.
 */
export function respostaAoAcompanhamento(resposta: Resposta): string | null {
  if (resposta.isWell) {
    return 'Que bom saber! 💙 Se surgir qualquer dúvida, é só escrever por aqui.'
  }
  if (resposta.pediuAjuda) {
    return (
      'Já avisei a nossa equipe. Pode escrever sua dúvida por aqui: quem assumir o ' +
      'atendimento vai ler tudo antes de responder.\n\n' +
      'Atendemos de segunda a sexta, das 8h às 18h. Fora desse horário, respondemos no próximo dia útil.'
    )
  }
  if (resposta.optedOut) {
    return (
      'Tudo bem, não enviaremos mais mensagens de acompanhamento. ' +
      'Se precisar da clínica, é só escrever por aqui que respondemos.'
    )
  }
  return null
}
