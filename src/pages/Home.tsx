import { useCallback, useEffect, useState, type ComponentType } from 'react'
import {
  Bell,
  CalendarDays,
  ChartNoAxesCombined,
  ChevronRight,
  CircleUserRound,
  HeartHandshake,
  LogOut,
  MessageCircleHeart,
  MessagesSquare,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from 'lucide-react'
import { useDb } from '@/lib/store'
import {
  getCurrentMembership,
  listPendingRequests,
  PENDING_ACCESS_MESSAGE,
  type PendingRequest,
} from '@/lib/repository'
import { dueCount } from '@/lib/followup'
import Dashboard from '@/sections/Dashboard'
import Patients from '@/sections/Patients'
import Followups from '@/sections/Followups'
import Conversations from '@/sections/Conversations'
import Agenda from '@/sections/Agenda'
import Settings from '@/sections/Settings'
import AccessAdmin from '@/sections/AccessAdmin'
import { Brand } from '@/components/Brand'
import { useAuth } from '@/auth/AuthProvider'
import { parametrosDoEndereco } from '@/lib/endereco'

type Tab = 'dashboard' | 'agenda' | 'followups' | 'conversas' | 'pacientes' | 'config' | 'admin'
type Icon = ComponentType<{ className?: string; strokeWidth?: number }>

const TABS: { key: Tab; label: string; shortLabel: string; icon: Icon }[] = [
  { key: 'dashboard', label: 'Visão geral', shortLabel: 'Visão', icon: ChartNoAxesCombined },
  { key: 'agenda', label: 'Agenda', shortLabel: 'Agenda', icon: CalendarDays },
  { key: 'followups', label: 'Acompanhamentos', shortLabel: 'Follow-ups', icon: MessageCircleHeart },
  { key: 'conversas', label: 'Respostas', shortLabel: 'Respostas', icon: MessagesSquare },
  { key: 'pacientes', label: 'Pacientes', shortLabel: 'Pacientes', icon: UsersRound },
  { key: 'config', label: 'Preferências', shortLabel: 'Ajustes', icon: Settings2 },
  { key: 'admin', label: 'Acessos da equipe', shortLabel: 'Acessos', icon: ShieldCheck },
]

const PAGE_META: Record<Tab, { eyebrow: string; title: string; subtitle: string }> = {
  dashboard: {
    eyebrow: 'Inteligência clínica',
    title: 'Visão geral',
    subtitle: 'Os números que ajudam a cuidar melhor, em um só lugar.',
  },
  followups: {
    eyebrow: 'Cuidado contínuo',
    title: 'Acompanhamentos',
    subtitle: 'Cada paciente no momento certo da sua jornada.',
  },
  agenda: {
    eyebrow: 'Tempo do cuidado',
    title: 'Agenda',
    subtitle: 'Horários de atendimento, bloqueios e consultas marcadas.',
  },
  conversas: {
    eyebrow: 'Escuta ativa',
    title: 'Respostas',
    subtitle: 'O que os pacientes responderam pelo WhatsApp, em um só lugar.',
  },
  pacientes: {
    eyebrow: 'Base clínica',
    title: 'Pacientes',
    subtitle: 'Cadastro, contexto e histórico de acompanhamento.',
  },
  config: {
    eyebrow: 'Personalização',
    title: 'Preferências',
    subtitle: 'Mensagens, segurança dos dados e rotina da equipe.',
  },
  admin: {
    eyebrow: 'Administração segura',
    title: 'Acessos da equipe',
    subtitle: 'Aprove novos cadastros antes de liberar os dados da clínica.',
  },
}

function formatToday() {
  const value = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
  }).format(new Date())
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export default function Home() {
  const { user, signOut } = useAuth()
  const {
    db,
    role,
    loading,
    loadError,
    retry,
    addPatient,
    updatePatient,
    removePatient,
    listArchived,
    restorePatient,
    getConsultations,
    addConsultation,
    updateConsultation,
    setFollowup,
    setTemplates,
    importDb,
    clearAll,
  } = useDb()
  /**
   * Aba inicial.
   *
   * Volta da assinatura digital abre direto em Pacientes. O VIDaaS devolve o
   * navegador com o numero do pedido no endereco, e quem le esse numero e o
   * prontuario - que so existe na tela quando a aba de Pacientes esta aberta.
   * Sem isto o medico autorizava no celular, voltava para a tela inicial, e a
   * assinatura ficava pela metade em silencio: autorizada e nunca concluida.
   */
  const [tab, setTab] = useState<Tab>(() => {
    const endereco = parametrosDoEndereco()
    return endereco.get('state') || endereco.get('paciente') ? 'pacientes' : 'followups'
  })
  // Paciente cuja conversa deve abrir ao entrar em Respostas pelo atalho.
  const [conversaFoco, setConversaFoco] = useState<string | null>(null)
  const [newPatientSignal, setNewPatientSignal] = useState(0)
  const [preCadastro, setPreCadastro] = useState<
    {
      nome: string
      telefone: string
      dataConsulta?: string
      unidade?: string
      nascimento?: string
      responsavel?: string
      cpf?: string
      email?: string
      voltarPara?: Tab
    } | null
  >(null)
  const pendentes = dueCount(db.patients)
  const [solicitacoes, setSolicitacoes] = useState<PendingRequest[]>([])

  // Solicitacoes do WhatsApp esperando a equipe. Ficam aqui, e nao dentro da
  // Agenda, porque o aviso precisa aparecer para quem abre o sistema em
  // qualquer tela - a vaga so fica reservada por 24h.
  const carregarSolicitacoes = useCallback(async () => {
    try {
      const membership = await getCurrentMembership()
      if (!membership) return
      setSolicitacoes(await listPendingRequests(membership.clinicId))
    } catch (cause) {
      console.error('Nao consegui carregar as solicitacoes pendentes', cause)
    }
  }, [])

  useEffect(() => {
    // A carga fica dentro de uma funcao assincrona de proposito: o estado so e
    // tocado depois do await, e nao durante o corpo do efeito.
    void (async () => {
      await carregarSolicitacoes()
    })()
  }, [carregarSolicitacoes])

  // Uma vaga confirmada em outra aba, ou uma solicitacao que venceu, some
  // sozinha na proxima passada.
  useEffect(() => {
    const timer = window.setInterval(() => void carregarSolicitacoes(), 60_000)
    return () => window.clearInterval(timer)
  }, [carregarSolicitacoes])
  const meta = PAGE_META[tab]
  const tabs = role === 'owner' ? TABS : TABS.filter((item) => item.key !== 'admin')

  function createPatient() {
    setPreCadastro(null)
    setTab('pacientes')
    setNewPatientSignal((value) => value + 1)
  }

  /**
   * Cadastro que comeca de uma conversa ou de uma consulta. Leva nome e
   * telefone prontos para a tela de pacientes - a equipe so confere e completa.
   *
   * `voltarPara` diz de onde a pessoa veio: quem cadastra a partir da agenda
   * quer seguir organizando a agenda, e nao cair no prontuario.
   */
  function cadastrarContato(
    dados: {
      nome: string
      telefone: string
      dataConsulta?: string
      unidade?: string
      nascimento?: string
      responsavel?: string
      cpf?: string
      email?: string
    },
    voltarPara?: Tab,
  ) {
    setPreCadastro({ ...dados, voltarPara })
    setTab('pacientes')
    setNewPatientSignal((value) => value + 1)
  }

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#f7f5f1] text-[#081b2c]">
        <div className="text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-[20px] bg-[#081b2c] text-[#6fadde] shadow-[0_18px_45px_rgba(8,27,44,.18)]">
            <HeartHandshake className="h-6 w-6 animate-pulse" />
          </span>
          <p className="mt-4 text-xs font-extrabold uppercase tracking-[0.16em] text-slate-400">
            Carregando dados da clínica
          </p>
        </div>
      </main>
    )
  }

  // So a falha da carga inicial troca o sistema inteiro por esta tela. Erro de
  // uma acao (um envio que nao saiu, por exemplo) vira aviso, sem derrubar o
  // que a pessoa estava fazendo.
  if (loadError) {
    const pendingApproval = loadError === PENDING_ACCESS_MESSAGE
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#f7f5f1] px-4 text-[#081b2c]">
        <section className="surface-card w-full max-w-md rounded-[28px] p-7 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 text-red-500">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <h1 className="mt-4 text-lg font-extrabold">
            {pendingApproval ? 'Aguardando aprovação' : 'Não foi possível carregar os dados'}
          </h1>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {pendingApproval
              ? 'Seu pedido foi registrado. Assim que o administrador aprovar, entre novamente para acessar a Central de Cuidado.'
              : loadError}
          </p>
          <button
            type="button"
            onClick={() => (pendingApproval ? void signOut() : void retry())}
            className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-[#081b2c] px-5 py-3 text-xs font-extrabold text-white"
          >
            {pendingApproval ? <LogOut className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
            {pendingApproval ? 'Voltar para entrar' : 'Tentar novamente'}
          </button>
        </section>
      </main>
    )
  }

  return (
    <div className="min-h-dvh bg-[#f7f5f1] text-[#081b2c]">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[286px] flex-col overflow-hidden bg-[#081b2c] text-white lg:flex">
        <div className="soft-grid absolute inset-0 opacity-40" />
        <div className="absolute -right-24 top-24 h-64 w-64 rounded-full bg-[#2f7fc1]/10 blur-3xl" />
        <div className="relative flex h-full flex-col">
          <div className="px-7 pb-7 pt-8 [@media(max-height:820px)]:pb-4 [@media(max-height:820px)]:pt-5">
            <Brand light />
            <div className="mt-5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.22em] text-white/45 [@media(max-height:820px)]:mt-3">
              <HeartHandshake className="h-3.5 w-3.5 text-[#6aa8d9]" />
              Central de cuidado
            </div>
            {/* Versao publicada, logo abaixo do nome: e o que responde, sem
                adivinhacao, se a tela aberta ja e a de depois da ultima
                publicacao. Ficava no rodape, mas em tela menor o rodape nao
                aparece, e a pergunta "qual versao?" e feita justamente quando
                algo esta estranho. O "typeof" evita que a etiqueta derrube a
                pagina se um dia o build sair sem as variaveis - ja aconteceu. */}
            <p className="mt-2 text-[10px] font-semibold tracking-[0.08em] text-white/35">
              Versão {typeof __COMMIT__ === 'string' ? __COMMIT__ : '?'} ·{' '}
              {typeof __VERSAO__ === 'string' ? __VERSAO__ : '?'}
            </p>
          </div>

          <div className="mx-7 h-px bg-white/10" />

          <nav
            /* Em tela baixa o menu passava por baixo do cartao "Dados
               protegidos" e os ultimos itens ficavam inalcancaveis: nao havia
               rolagem, porque o aside inteiro era overflow-hidden. Agora a
               lista rola sozinha e os itens encolhem antes disso. */
            className="scrollbar-subtle mt-6 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 [@media(max-height:820px)]:mt-3 [@media(max-height:820px)]:space-y-0.5"
            aria-label="Navegação principal"
          >
            <p className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">Menu</p>
            {tabs.map((item) => {
              const active = tab === item.key
              const Icon = item.icon
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTab(item.key)}
                  aria-current={active ? 'page' : undefined}
                  className={`group flex w-full items-center gap-3 rounded-2xl px-3.5 py-3.5 text-sm font-semibold transition-all [@media(max-height:820px)]:py-2.5 ${
                    active
                      ? 'bg-white text-[#081b2c] shadow-[0_12px_28px_rgba(0,0,0,.18)]'
                      : 'text-white/55 hover:bg-white/[0.06] hover:text-white'
                  }`}
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors [@media(max-height:820px)]:h-8 [@media(max-height:820px)]:w-8 ${
                      active ? 'bg-[#d9e8f7] text-[#1f4f78]' : 'bg-white/[0.055] text-white/60 group-hover:text-white'
                    }`}
                  >
                    <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
                  </span>
                  <span className="flex-1 text-left">{item.label}</span>
                  {/* A Agenda usa vermelho porque a solicitacao tem prazo: a
                      vaga fica reservada 24h e depois volta para a fila. */}
                  {item.key === 'agenda' && solicitacoes.length > 0 ? (
                    <span className={`min-w-6 rounded-full px-1.5 py-1 text-center text-[10px] font-extrabold ${
                      active ? 'bg-[#081b2c] text-white' : 'bg-red-500 text-white'
                    }`}>
                      {solicitacoes.length}
                    </span>
                  ) : item.key === 'followups' && pendentes > 0 ? (
                    <span className={`min-w-6 rounded-full px-1.5 py-1 text-center text-[10px] font-extrabold ${
                      active ? 'bg-[#081b2c] text-white' : 'bg-[#3585c6] text-white'
                    }`}>
                      {pendentes}
                    </span>
                  ) : active ? (
                    <ChevronRight className="h-4 w-4 text-[#2f7fc1]" />
                  ) : null}
                </button>
              )
            })}
          </nav>

          <div className="relative mx-4 mb-4 overflow-hidden rounded-[22px] border border-white/10 bg-white/[0.055] p-4 [@media(max-height:900px)]:hidden">
            <div className="absolute -right-5 -top-5 h-20 w-20 rounded-full bg-[#2f7fc1]/15 blur-2xl" />
            <div className="relative flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#2f7fc1] text-white">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <div>
                <p className="text-xs font-bold text-white/90">Dados protegidos</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-white/40">Sincronizados com acesso protegido</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 border-t border-white/10 px-6 py-5">
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.07]">
              <CircleUserRound className="h-5 w-5 text-white/60" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-bold text-white/90">Dr. Rafael Clauzo</p>
              <p className="mt-0.5 truncate text-[10px] text-white/40">{user?.email ?? 'Equipe clínica'}</p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              aria-label="Sair do sistema"
              title="Sair do sistema"
              className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-white/45 transition hover:bg-white/[0.1] hover:text-white"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#081b2c]/95 px-4 py-3 text-white backdrop-blur-xl lg:hidden">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <Brand light />
          <button
            type="button"
            onClick={() => setTab('followups')}
            aria-label={`${pendentes} acompanhamentos pendentes`}
            className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.07]"
          >
            <Bell className="h-[18px] w-[18px] text-white/75" />
            {pendentes > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#4a94cf] px-1 text-[9px] font-extrabold text-white ring-2 ring-[#081b2c]">
                {pendentes}
              </span>
            )}
          </button>
        </div>
      </header>

      <main className="relative min-h-dvh pb-28 lg:ml-[286px] lg:pb-12">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-80 overflow-hidden">
          <div className="absolute -right-20 -top-32 h-96 w-96 rounded-full bg-[#86bce4]/10 blur-3xl" />
          <div className="absolute left-1/3 -top-48 h-80 w-80 rounded-full bg-[#9fc2b8]/10 blur-3xl" />
        </div>

        <div className="relative mx-auto max-w-[1460px] px-4 py-6 sm:px-7 lg:px-10 lg:py-9 xl:px-12">
          <div className="mb-7 flex flex-col gap-5 xl:mb-8 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.2em] text-[#1f4f78]">
                <Sparkles className="h-3.5 w-3.5" />
                {meta.eyebrow}
              </div>
              <h1 className="text-2xl font-extrabold tracking-[-0.035em] text-[#081b2c] sm:text-3xl lg:text-[34px]">
                {meta.title}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">{meta.subtitle}</p>
            </div>

            <div className="flex items-center gap-3">
              <div className="hidden items-center gap-2.5 rounded-2xl border border-[#081b2c]/[0.07] bg-white/70 px-4 py-3 text-xs font-semibold text-slate-500 shadow-sm backdrop-blur sm:flex">
                <CalendarDays className="h-4 w-4 text-[#2f7fc1]" />
                {formatToday()}
              </div>
              <button
                type="button"
                onClick={createPatient}
                className="group flex flex-1 items-center justify-center gap-2 rounded-2xl bg-[#081b2c] px-5 py-3 text-xs font-bold text-white shadow-[0_12px_26px_rgba(8,27,44,.18)] transition hover:-translate-y-0.5 hover:bg-[#102d47] sm:flex-none"
              >
                <Plus className="h-4 w-4 text-[#6fadde] transition-transform group-hover:rotate-90" />
                Novo paciente
              </button>
            </div>
          </div>

          <div key={tab} className="animate-enter">
            {tab === 'dashboard' && (
              <Dashboard
                patients={db.patients}
                solicitacoes={solicitacoes}
                onAbrirAgenda={() => setTab('agenda')}
              />
            )}
            {tab === 'followups' && (
              <Followups
                patients={db.patients}
                templates={db.templates}
                setFollowup={setFollowup}
                onAbrirConversa={(patientId) => {
                  setConversaFoco(patientId)
                  setTab('conversas')
                }}
              />
            )}
            {tab === 'agenda' && (
              <Agenda
                patients={db.patients}
                onSolicitacoesMudaram={carregarSolicitacoes}
                onCadastrarContato={(dados) => cadastrarContato(dados, 'agenda')}
              />
            )}
            {tab === 'conversas' && (
              <Conversations focoPatientId={conversaFoco} onCadastrarContato={cadastrarContato} />
            )}
            {tab === 'pacientes' && (
              <Patients
                patients={db.patients}
                addPatient={addPatient}
                updatePatient={updatePatient}
                removePatient={removePatient}
            listArchived={listArchived}
            restorePatient={restorePatient}
                listConsultations={getConsultations}
                addConsultation={addConsultation}
                updateConsultation={updateConsultation}
                openCreateSignal={newPatientSignal}
                preCadastro={preCadastro}
                onPacienteCriado={() => {
                  const destino = preCadastro?.voltarPara
                  setPreCadastro(null)
                  if (destino) {
                    setTab(destino)
                    void carregarSolicitacoes()
                  }
                }}
              />
            )}
            {tab === 'config' && (
              <Settings db={db} setTemplates={setTemplates} importDb={importDb} clearAll={clearAll} />
            )}
            {tab === 'admin' && role === 'owner' && <AccessAdmin />}
          </div>
        </div>
      </main>

      <nav
        className="fixed inset-x-3 bottom-3 z-40 flex rounded-[22px] border border-[#081b2c]/10 bg-white/95 px-1.5 py-1.5 shadow-[0_18px_55px_rgba(8,27,44,.2)] backdrop-blur-xl lg:hidden"
        style={{ paddingBottom: 'max(.375rem, env(safe-area-inset-bottom))' }}
        aria-label="Navegação móvel"
      >
        {tabs.map((item) => {
          const active = tab === item.key
          const Icon = item.icon
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex flex-1 flex-col items-center gap-1 rounded-[17px] px-1 py-2.5 text-[9px] font-bold transition-colors ${
                active ? 'bg-[#081b2c] text-white' : 'text-slate-400'
              }`}
            >
              <Icon className={`h-[18px] w-[18px] ${active ? 'text-[#6fadde]' : ''}`} strokeWidth={2} />
              <span>{item.shortLabel}</span>
              {item.key === 'followups' && pendentes > 0 && !active && (
                <span className="absolute right-[25%] top-1.5 h-2 w-2 rounded-full bg-[#2f7fc1] ring-2 ring-white" />
              )}
            </button>
          )
        })}
      </nav>
    </div>
  )
}

