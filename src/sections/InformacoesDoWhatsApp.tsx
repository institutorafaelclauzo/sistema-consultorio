import { useEffect, useState } from 'react'
import { Check, MapPinned, Save, Video } from 'lucide-react'
import { Ajuda } from '@/components/Ajuda'
import { useDialogos } from '@/components/dialogos-contexto'
import {
  getCurrentMembership,
  getTelemedicina,
  listInformacoesDasUnidades,
  saveInformacoesDaUnidade,
  saveTelemedicina,
  type InformacoesDaUnidade,
  type Telemedicina,
} from '@/lib/repository'

const campo =
  'mt-1.5 w-full resize-y rounded-[13px] border border-[#081b2c]/10 bg-[#fafaf8] px-3.5 py-2.5 text-xs font-medium leading-relaxed text-[#081b2c] outline-none transition placeholder:font-normal placeholder:text-slate-300 focus:border-[#2f7fc1] focus:bg-white focus:ring-4 focus:ring-[#2f7fc1]/10'

/**
 * O que o robô responde quando a família pede informações.
 *
 * Até 11/09/2026 era um texto só para a clínica inteira. Mas o valor de Santos
 * não é o de São Paulo, o endereço muda, e a telemedicina tem regra própria de
 * retorno. Agora o robô pergunta "para qual atendimento?" e responde o texto
 * daquele lugar. Cada um é editado aqui, no texto da clínica, sem programador.
 */
export default function InformacoesDoWhatsApp() {
  const { avisar } = useDialogos()
  const [clinicId, setClinicId] = useState<string | null>(null)
  const [unidades, setUnidades] = useState<InformacoesDaUnidade[]>([])
  const [tele, setTele] = useState<Telemedicina>({ ativa: true, texto: '' })
  const [carregando, setCarregando] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [salvo, setSalvo] = useState(false)

  useEffect(() => {
    let vivo = true
    void (async () => {
      try {
        const membership = await getCurrentMembership()
        if (!membership || !vivo) return
        setClinicId(membership.clinicId)
        const [lista, telemedicina] = await Promise.all([
          listInformacoesDasUnidades(membership.clinicId),
          getTelemedicina(membership.clinicId),
        ])
        if (!vivo) return
        setUnidades(lista)
        setTele(telemedicina)
      } catch (causa) {
        if (vivo) avisar(causa instanceof Error ? causa.message : 'Não foi possível carregar as informações.', 'erro')
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => {
      vivo = false
    }
  }, [avisar])

  function mudarUnidade(id: string, texto: string) {
    setUnidades((antes) => antes.map((u) => (u.id === id ? { ...u, texto } : u)))
    setSalvo(false)
  }

  async function salvar() {
    if (!clinicId) return
    setSalvando(true)
    try {
      for (const unidade of unidades) await saveInformacoesDaUnidade(unidade.id, unidade.texto)
      await saveTelemedicina(clinicId, tele)
      setSalvo(true)
      window.setTimeout(() => setSalvo(false), 2500)
    } catch (causa) {
      avisar(causa instanceof Error ? causa.message : 'Não foi possível salvar.', 'erro')
    } finally {
      setSalvando(false)
    }
  }

  return (
    <section className="surface-card overflow-hidden rounded-[26px]">
      <div className="border-b border-[#081b2c]/[0.06] bg-gradient-to-r from-white to-[#f0f6fc] p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-[#dceaf7] text-[#1f4f78]">
            <MapPinned className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[9px] font-extrabold uppercase tracking-[0.15em] text-[#1f4f78]">Atendimento automático</p>
            <h2 className="mt-1 text-base font-extrabold tracking-[-0.03em] text-[#081b2c]">Informações por unidade</h2>
            <p className="mt-1.5 max-w-2xl text-[11px] leading-relaxed text-slate-400">
              Quando a família escolhe "Dúvidas sobre a consulta", o robô pergunta para qual atendimento e
              responde o texto daquele lugar: valor, pagamento, endereço, o que levar. No fim ele cola o
              fecho comum (como agendar, equipe, telefones, horário), editado em Conversas → Menu
              automático. Para negrito no WhatsApp, use *asteriscos*.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5 sm:p-6">
        {carregando ? (
          <p className="rounded-[16px] bg-[#f8f7f4] px-4 py-6 text-center text-[11px] text-slate-400">Carregando...</p>
        ) : (
          <>
            {unidades.map((unidade) => (
              <label key={unidade.id} className="block rounded-[22px] border border-[#081b2c]/[0.07] bg-white p-4 sm:p-5">
                <span className="flex items-center gap-1 text-[9px] font-extrabold uppercase tracking-wide text-slate-400">
                  {unidade.nome}
                  <Ajuda texto="Enviado exatamente como está escrito quando a família escolhe esta unidade. Vazio, o robô usa o texto geral do menu automático." />
                </span>
                <textarea
                  className={`${campo} min-h-[150px]`}
                  value={unidade.texto}
                  onChange={(e) => mudarUnidade(unidade.id, e.target.value)}
                  maxLength={1024}
                  placeholder={`*Consulta em ${unidade.nome}: R$ ...*`}
                />
                <span className="mt-1 block text-right text-[9px] font-bold text-slate-300">{unidade.texto.length}/1024</span>
              </label>
            ))}

            <div className="rounded-[22px] border border-[#081b2c]/[0.07] bg-white p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-[9px] font-extrabold uppercase tracking-wide text-slate-400">
                  <Video className="h-3.5 w-3.5 text-[#2f7fc1]" />
                  Telemedicina
                  <Ajuda texto="Ligada, aparece como opção nas informações e no agendamento. A consulta usa os horários das unidades físicas: é o mesmo médico no mesmo dia. Quem escolhe telemedicina também pode pedir urgência, e aí a conversa vai para a equipe com destaque." />
                </span>
                <label className="flex cursor-pointer items-center gap-2 rounded-[13px] border border-[#081b2c]/10 bg-[#fafaf8] px-3.5 py-2.5">
                  <input
                    type="checkbox"
                    checked={tele.ativa}
                    onChange={(e) => {
                      setTele({ ...tele, ativa: e.target.checked })
                      setSalvo(false)
                    }}
                    className="h-3.5 w-3.5 accent-[#2f7fc1]"
                  />
                  <span className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500">
                    {tele.ativa ? 'Oferecida pelo robô' : 'Desligada'}
                  </span>
                </label>
              </div>
              <textarea
                className={`${campo} min-h-[150px]`}
                value={tele.texto}
                onChange={(e) => {
                  setTele({ ...tele, texto: e.target.value })
                  setSalvo(false)
                }}
                maxLength={1024}
                placeholder="*Telemedicina: R$ ...* Inclui retorno presencial em até 30 dias."
              />
              <span className="mt-1 block text-right text-[9px] font-bold text-slate-300">{tele.texto.length}/1024</span>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void salvar()}
                disabled={salvando || !clinicId}
                className={`inline-flex items-center justify-center gap-2 rounded-[14px] px-5 py-3 text-xs font-extrabold text-white shadow-[0_10px_22px_rgba(8,27,44,.15)] transition disabled:opacity-60 ${
                  salvo ? 'bg-[#6f9d91]' : 'bg-[#081b2c] hover:bg-[#102d47]'
                }`}
              >
                {salvo ? <Check className="h-4 w-4" strokeWidth={3} /> : <Save className="h-4 w-4 text-[#6aa8d9]" />}
                {salvando ? 'Salvando...' : salvo ? 'Informações salvas' : 'Salvar informações'}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
