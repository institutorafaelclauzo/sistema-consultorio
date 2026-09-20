import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowLeft,
  Check,
  CheckCheck,
  CircleSlash,
  Clock3,
  MessageSquareText,
  Paperclip,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  UserPlus,
  X,
  ClipboardList,
  List as ListIcon,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  getAutoReply,
  getCurrentMembership,
  listConversationMessages,
  listConversations,
  getReplyWindow,
  markConversationSeen,
  reopenConversation,
  sendTemplateReply,
  resetConversationBot,
  resumoDoPaciente,
  resolveConversation,
  unresolveConversation,
  saveAutoReply,
  sendConversationReply,
  sendConversationMenu,
  sendConversationQuestionnaire,
  type AutoReplySettings,
  type Conversation,
  type ConversationMessage,
  type ResumoDoPaciente,
} from '@/lib/repository'

const STATUS_LABEL: Record<Conversation['status'], string> = {
  open: 'Em aberto',
  resolved: 'Resolvida',
  opted_out: 'Pediu para não receber',
}

/**
 * Em que etapa o robo parou nesta conversa.
 *
 * Aparece no cartao para a equipe entender por que a pessoa esta recebendo (ou
 * nao recebendo) resposta, e para o botao de destravar fazer sentido.
 */
const ETAPA_DO_ROBO: Record<string, string> = {
  menu: 'no menu',
  minha_consulta: 'vendo a consulta',
  confirmar_cancelamento: 'confirmando cancelamento',
  ja_tem_consulta: 'avisado de consulta existente',
  aguardando_paciente: 'escolhendo o paciente',
  aguardando_unidade: 'escolhendo a unidade',
  aguardando_dia: 'escolhendo o dia',
  aguardando_horario: 'escolhendo o horário',
  atendente: 'aguardando a equipe',
}

/**
 * Nem todo pedido de atencao e igual. Quem escolheu "falar com a equipe" no
 * menu esta esperando uma pessoa agora; uma falha do sistema e assunto nosso,
 * nao do paciente. Cada motivo tem sua cor para a equipe priorizar de longe.
 */
/**
 * A conversa esta resolvida do ponto de vista de quem olha a lista.
 *
 * Duas condicoes, e a segunda importa tanto quanto a primeira: alguem da equipe
 * escreveu depois do paciente E nao ha pedido aberto. Uma conversa pode ter
 * resposta e continuar pendente - quem pediu remarcacao recebeu "ja vejo aqui"
 * e segue esperando a data. Marcar essa como pronta seria perde-la.
 *
 * Vive fora do componente porque a lista pergunta isso duas vezes: para pintar
 * o cartao e para contar quantas pode esconder. As duas respostas precisam ser
 * a mesma, ou o botao esconderia um numero e sumiria com outro.
 */
function jaRespondida(conversa: Conversation): boolean {
  if (conversa.needsAttention && conversa.attentionReason) return false
  return conversa.respondidaPelaEquipe
}

const MOTIVO_ATENCAO: Record<
  NonNullable<Conversation['attentionReason']>,
  { rotulo: string; classe: string; borda: string }
> = {
  // Vermelho porque do outro lado tem alguem parado esperando resposta. Era
  // azul-escuro e se perdia entre as outras etiquetas: quem bate o olho na
  // lista precisa achar estes cartoes antes de qualquer outro.
  //
  // Nao e o mesmo vermelho da urgencia (#b42318, com anel duplo): quem pediu
  // atendente espera uma pessoa, quem pediu urgencia espera uma pessoa AGORA, e
  // as duas coisas nao podem gritar igual.
  atendente: {
    rotulo: 'Quer falar com a equipe',
    classe: 'bg-red-600 text-white',
    borda: 'border-red-500 ring-1 ring-red-500/30',
  },
  remarcacao: {
    rotulo: 'Pediu para remarcar',
    classe: 'bg-[#eef5fd] text-[#16456b]',
    borda: 'border-[#0074c8]',
  },
  cancelamento: {
    rotulo: 'Cancelou a consulta',
    classe: 'bg-red-50 text-red-700',
    borda: 'border-red-300',
  },
  ajuda: {
    rotulo: 'Pediu ajuda',
    classe: 'bg-[#eef5fd] text-[#16456b]',
    borda: 'border-[#0074c8]',
  },
  cancelou_sozinho: {
    rotulo: 'Cancelou pelo WhatsApp',
    classe: 'bg-[#eef5fd] text-[#16456b]',
    borda: 'border-[#0074c8]',
  },
  falha: {
    rotulo: 'Falha no atendimento automático',
    classe: 'bg-red-600 text-white',
    borda: 'border-red-500 ring-1 ring-red-500/30',
  },
  // Mandou foto, exame, documento ou audio. O robo nao le nada disso e entrega
  // para a equipe: tem um arquivo esperando alguem abrir.
  anexo: {
    rotulo: '📎 Enviou um arquivo',
    classe: 'bg-[#eef5fd] text-[#16456b]',
    borda: 'border-[#0074c8]',
  },
  // Pediu 2a via de receita ou de exame pelo menu. Nao e vermelho: ninguem
  // esta parado esperando resposta agora, e o robo ja prometeu 1 dia util. Mas
  // e ambar, e nao azul, porque tem prazo correndo - diferente de um aviso de
  // cancelamento, que so precisa ser lido.
  documento: {
    rotulo: '📄 Pediu 2ª via / exame',
    classe: 'bg-[#fef3c7] text-[#92400e]',
    borda: 'border-[#f59e0b]',
  },
  // Farmacia ou laboratorio pedindo correcao. Bandeira separada da de cima
  // porque quem responde precisa saber ANTES de escrever que do outro lado nao
  // esta a familia: nao se confirma cadastro nem se manda documento por ali.
  farmacia: {
    rotulo: '🏥 Farmácia/laboratório',
    classe: 'bg-[#fef3c7] text-[#92400e]',
    borda: 'border-[#f59e0b]',
  },
  // Pediu urgencia na telemedicina: uma crianca passando mal e alguem
  // esperando ligacao. E a unica bandeira que precisa gritar mais que a falha.
  urgencia: {
    rotulo: '🚨 Urgência: ligar agora',
    classe: 'bg-[#b42318] text-white',
    borda: 'border-[#b42318] ring-2 ring-[#b42318]/40',
  },
}

/**
 * O papel do WhatsApp: bege com o rabisco discreto por cima.
 *
 * O padrao vai inline como SVG porque nenhum arquivo externo carrega dentro do
 * sistema, e porque um fundo liso perde a referencia visual - e justamente ela
 * que faz a equipe reconhecer a tela como "a conversa do paciente".
 */
const FUNDO_WHATSAPP = {
  backgroundColor: '#efeae2',
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Cg fill='none' stroke='%23c4b8a8' stroke-width='1.1' stroke-linecap='round' opacity='.34'%3E%3Cpath d='M10 14h10M12 22c3-3 7-3 10 0'/%3E%3Ccircle cx='58' cy='16' r='5'/%3E%3Cpath d='M50 44l5 5 8-9M20 58h14M22 66h10'/%3E%3Cpath d='M64 62c0 3-3 5-6 5s-6-2-6-5 3-5 6-5 6 2 6 5z'/%3E%3Cpath d='M32 30l6 6 6-6'/%3E%3C/g%3E%3C/svg%3E\")",
} as const

