import { useEffect, useRef, useState } from 'react'
import { useDialogos } from '@/components/dialogos-contexto'
import {
  Check,
  DatabaseBackup,
  Download,
  FileJson,
  ImageUp,
  Info,
  MessageCircleHeart,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react'
import type { Db, FollowupKey } from '@/types/patient'
import { DEFAULT_TEMPLATES } from '@/lib/store'
import {
  atualizarDadosDoPerfil,
  atualizarFotoDoPerfil,
  getCurrentMembership,
  getPerfilDoWhatsApp,
  savePerfilDoWhatsApp,
  situacaoDoWhatsApp,
  type PerfilDoWhatsApp,
  type SituacaoDoNumero,
} from '@/lib/repository'
import DadosDaClinica from '@/sections/DadosDaClinica'
import RespostasProntas from '@/sections/RespostasProntas'
import InformacoesDoWhatsApp from '@/sections/InformacoesDoWhatsApp'

const inputClass =
  'mt-3 min-h-[138px] w-full resize-y rounded-[18px] border border-[#081b2c]/10 bg-[#fafaf8] p-4 text-xs font-medium leading-relaxed text-[#203546] outline-none transition placeholder:text-slate-300 focus:border-[#2f7fc1] focus:bg-white focus:ring-4 focus:ring-[#2f7fc1]/10'

interface Props {
  db: Db
  setTemplates: (templates: Record<FollowupKey, string>) => Promise<void>
  importDb: (data: unknown) => Promise<boolean>
  clearAll: () => Promise<void>
}

export default function Settings({ db, setTemplates, importDb, clearAll }: Props) {
  const [situacao, setSituacao] = useState<SituacaoDoNumero | null>(null)
  const [erroSituacao, setErroSituacao] = useState('')
  const { avisar, perguntar } = useDialogos()

  // Consulta na abertura das configuracoes. E leitura pura na Meta, entao nao
  // custa nada e evita ter que lembrar de apertar um botao para saber.
  useEffect(() => {
    void (async () => {
      try {
        setSituacao(await situacaoDoWhatsApp())
      } catch (causa) {
        setErroSituacao(causa instanceof Error ? causa.message : 'Falha ao consultar.')
      }
    })()
  }, [])

  const [trocandoFoto, setTrocandoFoto] = useState(false)
  const [avisoFoto, setAvisoFoto] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null)

  const [gravandoDados, setGravandoDados] = useState(false)

  // Os textos do perfil, escritos pela clínica. Salvar aqui grava no banco; só
  // o botão de cima é que envia para a Meta.
  const [perfil, setPerfil] = useState<PerfilDoWhatsApp>({
    recado: '',
    endereco: '',
    descricao: '',
    email: '',
    site: '',
  })
  const [clinicId, setClinicId] = useState<string | null>(null)
  const [salvandoPerfil, setSalvandoPerfil] = useState(false)
  const [perfilSalvo, setPerfilSalvo] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const membership = await getCurrentMembership()
        if (!membership) return
        setClinicId(membership.clinicId)
        setPerfil(await getPerfilDoWhatsApp(membership.clinicId))
      } catch {
        // Silêncio: sem os textos a tela ainda serve para foto e situação do nome.
      }
    })()
  }, [])

  async function salvarPerfil() {
    if (!clinicId) return
    setSalvandoPerfil(true)
    setAvisoFoto(null)
    try {
      await savePerfilDoWhatsApp(clinicId, perfil)
      setPerfilSalvo(true)
      window.setTimeout(() => setPerfilSalvo(false), 2500)
    } catch (causa) {
      setAvisoFoto({
        tipo: 'erro',
        texto: causa instanceof Error ? causa.message : 'Não foi possível salvar os textos.',
      })
    } finally {
      setSalvandoPerfil(false)
    }
  }

  async function gravarDados() {
    setAvisoFoto(null)
    setGravandoDados(true)
    try {
      await atualizarDadosDoPerfil()
      setAvisoFoto({
        tipo: 'ok',
        texto:
          'Perfil atualizado: site, endereço, descrição e e-mail. Aparece ao tocar no nome da conversa.',
      })
    } catch (causa) {
      setAvisoFoto({
        tipo: 'erro',
        texto: causa instanceof Error ? causa.message : 'Não foi possível gravar o perfil.',
      })
    } finally {
      setGravandoDados(false)
    }
  }

  async function trocarFoto() {
    setAvisoFoto(null)
    setTrocandoFoto(true)
    try {
      await atualizarFotoDoPerfil()
      setAvisoFoto({
        tipo: 'ok',
        texto: 'Foto atualizada. Pode levar alguns minutos para aparecer no celular dos pacientes.',
      })
    } catch (causa) {
      setAvisoFoto({
        tipo: 'erro',
        texto: causa instanceof Error ? causa.message : 'Não foi possível trocar a foto.',
      })
    } finally {
      setTrocandoFoto(false)
    }
  }

  const [d15, setD15] = useState(db.templates.d15)
  const [d30, setD30] = useState(db.templates.d30)
  const [m90, setM90] = useState(db.templates.m90)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importMessage, setImportMessage] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setD15(db.templates.d15)
    setD30(db.templates.d30)
    setM90(db.templates.m90)
  }, [db.templates.d15, db.templates.d30, db.templates.m90])

  async function save() {
    setSaving(true)
    setImportMessage('')
    try {
      await setTemplates({ d15, d30, m90 })
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2500)
    } catch (cause) {
      setImportMessage(cause instanceof Error ? cause.message : 'Não foi possível salvar as mensagens.')
    } finally {
      setSaving(false)
    }
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `acompanhamento-pacientes-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  function importData(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const imported = await importDb(JSON.parse(String(reader.result)))
        setImportMessage(imported ? 'Backup importado com sucesso.' : 'O arquivo não tem o formato esperado.')
      } catch {
        setImportMessage('Não foi possível ler este arquivo JSON.')
      }
    }
    reader.readAsText(file)
  }

  function restoreDefaults() {
    setD15(DEFAULT_TEMPLATES.d15)
    setD30(DEFAULT_TEMPLATES.d30)
    setM90(DEFAULT_TEMPLATES.m90)
    setSaved(false)
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_350px]">
      <div className="space-y-5">
      <DadosDaClinica />
      <InformacoesDoWhatsApp />
      <RespostasProntas />
      <section className="surface-card overflow-hidden rounded-[26px]">
        <div className="border-b border-[#081b2c]/[0.06] bg-gradient-to-r from-white to-[#f0f6fc] p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-[#dceaf7] text-[#1f4f78]">
              <MessageCircleHeart className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[9px] font-extrabold uppercase tracking-[0.15em] text-[#1f4f78]">Tom de voz</p>
              <h2 className="mt-1 text-base font-extrabold tracking-[-0.03em] text-[#081b2c]">Mensagens de acompanhamento</h2>
              <p className="mt-1.5 max-w-2xl text-[11px] leading-relaxed text-slate-400">
                Personalize o contato que será preparado para o paciente em cada etapa da jornada.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-5 p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2 rounded-[16px] border border-[#081b2c]/[0.06] bg-[#f8f7f4] px-4 py-3">
            <Info className="h-4 w-4 text-[#6f9d91]" />
            <span className="text-[10px] font-bold text-slate-500">Variáveis disponíveis:</span>
            <code className="rounded-lg bg-white px-2 py-1 text-[9px] font-extrabold text-[#1f4f78] shadow-sm">{'{nome}'}</code>
            <span className="text-[9px] text-slate-400">primeiro nome</span>
            <code className="rounded-lg bg-white px-2 py-1 text-[9px] font-extrabold text-[#1f4f78] shadow-sm">{'{pronome}'}</code>
            <span className="text-[9px] text-slate-400">ele ou ela</span>
          </div>

          <label className="block rounded-[22px] border border-[#081b2c]/[0.07] bg-white p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-8 min-w-8 items-center justify-center rounded-xl bg-[#e1eef8] text-[10px] font-extrabold text-[#2f7fc1]">15</span>
              <div>
                <p className="text-xs font-extrabold text-[#081b2c]">Mensagem de 15 dias</p>
                <p className="mt-0.5 text-[9px] text-slate-400">Adaptação às orientações da consulta</p>
              </div>
            </div>
            <textarea className={inputClass} value={d15} onChange={(event) => setD15(event.target.value)} />
            <p className="mt-2 text-right text-[9px] font-semibold text-slate-300">{d15.length} caracteres</p>
          </label>

          <label className="block rounded-[22px] border border-[#081b2c]/[0.07] bg-white p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-8 min-w-8 items-center justify-center rounded-xl bg-[#eaf3f0] text-[10px] font-extrabold text-[#557f75]">30</span>
              <div>
                <p className="text-xs font-extrabold text-[#081b2c]">Mensagem de 30 dias</p>
                <p className="mt-0.5 text-[9px] text-slate-400">Primeira checagem após a consulta</p>
              </div>
            </div>
            <textarea className={inputClass} value={d30} onChange={(event) => setD30(event.target.value)} />
            <p className="mt-2 text-right text-[9px] font-semibold text-slate-300">{d30.length} caracteres</p>
          </label>

          <label className="block rounded-[22px] border border-[#081b2c]/[0.07] bg-white p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-8 min-w-8 items-center justify-center rounded-xl bg-[#e5eef7] text-[10px] font-extrabold text-[#1f4f78]">90</span>
              <div>
                <p className="text-xs font-extrabold text-[#081b2c]">Mensagem de 3 meses</p>
                <p className="mt-0.5 text-[9px] text-slate-400">Continuidade do cuidado e disponibilidade</p>
              </div>
            </div>
            <textarea className={inputClass} value={m90} onChange={(event) => setM90(event.target.value)} />
            <p className="mt-2 text-right text-[9px] font-semibold text-slate-300">{m90.length} caracteres</p>
          </label>

          <div className="flex flex-col-reverse gap-2 border-t border-[#081b2c]/[0.06] pt-5 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={restoreDefaults}
              className="inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-[10px] font-extrabold text-slate-400 transition hover:bg-slate-50 hover:text-slate-600"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Restaurar mensagens originais
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className={`inline-flex items-center justify-center gap-2 rounded-[14px] px-5 py-3 text-xs font-extrabold text-white shadow-[0_10px_22px_rgba(8,27,44,.15)] transition ${
                saved ? 'bg-[#6f9d91]' : 'bg-[#081b2c] hover:bg-[#102d47]'
              }`}
            >
              {saved ? <Check className="h-4 w-4" strokeWidth={3} /> : <Save className="h-4 w-4 text-[#6aa8d9]" />}
              {saving ? 'Salvando...' : saved ? 'Mensagens salvas' : 'Salvar mensagens'}
            </button>
          </div>
        </div>
      </section>
      </div>

      <aside className="space-y-4">
        <section className="soft-grid relative overflow-hidden rounded-[26px] bg-[#081b2c] p-5 text-white shadow-[0_18px_40px_rgba(8,27,44,.14)]">
          <div className="absolute -right-10 -top-10 h-32 w-32 rounded-full bg-[#2f7fc1]/20 blur-3xl" />
          <div className="relative">
            <div className="flex items-center justify-between">
              <span className="flex h-10 w-10 items-center justify-center rounded-[14px] border border-white/10 bg-white/[0.07]">
                <DatabaseBackup className="h-5 w-5 text-[#6fadde]" />
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-[8px] font-extrabold uppercase tracking-[0.12em] text-white/45">
                {db.patients.length} pacientes
              </span>
            </div>
            <h2 className="mt-5 text-base font-extrabold tracking-[-0.03em]">Cópia dos cadastros</h2>
            <p className="mt-2 text-[11px] leading-relaxed text-white/45">
              Exporta pacientes e preferências. As evoluções do prontuário permanecem protegidas no banco da clínica e não entram neste arquivo JSON.
            </p>

            <button
              type="button"
              onClick={exportData}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-[14px] bg-[#5b9fd5] px-4 py-3 text-xs font-extrabold text-[#081b2c] transition hover:bg-[#7ab6e6]"
            >
              <Download className="h-4 w-4" />
              Exportar cadastros
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-[14px] border border-white/12 bg-white/[0.06] px-4 py-3 text-xs font-extrabold text-white/75 transition hover:bg-white/[0.1] hover:text-white"
            >
              <Upload className="h-4 w-4" />
              Importar arquivo
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                importData(event.target.files?.[0])
                event.target.value = ''
              }}
            />

            {importMessage && (
              <p className={`mt-3 rounded-xl px-3 py-2.5 text-[10px] font-bold ${
                importMessage.includes('sucesso') ? 'bg-[#6f9d91]/20 text-[#b9ded5]' : 'bg-red-400/15 text-red-200'
              }`}>
                {importMessage}
              </p>
            )}
          </div>
        </section>

        <section className="surface-card rounded-[24px] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#eaf3f0] text-[#557f75]">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-xs font-extrabold text-[#081b2c]">Banco seguro na nuvem</h2>
              <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
                Os registros ficam no projeto Supabase da clínica e só podem ser acessados por usuários autorizados.
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-xl bg-[#f8f7f4] px-3 py-2.5">
            <FileJson className="h-3.5 w-3.5 text-[#2f7fc1]" />
            <span className="text-[9px] font-bold text-slate-400">Formato do backup: arquivo JSON</span>
          </div>
        </section>

        {/* A foto do perfil do WhatsApp nem sempre e editavel pelo Gerenciador
            da Meta - foi o caso aqui. Pela API funciona, e a imagem vem do
            proprio site: trocar a foto amanha e trocar o arquivo la e apertar
            este botao. */}
        <section className="surface-card rounded-[24px] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#eaf0f8] text-[#4d6f91]">
              <ImageUp className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-xs font-extrabold text-[#081b2c]">Perfil no WhatsApp</h2>
              <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
                Usa a imagem publicada em WHATSAPP_PROFILE_IMAGE_URL nas configurações da integração. É ela
                que os pacientes veem ao receber as mensagens da clínica.
              </p>
            </div>
          </div>
          {/* O estado do nome vem da propria Meta. Antes disto so dava para
              olhar o Gerenciador e adivinhar o que cada rotulo queria dizer. */}
          {situacao && (
            <dl className="mt-4 space-y-1.5 rounded-xl bg-[#f8f7f4] px-3 py-2.5 text-[10px]">
              <div className="flex justify-between gap-3">
                <dt className="font-bold text-slate-400">Nome em uso</dt>
                <dd className="text-right font-extrabold text-[#081b2c]">{situacao.nomeAtual ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="font-bold text-slate-400">Situação desse nome</dt>
                <dd className="text-right font-bold text-slate-600">{situacao.situacaoDoNomeAtual}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="font-bold text-slate-400">Pedido em andamento</dt>
                <dd className="text-right font-bold text-slate-600">{situacao.situacaoDoPedido}</dd>
              </div>
            </dl>
          )}
          {erroSituacao && (
            <p className="mt-3 text-[10px] font-bold leading-relaxed text-red-500">{erroSituacao}</p>
          )}

          <button
            type="button"
            onClick={() => void trocarFoto()}
            disabled={trocandoFoto}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[#081b2c] px-4 py-2.5 text-[10px] font-extrabold text-white transition hover:bg-[#102d47] disabled:cursor-wait disabled:opacity-70"
          >
            {trocandoFoto ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ImageUp className="h-3.5 w-3.5" />}
            {trocandoFoto ? 'Enviando para a Meta...' : 'Atualizar foto do perfil'}
          </button>
          {/* O cartao de visita da conta, escrito pela clínica.
              O endereço muda de sala, de prédio e até de unidade, então mora no
              banco e não no código. Só vai para a Meta quando você aperta o
              botão: salvar aqui não publica nada. */}
          <div className="mt-4 space-y-2.5 rounded-[16px] border border-[#081b2c]/[0.07] bg-[#fafaf8] p-3.5">
            <p className="text-[9px] font-extrabold uppercase tracking-wide text-slate-400">
              O que aparece ao tocar no nome da conversa
            </p>
            {([
              ['Recado curto', 'recado', 'Instituto Clauzo · Saúde e acompanhamento médico', 139],
              ['Endereço', 'endereco', 'Rua, número, sala, bairro, cidade', 256],
              ['Descrição', 'descricao', 'O que a clínica faz, em duas linhas', 512],
              ['E-mail', 'email', 'contato@exemplo.com.br', 128],
              ['Site', 'site', 'https://seu-dominio.com.br', 256],
            ] as const).map(([rotulo, campo, exemplo, limite]) => (
              <label key={campo} className="block">
                <span className="text-[9px] font-extrabold uppercase tracking-wide text-slate-400">
                  {rotulo}
                </span>
                <input
                  value={perfil[campo]}
                  onChange={(e) => {
                    setPerfil({ ...perfil, [campo]: e.target.value })
                    setPerfilSalvo(false)
                  }}
                  maxLength={limite}
                  placeholder={exemplo}
                  className="mt-1 w-full rounded-xl border border-[#081b2c]/10 bg-white px-3 py-2 text-[11px] font-semibold text-[#081b2c] outline-none focus:border-[#2f7fc1]"
                />
              </label>
            ))}
            <button
              type="button"
              onClick={() => void salvarPerfil()}
              disabled={salvandoPerfil}
              className="w-full rounded-xl bg-[#2f7fc1] px-4 py-2 text-[10px] font-extrabold text-white transition hover:bg-[#25649c] disabled:opacity-60"
            >
              {salvandoPerfil ? 'Salvando...' : perfilSalvo ? 'Salvo' : 'Salvar textos'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => void gravarDados()}
            disabled={gravandoDados}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-[#081b2c]/12 bg-white px-4 py-2.5 text-[10px] font-extrabold text-[#081b2c] transition hover:bg-[#f3f6f9] disabled:cursor-wait disabled:opacity-70"
          >
            {gravandoDados ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            {gravandoDados ? 'Gravando...' : 'Atualizar site e endereço do perfil'}
          </button>
          {avisoFoto && (
            <p
              className={`mt-2.5 text-[10px] font-bold leading-relaxed ${
                avisoFoto.tipo === 'ok' ? 'text-[#1c6b3a]' : 'text-red-500'
              }`}
            >
              {avisoFoto.texto}
            </p>
          )}
        </section>

        <section className="rounded-[24px] border border-red-100 bg-[#fffafa] p-5">
          <div className="flex items-center gap-2 text-red-600">
            <Trash2 className="h-4 w-4" />
            <h2 className="text-[10px] font-extrabold uppercase tracking-[0.13em]">Zona de risco</h2>
          </div>
          <p className="mt-2.5 text-[10px] leading-relaxed text-slate-400">
            Esta ação arquiva todos os pacientes da clínica em todos os dispositivos. Exporte um backup antes.
          </p>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                const certeza = await perguntar({
                  titulo: 'Arquivar TODOS os pacientes da clínica?',
                  detalhe:
                    'Vale para todos os computadores e celulares da equipe. Nada é apagado do banco, mas as listas ficam vazias. Exporte um backup antes.',
                  confirmar: 'Arquivar tudo',
                  perigo: true,
                })
                if (!certeza) return
                try {
                  await clearAll()
                  avisar('Todos os pacientes foram arquivados.')
                } catch (cause) {
                  setImportMessage(
                    cause instanceof Error ? cause.message : 'Não foi possível arquivar os pacientes.',
                  )
                }
              })()
            }}
            className="mt-4 w-full rounded-xl border border-red-200 px-3 py-2.5 text-[10px] font-extrabold text-red-500 transition hover:bg-red-50"
          >
            Apagar todos os dados
          </button>
        </section>
      </aside>
    </div>
  )
}

