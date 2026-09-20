import { useCallback, useEffect, useState } from 'react'
import { useDialogos } from '@/components/dialogos-contexto'
import { Check, Clock3, RefreshCw, ShieldCheck, UserRoundCheck, X } from 'lucide-react'
import {
  approveAccessRequest,
  getCurrentMembership,
  listPendingAccessRequests,
  rejectAccessRequest,
  type AccessRequest,
  type ClinicRole,
} from '@/lib/repository'

type AssignableRole = Exclude<ClinicRole, 'owner'>

const ROLE_LABEL: Record<AssignableRole, string> = {
  clinician: 'Profissional de saúde',
  staff: 'Equipe da clínica',
  viewer: 'Somente visualização',
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export default function AccessAdmin() {
  const [requests, setRequests] = useState<AccessRequest[]>([])
  const [roles, setRoles] = useState<Record<string, AssignableRole>>({})
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState<string | null>(null)
  const { perguntar } = useDialogos()
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const membership = await getCurrentMembership()
      if (!membership || membership.role !== 'owner') {
        throw new Error('Somente o administrador da clínica pode ver os pedidos de acesso.')
      }
      const pending = await listPendingAccessRequests(membership.clinicId)
      setRequests(pending)
      setRoles((current) => {
        const next = { ...current }
        for (const request of pending) next[request.id] ??= 'staff'
        return next
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar os pedidos de acesso.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function approve(request: AccessRequest) {
    setWorkingId(request.id)
    setError('')
    try {
      await approveAccessRequest(request.id, roles[request.id] ?? 'staff')
      setRequests((current) => current.filter((item) => item.id !== request.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível aprovar este acesso.')
    } finally {
      setWorkingId(null)
    }
  }

  async function reject(request: AccessRequest) {
    const certeza = await perguntar({
      titulo: `Recusar o acesso de ${request.name}?`,
      detalhe: 'Esta pessoa continuará sem acesso aos dados da clínica. Ela pode pedir acesso de novo depois.',
      confirmar: 'Recusar',
      perigo: true,
    })
    if (!certeza) return
    setWorkingId(request.id)
    setError('')
    try {
      await rejectAccessRequest(request.id)
      setRequests((current) => current.filter((item) => item.id !== request.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível recusar este acesso.')
    } finally {
      setWorkingId(null)
    }
  }

  return (
    <section className="space-y-5">
      <div className="grid gap-4 rounded-[26px] border border-[#081b2c]/[0.07] bg-white/80 p-5 shadow-sm sm:grid-cols-[auto_1fr_auto] sm:items-center sm:p-6">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#dceaf7] text-[#1f4f78]">
          <ShieldCheck className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-base font-extrabold tracking-[-0.02em] text-[#081b2c]">Aprovação obrigatória</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Um cadastro novo não enxerga nenhum paciente até você escolher o perfil e aprovar o pedido.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-[#081b2c]/10 bg-white px-4 py-3 text-xs font-extrabold text-[#385a70] transition hover:border-[#1f4f78]/40 hover:text-[#1f4f78] disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-xs font-semibold text-red-600">
          {error}
        </div>
      )}

      {loading ? (
        <div className="surface-card rounded-[26px] p-8 text-center text-xs font-semibold text-slate-400">Carregando pedidos…</div>
      ) : requests.length === 0 ? (
        <div className="surface-card rounded-[26px] p-9 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#edf7f3] text-[#4d8d7c]">
            <UserRoundCheck className="h-5 w-5" />
          </span>
          <h2 className="mt-4 text-base font-extrabold text-[#081b2c]">Nenhum pedido pendente</h2>
          <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-slate-500">Quando alguém usar “Solicitar uma conta” na tela de entrada, o pedido aparece aqui.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {requests.map((request) => {
            const role = roles[request.id] ?? 'staff'
            const working = workingId === request.id
            return (
              <article key={request.id} className="surface-card rounded-[26px] p-5 sm:p-6">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#edf7f3] text-[#4d8d7c]">
                        <Clock3 className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-extrabold text-[#081b2c]">{request.name}</h3>
                        <p className="truncate text-xs text-slate-500">{request.email}</p>
                      </div>
                    </div>
                    <p className="mt-3 text-[11px] font-semibold text-slate-400">Solicitado em {formatDate(request.requestedAt)}</p>
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <select
                      value={role}
                      disabled={working}
                      onChange={(event) => setRoles((current) => ({ ...current, [request.id]: event.target.value as AssignableRole }))}
                      className="min-w-[210px] rounded-2xl border border-[#081b2c]/10 bg-[#fafaf8] px-4 py-3 text-xs font-bold text-[#385a70] outline-none focus:border-[#2f7fc1]"
                    >
                      {(Object.keys(ROLE_LABEL) as AssignableRole[]).map((value) => (
                        <option key={value} value={value}>{ROLE_LABEL[value]}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => void approve(request)}
                      className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#0e3d42] px-4 py-3 text-xs font-extrabold text-white transition hover:bg-[#14545a] disabled:opacity-60"
                    >
                      <Check className="h-4 w-4" /> Aprovar
                    </button>
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => void reject(request)}
                      className="inline-flex items-center justify-center gap-2 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-xs font-extrabold text-red-600 transition hover:bg-red-100 disabled:opacity-60"
                    >
                      <X className="h-4 w-4" /> Recusar
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