/**
 * Os tiquinhos de entrega, como no aplicativo.
 *
 * Antes esta informacao aparecia como a palavra crua do sistema ("delivered",
 * "read") colada na hora. Quem le a tela ja conhece o simbolo de sempre; ler
 * ingles tecnico ali era ruido.
 */
/**
 * O arquivo que o paciente mandou, aberto na conversa.
 *
 * Antes disto a tela escrevia "[image]" e parava aí: a clínica sabia que algo
 * tinha chegado e precisava abrir o WhatsApp no celular de alguém para ver o
 * quê. Quem manda foto de exame quer que olhem - e era justamente essa a
 * mensagem que o robô encaminhava para a equipe.
 *
 * O link é temporário, de cinco minutos, gerado a cada abertura da conversa.
 * É foto de exame, de lesão, de criança: um endereço permanente seria
 * prontuário circulando solto.
 */
function Anexo({ url, mime }: { url: string; mime: string | null }) {
  const tipo = mime ?? ''

  if (tipo.startsWith('image/')) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt="Anexo enviado pelo paciente"
          className="mb-1 max-h-[320px] w-full rounded-[6px] object-cover"
          loading="lazy"
        />
      </a>
    )
  }

  if (tipo.startsWith('audio/')) {
    // Áudio toca na própria tela: quem descreve sintoma falando não deveria
    // obrigar a recepção a baixar arquivo para ouvir.
    return <audio src={url} controls className="mb-1 w-[240px]" />
  }

  if (tipo.startsWith('video/')) {
    return <video src={url} controls className="mb-1 max-h-[320px] w-full rounded-[6px]" />
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mb-1 flex items-center gap-2 rounded-[6px] bg-black/5 px-2 py-1.5 text-[12px] font-bold text-[#111b21] transition hover:bg-black/10"
    >
      <Paperclip className="h-3.5 w-3.5 shrink-0" />
      Abrir documento
    </a>
  )
}

function Confirmacao({ status }: { status: string }) {
  if (status === 'failed') {
    return <span className="font-bold text-[#b42318]">falhou</span>
  }
  if (status === 'queued' || status === 'accepted') {
    return <Clock3 className="h-3.5 w-3.5" aria-label="enviando" />
  }
  if (status === 'sent') {
    return <Check className="h-3.5 w-3.5" aria-label="enviada" />
  }
  // Azul so quando o paciente abriu de fato - e a unica confirmacao que diz
  // algo sobre a pessoa, e nao sobre o aparelho dela.
  return (
    <CheckCheck
      className={`h-3.5 w-3.5 ${status === 'read' ? 'text-[#53bdeb]' : ''}`}
      aria-label={status === 'read' ? 'lida' : 'entregue'}
    />
  )
}

function formatWhen(value: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  const today = new Date()
  const sameDay =
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()

  return new Intl.DateTimeFormat('pt-BR',
    sameDay ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' },
  ).format(date)
}

export type PreCadastro = { nome: string; telefone: string }

