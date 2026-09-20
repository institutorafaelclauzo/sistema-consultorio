import { adminClient, corsHeaders, json } from '../_shared/whatsapp.ts'
import { sendFollowup } from '../_shared/sendFollowup.ts'

/**
 * Disparo automatico diario dos acompanhamentos vencidos.
 *
 * Chamada pelo pg_cron (ver migration de agendamento). Nao ha usuario logado,
 * entao a autorizacao e feita por um segredo compartilhado em CRON_SECRET.
 *
 * Sobre consentimento: a clinica decidiu que todo paciente atendido pelo medico
 * e um contato legitimo para o acompanhamento pos-consulta, e autorizou o envio
 * para toda a base. A base legal e a assistencia (LGPD art. 11, tutela da
 * saude), nao a autorizacao.
 *
 * O que continua valendo sem excecao: quem respondeu SAIR nunca mais recebe
 * nada. Essa checagem vem antes de qualquer envio, em sendFollowup.
 *
 * Para voltar atras, troque consentConfirmed por requireExistingConsent: true.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405)

  const expected = Deno.env.get('CRON_SECRET')?.trim()
  if (!expected) {
    return json({ error: 'CRON_SECRET não configurado no servidor.' }, 503)
  }
  if (req.headers.get('x-cron-secret')?.trim() !== expected) {
    return json({ error: 'Não autorizado.' }, 401)
  }

  try {
    const admin = adminClient()
    const today = new Date().toISOString().slice(0, 10)

    const { data: due, error } = await admin
      .from('followups')
      .select('id,patient_id,followup_key,due_date')
      .lte('due_date', today)
      .eq('status', 'pending')
      .is('archived_at', null)
      .is('whatsapp_sent_at', null)
      .order('due_date', { ascending: true })
      .limit(200)

    if (error) {
      console.error('Due lookup failed', error)
      return json({ error: 'Erro ao listar acompanhamentos vencidos.', details: error.message }, 500)
    }

    const resumo = { vencidos: due?.length ?? 0, enviados: 0, pulados: 0, falhas: 0 }
    const detalhes: { followupId: string; resultado: string }[] = []

    for (const followup of due ?? []) {
      const result = await sendFollowup(followup.id, {
        consentConfirmed: true,
        consentSource: 'clinic_care_relationship',
      })
      if (result.ok && !result.alreadySent) {
        resumo.enviados += 1
        detalhes.push({ followupId: followup.id, resultado: 'enviado' })
      } else if (result.ok) {
        resumo.pulados += 1
        detalhes.push({ followupId: followup.id, resultado: 'ja enviado' })
      } else if (result.code === 'CONSENT_MISSING' || result.code === 'OPTED_OUT' || result.code === 'INCOMPLETE') {
        resumo.pulados += 1
        detalhes.push({ followupId: followup.id, resultado: result.code })
      } else {
        resumo.falhas += 1
        detalhes.push({ followupId: followup.id, resultado: `${result.code ?? 'ERRO'}: ${result.error}` })
      }
    }

    console.log('whatsapp-dispatch', JSON.stringify(resumo))
    return json({ ok: true, ...resumo, detalhes })
  } catch (error) {
    console.error(error)
    return json({ error: 'Falha no disparo automático.' }, 500)
  }
})