export default function Conversations({
  focoPatientId,
  onCadastrarContato,
}: {
  focoPatientId?: string | null
  /** Abre a tela de pacientes com nome e telefone do contato ja preenchidos. */
  onCadastrarContato?: (dados: PreCadastro) => void
}) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [busca, setBusca] = useState('')
  const [de, setDe] = useState('')
  const [ate, setAte] = useState('')
  // Comeca desligado: quem abre a tela espera ver a conversa inteira da
  // clinica. Esconder por conta propria seria decidir pela equipe que o dia
  // anterior nao interessa mais.
  const [esconderRespondidas, setEsconderRespondidas] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [error, setError] = useState('')
  const [clinicId, setClinicId] = useState<string | null>(null)
  const [aoVivo, setAoVivo] = useState(false)
  const [resposta, setResposta] = useState('')
  const [enviando, setEnviando] = useState(false)
  // Instante em que a janela de 24h da Meta fecha para a conversa aberta.
  const [janelaAte, setJanelaAte] = useState<string | null>(null)
  const [reabrindo, setReabrindo] = useState(false)
  const [enviandoModelo, setEnviandoModelo] = useState(false)
  const [avisoRetomada, setAvisoRetomada] = useState('')
  // Recalculado a cada minuto: sem isso a caixa continuaria habilitada depois
  // de a janela vencer com a tela aberta.
  const [agora, setAgora] = useState(() => Date.now())
  const [autoReply, setAutoReply] = useState<AutoReplySettings>({
    enabled: false,
    text: '',
    knownText: '',
    infoText: '',
  })
  const [autoReplyAberto, setAutoReplyAberto] = useState(false)
  const [salvandoAuto, setSalvandoAuto] = useState(false)
  const [avisoAuto, setAvisoAuto] = useState('')
  const [destravando, setDestravando] = useState<string | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setAgora(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  /**
   * Toda conversa abre onde ela está: no fim.
   *
   * Antes abria no topo, na primeira mensagem - que numa conversa de semanas
   * atrás é o "olá" do robô. O que acabou de acontecer (a resposta do paciente,
   * o aviso de cancelamento que a equipe mandou) ficava fora da tela, e dava a
   * impressão de que a mensagem não tinha sido enviada. O botão "Ir para o fim"
   * existia justamente porque isto faltava.
   *
   * Depois disso a tela é de quem está lendo. A lista se atualiza sozinha (a
   * cada mensagem nova, a cada confirmação de entrega que muda o tiquinho), e
   * antes cada uma dessas atualizações puxava a página para baixo - quem tinha
   * subido para reler uma conversa antiga perdia o lugar no meio da leitura.
   *
   * Agora só há dois motivos para a tela se mover sozinha: abrir a conversa, e
   * a própria equipe ter acabado de enviar algo (aí a mensagem que ela mandou
   * precisa aparecer, senão parece que não saiu). Para o resto existe o botão
   * "Ir para o fim".
   */
  useEffect(() => {
    if (!selectedId || loadingMessages || messages.length === 0) return
    const primeiraVez = conversaRolada.current !== selectedId
    conversaRolada.current = selectedId
    if (!primeiraVez && !acabamosDeEnviar.current) return
    acabamosDeEnviar.current = false
    fimDasMensagens.current?.scrollIntoView({
      behavior: primeiraVez ? 'auto' : 'smooth',
      block: 'end',
    })
  }, [selectedId, messages, loadingMessages])

  const janelaAberta = janelaAte !== null && new Date(janelaAte).getTime() > agora

  // A assinatura de tempo real e criada uma vez so. Sem estas refs ela ficaria
  // presa ao valor de selectedId do primeiro render e nunca saberia qual
  // conversa esta aberta agora.
  const selectedIdRef = useRef<string | null>(null)
  // Fim da lista de mensagens. O botao de descer rola ate ele.
  const fimDasMensagens = useRef<HTMLDivElement>(null)
  // Topo da lista. O botao de subir rola ate ele.
  const inicioDasMensagens = useRef<HTMLDivElement>(null)
  // Qual conversa ja foi posicionada no fim. Sem isto, cada mensagem nova
  // rolaria a tela de novo enquanto alguem le algo mais acima.
  const conversaRolada = useRef<string | null>(null)
  // Levantada pelos botoes de envio da equipe, e so por eles. E a unica coisa
  // que autoriza a tela a descer com a conversa ja aberta.
  const acabamosDeEnviar = useRef(false)
  const [resumo, setResumo] = useState<ResumoDoPaciente | null>(null)
  selectedIdRef.current = selectedId

  const load = useCallback(async (silencioso = false) => {
    if (!silencioso) setLoading(true)
    setError('')
    try {
      const membership = await getCurrentMembership()
      if (!membership) throw new Error('Não foi possível identificar a clínica do seu usuário.')
      setClinicId(membership.clinicId)
      const [lista, automatica] = await Promise.all([
        listConversations(membership.clinicId),
        getAutoReply(membership.clinicId),
      ])
      setConversations(lista)
      setAutoReply(automatica)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar as conversas.')
    } finally {
      if (!silencioso) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Quando a tela e aberta pelo botao "Conversa" do acompanhamento, ja abre a
   * conversa daquele paciente. Sem isso a equipe cairia na lista e teria de
   * procurar de novo - que e justamente o atalho que queremos evitar.
   */
  useEffect(() => {
    if (!focoPatientId || conversations.length === 0) return
    const alvo = conversations.find((item) => item.patientId === focoPatientId)
    if (alvo && alvo.id !== selectedId) void openConversation(alvo)
    // openConversation e estavel o bastante para este uso pontual
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focoPatientId, conversations])

  /**
   * Tempo real: a tela se atualiza sozinha quando um paciente responde, sem
   * ninguem precisar clicar em Atualizar. Numa clinica, depender de alguem
   * lembrar de atualizar a pagina significa resposta de paciente parada na tela.
   */
  useEffect(() => {
    if (!clinicId) return

    const canal = supabase
      .channel(`conversas-${clinicId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'whatsapp_messages', filter: `clinic_id=eq.${clinicId}` },
        () => {
          // Recarrega o historico da conversa aberta em qualquer evento. Nao da
          // para olhar so o registro novo: em exclusao o Supabase manda apenas o
          // registro antigo, e a tela ficaria mostrando algo que ja nao existe.
          const aberta = selectedIdRef.current
          if (aberta) {
            void listConversationMessages(aberta).then(setMessages).catch(() => {})
            // Se quem escreveu foi o paciente, a janela de 24h reabriu: sem
            // isto a caixa continuaria bloqueada ate alguem trocar de conversa.
            void getReplyWindow(aberta).then(setJanelaAte).catch(() => {})
          }
          // A lista lateral sempre reflete a ultima mensagem e o contador.
          void load(true)
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'whatsapp_conversations', filter: `clinic_id=eq.${clinicId}` },
        () => void load(true),
      )
      .subscribe((status) => setAoVivo(status === 'SUBSCRIBED'))

    return () => {
      void supabase.removeChannel(canal)
    }
  }, [clinicId, load])


  async function openConversation(conversation: Conversation) {
    setSelectedId(conversation.id)
    setLoadingMessages(true)
    setResposta('')
    setJanelaAte(null)
    // Quem posiciona a tela é o efeito que rola até a última mensagem, logo
    // que ela carrega. Aqui só zeramos a marca, para que a conversa que abre
    // seja tratada como primeira vez e dê o salto seco em vez do suave.
    conversaRolada.current = null
    try {
      const [historico, janela] = await Promise.all([
        listConversationMessages(conversation.id),
        getReplyWindow(conversation.id),
      ])
      setMessages(historico)
      setJanelaAte(janela)
      if (conversation.unreadCount > 0 || conversation.needsAttention) {
        await markConversationSeen(conversation.id)
        // Pedido de 2ª via e de farmácia continuam marcados depois de lidos:
        // eles só terminam quando o documento sai. O servidor decide isso; a
        // tela repete a mesma regra para não piscar a etiqueta e trazê-la de
        // volta no recarregamento seguinte.
        const pendente =
          conversation.attentionReason === 'documento' ||
          conversation.attentionReason === 'farmacia'
        setConversations((current) =>
          current.map((item) =>
            item.id === conversation.id
              ? pendente
                ? { ...item, unreadCount: 0 }
                : { ...item, unreadCount: 0, needsAttention: false, attentionReason: null }
              : item,
          ),
        )
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível abrir a conversa.')
    } finally {
      setLoadingMessages(false)
    }
  }

  async function enviarResposta() {
    const texto = resposta.trim()
    if (!selectedId || !texto || enviando) return
    setEnviando(true)
    setError('')
    try {
      await sendConversationReply(selectedId, texto)
      setResposta('')
      acabamosDeEnviar.current = true
      // O tempo real ja traz a mensagem nova, mas recarregar aqui evita a
      // sensacao de "sumiu" caso a assinatura esteja fora do ar.
      setMessages(await listConversationMessages(selectedId))
      void load(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível enviar a mensagem.')
      // Se a recusa foi por janela fechada, a tela precisa refletir isso.
      setJanelaAte(await getReplyWindow(selectedId).catch(() => null))
    } finally {
      setEnviando(false)
    }
  }

  async function enviarMenu() {
    if (!selectedId || enviando) return
    setEnviando(true)
    setError('')
    try {
      await sendConversationMenu(selectedId)
      acabamosDeEnviar.current = true
      setMessages(await listConversationMessages(selectedId))
      void load(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível enviar o menu.')
    } finally {
      setEnviando(false)
    }
  }

  async function enviarQuestionario() {
    if (!selectedId || enviando) return
    setEnviando(true)
    setError('')
    try {
      await sendConversationQuestionnaire(selectedId)
      acabamosDeEnviar.current = true
      setMessages(await listConversationMessages(selectedId))
      void load(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível enviar o questionário.')
    } finally {
      setEnviando(false)
    }
  }

  async function reabrirConversa() {
    if (!selectedId) return
    setReabrindo(true)
    setAvisoRetomada('')
    try {
      await reopenConversation(selectedId)
      // A janela so reabre quando o PACIENTE responder, entao a caixa continua
      // desligada de proposito. Recarregar as mensagens mostra o que saiu.
      setMessages(await listConversationMessages(selectedId))
    } catch (causa) {
      setAvisoRetomada(causa instanceof Error ? causa.message : 'Não foi possível enviar.')
    } finally {
      setReabrindo(false)
    }
  }

  /**
   * A resposta da equipe com a janela ja fechada.
   *
   * Mesmo campo de escrever de sempre; o que muda e o caminho no servidor, que
   * embrulha o texto num modelo aprovado. Por isso a caixa e esvaziada so no
   * sucesso: se a Meta recusar, o que foi escrito continua ali para tentar de
   * novo ou encurtar.
   */
  async function responderPorModelo() {
    if (!selectedId || !resposta.trim()) return
    setEnviandoModelo(true)
    setAvisoRetomada('')
    try {
      await sendTemplateReply(selectedId, resposta)
      setResposta('')
      acabamosDeEnviar.current = true
      setMessages(await listConversationMessages(selectedId))
      void load(true)
    } catch (causa) {
      setAvisoRetomada(causa instanceof Error ? causa.message : 'Não foi possível enviar.')
    } finally {
      setEnviandoModelo(false)
    }
  }

  async function salvarAutoReply() {
    if (!clinicId || salvandoAuto) return
    setSalvandoAuto(true)
    setAvisoAuto('')
    try {
      await saveAutoReply(clinicId, autoReply)
      setAvisoAuto('Resposta automática salva.')
    } catch (cause) {
      setAvisoAuto(cause instanceof Error ? cause.message : 'Não foi possível salvar.')
    } finally {
      setSalvandoAuto(false)
    }
  }

  async function reabrir(conversationId: string) {
    try {
      await unresolveConversation(conversationId)
      setConversations((current) =>
        current.map((item) => (item.id === conversationId ? { ...item, status: 'open' } : item)),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível reabrir a conversa.')
    }
  }

  async function resolve(conversationId: string) {
    try {
      await resolveConversation(conversationId)
      setConversations((current) =>
        current.map((item) =>
          item.id === conversationId
            ? { ...item, status: 'resolved', needsAttention: false, attentionReason: null, unreadCount: 0 }
            : item,
        ),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a conversa.')
    }
  }

  // Busca e filtro rodam sobre o que ja esta na tela: a listagem carrega as
  // mensagens da clinica para descobrir a ultima de cada conversa, entao
  // procurar dentro do texto nao custa consulta nova.
  const visiveis = useMemo(() => {
    const termo = busca.trim().toLowerCase()
    const digitosBusca = termo.replace(/\D/g, '')
    const inicio = de ? new Date(`${de}T00:00:00`).getTime() : null
    // Ate o fim do dia escolhido, e nao a meia-noite: quem digita 15/08 quer o
    // dia 15 inteiro.
    const fim = ate ? new Date(`${ate}T23:59:59.999`).getTime() : null

    return conversations.filter((item) => {
      // A conversa aberta continua na lista mesmo escondida: some-la debaixo do
      // proprio leitor, no instante em que a resposta sai, seria tirar a
      // conversa da tela de quem ainda esta nela.
      if (esconderRespondidas && jaRespondida(item) && item.id !== selectedId) return false
      if (inicio !== null || fim !== null) {
        const quando = item.lastMessageAt ? new Date(item.lastMessageAt).getTime() : null
        if (quando === null) return false
        if (inicio !== null && quando < inicio) return false
        if (fim !== null && quando > fim) return false
      }
      if (!termo) return true
      if (item.patientName.toLowerCase().includes(termo)) return true
      if (item.profileName.toLowerCase().includes(termo)) return true
      if (digitosBusca && item.phoneDigits.includes(digitosBusca)) return true
      return item.textoBusca.includes(termo)
    })
  }, [conversations, busca, de, ate, esconderRespondidas, selectedId])

  const respondidas = useMemo(() => conversations.filter(jaRespondida).length, [conversations])

  const filtrando = Boolean(busca.trim() || de || ate)
  /**
   * Solta o robo numa conversa travada, sem depender de ninguem mexer no banco.
   *
   * Nao apaga mensagem, consulta nem cadastro: so o rascunho do atendimento
   * automatico. A proxima mensagem do paciente recomeca do menu.
   */
  async function destravar(conversationId: string) {
    setDestravando(conversationId)
    setError('')
    try {
      await resetConversationBot(conversationId)
      setConversations((atual) =>
        atual.map((item) =>
          item.id === conversationId
            ? { ...item, bookingState: null, needsAttention: false, attentionReason: null }
            : item,
        ),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível destravar o robô.')
    } finally {
      setDestravando(null)
    }
  }

  const attention = conversations.filter((item) => item.needsAttention)
  const querAtendente = attention.filter(
    (item) => item.attentionReason === 'atendente' || item.attentionReason === 'falha',
  )
  const outrasAtencoes = attention.filter(
    (item) => item.attentionReason !== 'atendente' && item.attentionReason !== 'falha',
  )
  const selected = conversations.find((item) => item.id === selectedId) ?? null

  // Resumo do paciente da conversa aberta. Some quando o contato nao tem
  // cadastro: sem paciente nao ha historico para contar.
  useEffect(() => {
    const paciente = selected?.patientId
    if (!clinicId || !paciente) {
      setResumo(null)
      return
    }
    let vivo = true
    void (async () => {
      try {
        const dados = await resumoDoPaciente(clinicId, paciente)
        if (vivo) setResumo(dados)
      } catch {
        if (vivo) setResumo(null)
      }
    })()
    return () => {
      vivo = false
    }
  }, [clinicId, selected?.patientId])

  if (loading) {
    return (
      <div className="surface-card rounded-[22px] p-8 text-center text-xs font-semibold text-slate-500">
        Carregando conversas...
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Gruda no topo da tela em vez de ficar parado no começo da página.
          O aviso nascia aqui em cima, e quem aperta um botão da conversa está
          lá embaixo, depois de dezenas de mensagens: o servidor recusava o
          envio com o motivo explicado, e para quem estava olhando o botão não
          acontecia nada. Foi o que houve com o Questionário. */}
      {error && (
        <div className="sticky top-2 z-30 flex items-start gap-2 rounded-[16px] border border-red-200 bg-red-50 p-3 text-[11px] font-semibold text-red-700 shadow-[0_4px_14px_rgba(11,20,26,.12)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Quem escolheu "falar com a equipe" ganha um aviso proprio e mais forte:
          o robo parou de responder essa pessoa, entao ela so sai do lugar se
          alguem daqui abrir a conversa. */}
      {querAtendente.length > 0 && (
        <button
          type="button"
          onClick={() => void openConversation(querAtendente[0])}
          className="flex w-full items-center gap-2 rounded-[16px] border-2 border-[#16456b] bg-[#16456b] p-3 text-left text-[11px] font-bold text-white transition hover:bg-[#123852]"
        >
          <MessageSquareText className="h-4 w-4 shrink-0" />
          {querAtendente.length === 1
            ? '1 pessoa pediu para falar com a equipe e está esperando resposta.'
            : `${querAtendente.length} pessoas pediram para falar com a equipe e estão esperando resposta.`}
        </button>
      )}

      {outrasAtencoes.length > 0 && (
        <div className="flex items-center gap-2 rounded-[16px] border border-[#0074c8]/40 bg-[#eef5fd] p-3 text-[11px] font-bold text-[#16456b]">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {outrasAtencoes.length === 1
            ? '1 paciente respondeu e está aguardando retorno da equipe.'
            : `${outrasAtencoes.length} pacientes responderam e estão aguardando retorno da equipe.`}
        </div>
      )}

      {/* Resposta automatica de primeiro contato. Fica aqui, e nao numa tela de
          configuracao escondida, porque quem cuida das conversas e quem sabe se
          o texto esta certo. */}
      <div className="surface-card rounded-[18px] p-3">
        <button
          type="button"
          onClick={() => setAutoReplyAberto((v) => !v)}
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <span className="flex items-center gap-2 text-[11px] font-extrabold text-[#081b2c]">
            <Sparkles className="h-3.5 w-3.5 text-[#0074c8]" />
            Menu automático do WhatsApp
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
              autoReply.enabled
                ? 'bg-[#eef3f2] text-[#557f75]'
                : 'bg-slate-100 text-slate-500'
            }`}
          >
            {autoReply.enabled ? 'Ligada' : 'Desligada'}
          </span>
        </button>

        {autoReplyAberto && (
          <div className="mt-3 border-t border-[#081b2c]/[0.07] pt-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={autoReply.enabled}
                onChange={(e) => setAutoReply({ ...autoReply, enabled: e.target.checked })}
                className="h-3.5 w-3.5 accent-[#0074c8]"
              />
              <span className="text-[11px] font-bold text-[#081b2c]">
                Responder automaticamente quem escreve para a clínica
              </span>
            </label>

            {/* As opcoes 1, 2 e 3 nao sao editaveis: elas correspondem ao que o
                sistema sabe fazer. Mostrar o menu montado evita a duvida de
                "onde eu escrevo as opcoes?". */}
            <p className="mt-3 text-[10px] font-extrabold uppercase tracking-wide text-slate-400">
              Como a mensagem chega
            </p>
            <div className="mt-1 rounded-[14px] border border-[#081b2c]/10 bg-[#fbfaf8] p-3 text-[11px] leading-relaxed text-[#081b2c]">
              <span className="text-slate-500">{autoReply.text || 'Saudação'}</span>
              <br />
              <br />
              Como podemos ajudar? Responda com o número:
              <br />
              <br />
              1 - Informações sobre a consulta
              <br />
              2 - Agendar consulta
              <br />
              3 - Falar com a nossa equipe
            </div>

            <p className="mt-3 text-[10px] font-extrabold uppercase tracking-wide text-slate-400">
              Saudação para quem não é paciente cadastrado
            </p>
            <textarea
              value={autoReply.text}
              onChange={(e) => setAutoReply({ ...autoReply, text: e.target.value })}
              rows={2}
              className="mt-1 w-full resize-y rounded-[14px] border border-[#081b2c]/10 bg-white p-3 text-[11px] leading-relaxed outline-none focus:border-[#0074c8]"
            />

            <p className="mt-3 text-[10px] font-extrabold uppercase tracking-wide text-slate-400">
              Saudação para quem já é paciente
            </p>
            <textarea
              value={autoReply.knownText}
              onChange={(e) => setAutoReply({ ...autoReply, knownText: e.target.value })}
              rows={2}
              className="mt-1 w-full resize-y rounded-[14px] border border-[#081b2c]/10 bg-white p-3 text-[11px] leading-relaxed outline-none focus:border-[#0074c8]"
            />
            <p className="mt-2 text-[10px] text-slate-500">
              O sistema identifica o paciente pelo telefone. Escreva <strong>{'{nome}'}</strong> onde
              quiser o primeiro nome dele.
            </p>

            <p className="mt-3 text-[10px] font-extrabold uppercase tracking-wide text-slate-400">
              Opção 1 - Fecho comum das informações
            </p>
            <textarea
              value={autoReply.infoText}
              onChange={(e) => setAutoReply({ ...autoReply, infoText: e.target.value })}
              rows={12}
              className="mt-1 w-full resize-y rounded-[14px] border border-[#081b2c]/10 bg-white p-3 text-[11px] leading-relaxed outline-none focus:border-[#0074c8]"
            />
            <p className="mt-2 text-[10px] text-slate-500">
              Vai no fim do texto de qualquer unidade e da telemedicina: como agendar, como falar com a
              equipe, telefones e horário. O valor, o endereço e o que levar de cada lugar ficam em
              Preferências, em "Informações por unidade".
            </p>
            <p className="mt-1 text-[10px] text-slate-500">
              A opção 2 usa a agenda das unidades. A opção 3 marca a conversa aqui em
              destaque e o robô para de responder, para não falar por cima da equipe.
              Quem está respondendo acompanhamento ou lembrete de consulta não recebe o menu.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void salvarAutoReply()}
                disabled={salvandoAuto}
                className="rounded-xl bg-[#005b9e] px-4 py-2 text-[10px] font-extrabold text-white transition hover:bg-[#004b83] disabled:opacity-40"
              >
                {salvandoAuto ? 'Salvando...' : 'Salvar menu automático'}
              </button>
              {avisoAuto && (
                <span className="text-[10px] font-bold text-[#557f75]">{avisoAuto}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {conversations.length > 0 && (
        <div className="surface-card flex flex-wrap items-center gap-2 rounded-[18px] p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por nome, telefone ou algo que foi dito"
              className="w-full rounded-[12px] border border-[#081b2c]/10 bg-white py-2 pl-9 pr-3 text-[11px] outline-none focus:border-[#0074c8]"
            />
          </div>
          <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500">
            De
            <input
              type="date"
              value={de}
              onChange={(e) => setDe(e.target.value)}
              className="rounded-[12px] border border-[#081b2c]/10 bg-white px-2 py-2 text-[11px] outline-none focus:border-[#0074c8]"
            />
          </label>
          <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500">
            até
            <input
              type="date"
              value={ate}
              onChange={(e) => setAte(e.target.value)}
              className="rounded-[12px] border border-[#081b2c]/10 bg-white px-2 py-2 text-[11px] outline-none focus:border-[#0074c8]"
            />
          </label>
          {filtrando && (
            <button
              type="button"
              onClick={() => {
                setBusca('')
                setDe('')
                setAte('')
              }}
              className="inline-flex items-center gap-1 rounded-[12px] bg-slate-100 px-3 py-2 text-[10px] font-extrabold text-slate-600 transition hover:bg-slate-200"
            >
              <X className="h-3 w-3" />
              Limpar
            </button>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-[11px] font-bold text-slate-500">
          {conversations.length === 0
            ? 'Nenhuma conversa ainda'
            : filtrando
              ? `${visiveis.length} de ${conversations.length} ${conversations.length === 1 ? 'conversa' : 'conversas'}`
              : `${conversations.length} ${conversations.length === 1 ? 'conversa' : 'conversas'}`}
          {aoVivo && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#eef3f2] px-2 py-0.5 text-[9px] font-extrabold text-[#557f75]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#3fa88a]" />
              Ao vivo
            </span>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          {/* Esmaecer ja separa as respondidas, mas em dia cheio elas continuam
              ocupando a lista. Este botao tira as resolvidas da frente e deixa
              so o que falta - sem apagar nada: e um filtro de tela, e volta no
              mesmo clique. */}
          {respondidas > 0 && (
            <button
              type="button"
              onClick={() => setEsconderRespondidas((atual) => !atual)}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[10px] font-extrabold transition ${
                esconderRespondidas
                  ? 'bg-[#557f75] text-white hover:bg-[#4a6f66]'
                  : 'bg-[#eef3f2] text-[#557f75] hover:bg-[#e2ece9]'
              }`}
            >
              <Check className="h-3.5 w-3.5" />
              {esconderRespondidas ? `Mostrar respondidas (${respondidas})` : 'Esconder respondidas'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#eef3f2] px-3 py-1.5 text-[10px] font-extrabold text-[#557f75] transition hover:bg-[#e2ece9]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Atualizar
          </button>
        </div>
      </div>

      {conversations.length === 0 ? (
        <div className="surface-card rounded-[22px] p-10 text-center">
          <MessageSquareText className="mx-auto h-8 w-8 text-slate-300" />
          <p className="mt-3 text-sm font-bold text-[#081b2c]">Nenhuma resposta recebida ainda</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
            Quando um paciente responder a mensagem de acompanhamento, a conversa aparece aqui.
          </p>
        </div>
      ) : (
        /* minmax(0,1fr) tambem na coluna unica do celular. Sem isso a coluna
           implicita e "auto", e o texto sem quebra das previas (truncate) faz
           a coluna crescer ate a largura do texto inteiro: a lista saia pela
           direita da tela e o botao de cada conversa ficava fora do alcance. */
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          {/* No computador, lista e conversa convivem lado a lado. No celular
              nao cabem: a conversa ficava embaixo da lista inteira, e tocar num
              nome parecia nao fazer nada - a tela continuava igual e o
              historico estava a muitas rolagens de distancia. Aqui vale uma
              coisa de cada vez, com o botao de voltar no topo da conversa. */}
          <div className={`min-w-0 space-y-2 ${selected ? 'hidden lg:block' : ''}`}>
            {visiveis.length === 0 && (
              <div className="surface-card rounded-[18px] p-6 text-center text-[11px] font-semibold text-slate-500">
                {/* Sem esta frase, esconder as respondidas num dia em que tudo
                    foi respondido devolvia "nenhuma conversa com esses filtros"
                    - e parece que a lista quebrou, quando na verdade e a melhor
                    noticia possivel. */}
                {esconderRespondidas && !filtrando
                  ? 'Tudo respondido. Nada esperando a equipe.'
                  : 'Nenhuma conversa encontrada com esses filtros.'}
              </div>
            )}
            {visiveis.map((conversation) => {
              const active = conversation.id === selectedId
              const motivo = conversation.needsAttention && conversation.attentionReason
                ? MOTIVO_ATENCAO[conversation.attentionReason]
                : null
              // Alguem da equipe ja escreveu depois da ultima mensagem do
              // paciente. Enquanto ha motivo de atencao aberto a marca nao
              // aparece: o pedido continua de pe mesmo com resposta dada.
              const respondida = jaRespondida(conversation)
              // O contorno do motivo vence o de "selecionada": quem pediu
              // atendente precisa saltar da lista mesmo sem estar aberta.
              //
              // E a respondida perde para as duas. Ela recua de proposito - fica
              // verde-agua apagada, sem o branco das outras -, porque o que a
              // lista precisa entregar num relance e o que FALTA. Quem ja foi
              // atendido continua ali, legivel, so que fora do caminho do olho.
              const contorno = motivo
                ? `${motivo.borda} bg-white`
                : active
                  ? 'border-[#0074c8] bg-white shadow-[0_10px_28px_rgba(8,27,44,.10)]'
                  : respondida
                    ? 'border-[#557f75]/20 bg-[#eef3f2]/60 hover:border-[#557f75]/40 hover:bg-[#eef3f2]'
                    : 'border-[#081b2c]/10 bg-white/70 hover:border-[#081b2c]/20 hover:bg-white'
              const semCadastro = !conversation.patientId
              // Sem cadastro, o nome do WhatsApp e melhor do que "Contato sem
              // cadastro" - mas vem com etiqueta, porque e o apelido que a
              // pessoa escolheu, nao um nome conferido pela clinica.
              const titulo = semCadastro
                ? conversation.profileName || 'Contato sem cadastro'
                : conversation.patientName
              return (
                <div
                  key={conversation.id}
                  className={`w-full rounded-[18px] border p-3 transition ${contorno}`}
                >
                  <button
                    type="button"
                    onClick={() => void openConversation(conversation)}
                    className="w-full text-left"
                  >
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-xs font-extrabold text-[#081b2c]">
                      {titulo}
                    </span>
                    <span className="shrink-0 text-[9px] font-bold text-slate-400">
                      {formatWhen(conversation.lastMessageAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] font-bold tracking-wide text-slate-400">
                    {conversation.phone}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-slate-500">
                    {conversation.lastMessage || 'Sem mensagens'}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {semCadastro && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-extrabold text-slate-500">
                        {conversation.profileName ? 'Nome do WhatsApp' : 'Sem cadastro'}
                      </span>
                    )}
                    {motivo ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${motivo.classe}`}
                      >
                        {motivo.rotulo}
                      </span>
                    ) : conversation.needsAttention ? (
                      <span className="rounded-full bg-[#eef5fd] px-2 py-0.5 text-[9px] font-extrabold text-[#16456b]">
                        Aguardando retorno
                      </span>
                    ) : null}
                    {conversation.unreadCount > 0 && (
                      <span className="rounded-full bg-[#005b9e] px-2 py-0.5 text-[9px] font-extrabold text-white">
                        {conversation.unreadCount} nova{conversation.unreadCount > 1 ? 's' : ''}
                      </span>
                    )}
                    {/* So aparece quando a conversa segue aberta: em conversa
                        encerrada "Resolvida" ja diz mais, e duas etiquetas
                        verdes lado a lado nao diriam nada. */}
                    {respondida && conversation.status === 'open' && (
                      /* Cheia, e não em tom claro: no cartão esmaecido a
                         etiqueta clara sumia junto com o resto, e ela é
                         justamente o que explica por que aquele cartão está
                         apagado.

                         Verde, e não o azul-escuro da marca: o azul é a cor
                         neutra desta tela - título, contador de novas, botão
                         selecionado -, e a etiqueta se confundia com ele. O
                         verde diz "feito" sozinho, sem depender de ler. */
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#237128] px-2 py-0.5 text-[9px] font-extrabold text-white">
                        <Check className="h-2.5 w-2.5" />
                        Respondida
                      </span>
                    )}
                    {conversation.status === 'opted_out' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[9px] font-extrabold text-red-600">
                        <CircleSlash className="h-2.5 w-2.5" />
                        Não quer receber
                      </span>
                    )}
                    {conversation.status === 'resolved' && (
                      <span className="rounded-full bg-[#eef3f2] px-2 py-0.5 text-[9px] font-extrabold text-[#557f75]">
                        Resolvida
                      </span>
                    )}
                  </div>
                  </button>

                  {/* Etapa do robo + botao de soltar. Aparece so quando ha
                      algo preso: sem etapa aberta, nao ha o que destravar. */}
                  {conversation.bookingState && (
                    <div className="mt-2 flex items-center justify-between gap-2 rounded-[12px] bg-[#f6f4f1] px-2.5 py-1.5">
                      <span className="truncate text-[9px] font-bold text-slate-500">
                        Robô: {ETAPA_DO_ROBO[conversation.bookingState] ?? conversation.bookingState}
                      </span>
                      <button
                        type="button"
                        onClick={() => void destravar(conversation.id)}
                        disabled={destravando === conversation.id}
                        title="Zera a etapa do robô. Não apaga mensagens nem consultas."
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-white px-2 py-1 text-[9px] font-extrabold text-[#081b2c] transition hover:bg-[#005b9e] hover:text-white disabled:opacity-40"
                      >
                        <RotateCcw className="h-3 w-3" />
                        {destravando === conversation.id ? 'Soltando...' : 'Destravar'}
                      </button>
                    </div>
                  )}

                  {semCadastro && onCadastrarContato && (
                    <button
                      type="button"
                      onClick={() =>
                        onCadastrarContato({
                          // O apelido do WhatsApp entra so como ponto de
                          // partida: quem cadastra confere e corrige.
                          nome: conversation.profileName,
                          telefone: conversation.phone,
                        })
                      }
                      className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-[12px] border border-[#081b2c]/15 bg-white px-3 py-2 text-[10px] font-extrabold text-[#081b2c] transition hover:border-[#0074c8] hover:text-[#16456b]"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      Cadastrar como paciente
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <div
            className={`surface-card min-h-[320px] min-w-0 rounded-[22px] p-4 ${
              selected ? '' : 'hidden lg:block'
            }`}
          >
            {!selected ? (
              <p className="pt-16 text-center text-xs font-semibold text-slate-400">
                Escolha uma conversa para ver o histórico.
              </p>
            ) : (
              <>
                {/* Só no celular: no computador a lista está do lado, e um
                    botão de voltar ali seria um passo inventado. */}
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="mb-3 inline-flex items-center gap-1.5 rounded-xl border border-[#081b2c]/10 px-3 py-2 text-[10px] font-extrabold text-slate-500 transition hover:text-[#005b9e] lg:hidden"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Todas as conversas
                </button>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#081b2c]/[0.07] pb-3">
                  <div>
                    <p className="text-sm font-extrabold text-[#081b2c]">{selected.patientName}</p>
                    <p className="text-[10px] font-bold text-slate-400">
                      {selected.phone} · {STATUS_LABEL[selected.status]}
                    </p>
                    {/* Com quem a equipe esta falando, em quatro numeros. Quem
                        ja veio cinco vezes e quem cancelou tres seguidas
                        merecem respostas diferentes, e isso so aparecia
                        garimpando outras telas. */}
                    {resumo && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-bold">
                        <span className="text-slate-500">
                          {resumo.contatos} {resumo.contatos === 1 ? 'contato' : 'contatos'}
                        </span>
                        <span className="text-[#1c6b3a]">
                          {resumo.realizadas}{' '}
                          {resumo.realizadas === 1 ? 'consulta feita' : 'consultas feitas'}
                        </span>
                        {resumo.agendadas > 0 && (
                          <span className="text-[#1d4ed8]">
                            {resumo.agendadas}{' '}
                            {resumo.agendadas === 1 ? 'agendada' : 'agendadas'}
                          </span>
                        )}
                        {resumo.cancelamentos > 0 && (
                          <span className="text-[#b42318]">
                            {resumo.cancelamentos}{' '}
                            {resumo.cancelamentos === 1 ? 'cancelamento' : 'cancelamentos'}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {selected.status === 'resolved' ? (
                    <button
                      type="button"
                      onClick={() => void reabrir(selected.id)}
                      title="Volta a conversa para a lista de abertas"
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[#081b2c]/10 px-3 py-1.5 text-[10px] font-extrabold text-[#005b9e] transition hover:bg-[#eff6fd]"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Reabrir conversa
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void resolve(selected.id)}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[#eef3f2] px-3 py-1.5 text-[10px] font-extrabold text-[#557f75] transition hover:bg-[#e2ece9]"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Marcar como resolvida
                    </button>
                  )}
                </div>

                {/* O bloco inteiro continua no rodape, junto da caixa de
                    resposta que ele explica. Aqui em cima fica so o atalho:
                    quem abre a conversa para escrever descobre na hora que nao
                    vai poder, em vez de rolar a conversa inteira ate esbarrar
                    no aviso. */}
                {!janelaAberta && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-[#0074c8]/30 bg-[#f0f6fd] px-3.5 py-2.5">
                    <p className="text-[10px] font-extrabold text-[#16456b]">
                      Janela de resposta fechada. Só dá para enviar um convite.
                    </p>
                    <button
                      type="button"
                      disabled={reabrindo}
                      onClick={() => void reabrirConversa()}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[#16456b] px-3 py-1.5 text-[10px] font-extrabold text-white transition hover:bg-[#10344f] disabled:cursor-wait disabled:opacity-50"
                    >
                      <MessageSquareText className="h-3.5 w-3.5" />
                      {reabrindo ? 'Enviando...' : 'Enviar convite'}
                    </button>
                  </div>
                )}

                {loadingMessages ? (
                  <p className="pt-12 text-center text-xs font-semibold text-slate-400">
                    Carregando mensagens...
                  </p>
                ) : (
                  /* A conversa imita o WhatsApp de proposito: mesmo papel
                     bege, verde nosso a direita, branco do paciente a
                     esquerda, hora e confirmacao dentro do balao. Quem le esta
                     tela precisa saber na hora o que o paciente esta vendo do
                     outro lado, e o painel escuro do resto do sistema obrigava
                     a traduzir mentalmente a cada mensagem. */
                  <div className="relative mt-3 rounded-[14px] bg-[#efeae2] px-3 py-4" style={FUNDO_WHATSAPP}>
                    {/* Conversas antigas tem dezenas de mensagens, e o que
                        interessa esta sempre no fim. Sem isto a equipe rolava a
                        roda ate cansar toda vez que abria uma conversa.

                        Os dois sentidos, e nao so um: a conversa abre no fim,
                        entao subir ate o comeco - para reler como tudo comecou,
                        ou achar o que o paciente pediu na primeira mensagem -
                        era o caminho que dava mais trabalho e nao tinha atalho. */}
                    {messages.length > 6 && (
                      <div className="sticky top-1 z-10 mb-1 flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            inicioDasMensagens.current?.scrollIntoView({
                              behavior: 'smooth',
                              block: 'start',
                            })
                          }
                          className="flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1.5 text-[10px] font-extrabold text-[#557f75] shadow-[0_2px_6px_rgba(11,20,26,.18)] backdrop-blur transition hover:bg-white"
                        >
                          <ArrowUp className="h-3 w-3" />
                          Ir para o início
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            fimDasMensagens.current?.scrollIntoView({
                              behavior: 'smooth',
                              block: 'end',
                            })
                          }
                          className="flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1.5 text-[10px] font-extrabold text-[#557f75] shadow-[0_2px_6px_rgba(11,20,26,.18)] backdrop-blur transition hover:bg-white"
                        >
                          <ArrowDown className="h-3 w-3" />
                          Ir para o fim
                        </button>
                      </div>
                    )}
                    <div className="space-y-2">
                      <div ref={inicioDasMensagens} />
                      {messages.map((message) => {
                        const outbound = message.direction === 'outbound'
                        return (
                          <div
                            key={message.id}
                            className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}
                          >
                            <div
                              className={`relative max-w-[78%] rounded-[8px] px-2.5 py-1.5 shadow-[0_1px_0.5px_rgba(11,20,26,.13)] ${
                                outbound ? 'bg-[#d9fdd3]' : 'bg-white'
                              }`}
                            >
                              {message.anexoUrl && <Anexo url={message.anexoUrl} mime={message.anexoMime} />}
                              {/* Sem texto e com arquivo, a linha de "[image]"
                                  vira ruído embaixo da própria foto. */}
                              {(!message.anexoUrl || !/^\[/.test(message.body)) && (
                                <p className="whitespace-pre-wrap break-words text-[13.5px] leading-[19px] text-[#111b21]">
                                  {message.body ||
                                    (message.templateName
                                      ? `[modelo: ${message.templateName}]`
                                      : '[sem conteúdo]')}
                                </p>
                              )}
                              <span className="mt-0.5 flex items-center justify-end gap-1 text-[11px] leading-none text-[#667781]">
                                {formatWhen(message.createdAt)}
                                {outbound && <Confirmacao status={message.status} />}
                              </span>
                              {message.failureReason && (
                                <p className="mt-1 text-[11px] font-semibold text-[#b42318]">
                                  {message.failureReason}
                                </p>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <div ref={fimDasMensagens} />
                  </div>
                )}

                {/* Caixa de resposta. A Meta so aceita texto livre por 24h
                    depois da ultima mensagem do paciente, entao o prazo fica a
                    vista e a caixa se desliga sozinha quando fecha - senao a
                    equipe digita, envia e a mensagem falha sem explicacao. */}
                <div className="mt-4 border-t border-[#081b2c]/[0.07] pt-3">
                  {janelaAberta ? (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[10px] font-bold text-[#557f75]">
                          Pode responder livremente até {formatWhen(janelaAte)}
                        </p>
                        <p className="text-[10px] font-semibold text-slate-400">
                          {resposta.length}/4096
                        </p>
                      </div>
                      <textarea
                        value={resposta}
                        onChange={(e) => setResposta(e.target.value)}
                        onKeyDown={(e) => {
                          // Enter envia, Shift+Enter quebra linha.
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            void enviarResposta()
                          }
                        }}
                        rows={3}
                        maxLength={4096}
                        placeholder="Escreva sua resposta..."
                        className="mt-2 w-full resize-y rounded-[14px] border border-[#081b2c]/10 bg-white p-3 text-[12px] leading-relaxed outline-none focus:border-[#0074c8]"
                      />
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[9px] font-semibold text-slate-400">
                          Enter envia · Shift+Enter quebra linha
                        </p>
                        {/* Devolve a pessoa ao robo: manda o menu de opcoes e a
                            conversa volta ao inicio. Util depois de um convite
                            de retomada, quando a janela reabriu e a equipe nao
                            quer conduzir a conversa a mao. */}
                        <button
                          type="button"
                          disabled={enviando}
                          onClick={() => void enviarMenu()}
                          className="mr-auto inline-flex items-center gap-1.5 rounded-xl border border-[#081b2c]/10 bg-white px-3 py-2 text-[10px] font-extrabold text-slate-600 transition hover:border-[#081b2c]/25 hover:text-[#081b2c] disabled:opacity-40"
                          title="Envia o menu de opções do robô e volta a conversa ao atendimento automático"
                        >
                          <ListIcon className="h-3.5 w-3.5" />
                          Enviar menu de opções
                        </button>
                        {/* O cadastro que ficou pela metade.
                            Quem marca e toca em "Voltar ao menu" no meio das
                            perguntas fica com consulta e ficha vazia, e a
                            clínica só descobre na véspera. Este botão manda as
                            perguntas de novo, na conversa que já existe, em vez
                            de alguém ligar atrás do CPF. */}
                        <button
                          type="button"
                          disabled={enviando}
                          onClick={() => void enviarQuestionario()}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-[#081b2c]/10 bg-white px-3 py-2 text-[10px] font-extrabold text-slate-600 transition hover:border-[#081b2c]/25 hover:text-[#081b2c] disabled:opacity-40"
                          title="Refaz as perguntas do cadastro (nome, nascimento, responsável, CPF e e-mail) para a próxima consulta desta pessoa"
                        >
                          <ClipboardList className="h-3.5 w-3.5" />
                          Questionário
                        </button>
                        <button
                          type="button"
                          disabled={enviando || !resposta.trim()}
                          onClick={() => void enviarResposta()}
                          className="inline-flex items-center gap-1.5 rounded-xl bg-[#005b9e] px-4 py-2 text-[10px] font-extrabold text-white transition hover:bg-[#004b83] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Send className="h-3.5 w-3.5" />
                          {enviando ? 'Enviando...' : 'Enviar'}
                        </button>
                      </div>
                    </>
                  ) : (
                    /* Antes daqui saia so o aviso, e a equipe ficava sem saida
                       dentro do proprio sistema: lia "e preciso um modelo
                       aprovado" e nao tinha por onde enviar um. O botao manda o
                       modelo de utilidade que reabre a conversa - ele nao
                       resolve o assunto, abre a porta para resolver. */
                    <div className="rounded-[14px] border border-[#0074c8]/30 bg-[#f0f6fd] px-4 py-3">
                      <p className="text-[11px] font-extrabold text-[#16456b]">
                        {janelaAte
                          ? `A janela de resposta fechou em ${formatWhen(janelaAte)}`
                          : 'Este contato ainda não escreveu para a clínica'}
                      </p>
                      <p className="mt-1 text-[10px] font-semibold text-[#16456b]/80">
                        A Meta só permite texto livre nas 24 horas seguintes à mensagem do paciente.
                        Fora delas você tem dois caminhos: responder agora dentro de um modelo
                        aprovado, ou convidar a família a escrever para a conversa reabrir.
                      </p>

                      {/* Caminho 1: a resposta sai agora, dentro do modelo. */}
                      <textarea
                        value={resposta}
                        onChange={(evento) => setResposta(evento.target.value)}
                        rows={3}
                        maxLength={700}
                        placeholder="Escreva a resposta. Ela chega precedida de 'Olá, [nome]. Aqui é o consultório do Dr. Rafael Clauzo.'"
                        className="mt-3 w-full resize-y rounded-xl border border-[#0074c8]/25 bg-white px-3 py-2.5 text-[11px] font-semibold leading-relaxed text-[#081b2c] outline-none transition placeholder:font-medium placeholder:text-slate-300 focus:border-[#0074c8] focus:ring-4 focus:ring-[#0074c8]/10"
                      />
                      <p className="mt-1 text-[9px] font-bold text-[#16456b]/60">
                        Sem quebras de linha: a Meta recusa modelo com parágrafos. {resposta.length}/700
                      </p>

                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={enviandoModelo || reabrindo || !resposta.trim()}
                          onClick={() => void responderPorModelo()}
                          className="inline-flex items-center gap-1.5 rounded-xl bg-[#005b9e] px-4 py-2 text-[10px] font-extrabold text-white transition hover:bg-[#004b83] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Send className="h-3.5 w-3.5" />
                          {enviandoModelo ? 'Enviando...' : 'Enviar mensagem agora'}
                        </button>
                        {/* Caminho 2: o convite de sempre, para quando o assunto
                            for longo demais para caber num modelo. */}
                        <button
                          type="button"
                          disabled={reabrindo || enviandoModelo}
                          onClick={() => void reabrirConversa()}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-[#16456b]/30 bg-white px-4 py-2 text-[10px] font-extrabold text-[#16456b] transition hover:bg-[#e7f0fa] disabled:cursor-wait disabled:opacity-50"
                        >
                          <MessageSquareText className="h-3.5 w-3.5" />
                          {reabrindo ? 'Enviando...' : 'Só convidar a responder'}
                        </button>
                      </div>
                      {avisoRetomada && (
                        <p className="mt-2 text-[10px] font-bold text-[#b42318]">{avisoRetomada}</p>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
