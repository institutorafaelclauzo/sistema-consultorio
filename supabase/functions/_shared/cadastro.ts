import type { adminClient } from './whatsapp.ts'

/**
 * O cadastro do paciente a partir do que a familia informou no WhatsApp.
 *
 * Vive aqui, e nao dentro de uma funcao so, porque duas horas diferentes
 * precisam do mesmo cuidado: logo depois de a familia responder a ficha, e na
 * vespera da consulta, quando o robo tenta fechar o que ficou aberto.
 */

type Admin = ReturnType<typeof adminClient>

export type ConsultaParaCadastro = {
  id: string
  /** Preenchido quando a consulta ja esta ligada a uma ficha. */
  patient_id?: string | null
  starts_at: string
  contact_name: string | null
  contact_phone: string | null
  intake_patient_name?: string | null
  intake_birth_date?: string | null
  intake_guardian?: string | null
  intake_cpf?: string | null
  intake_email?: string | null
  clinic_units?: { name: string } | { name: string }[] | null
}

/**
 * Cria o cadastro de quem marcou pelo WhatsApp e ainda nao tem prontuario.
 *
 * Roda assim que a familia termina de responder a ficha, e de novo na vespera
 * para o que tiver ficado aberto. Existe por um motivo pratico: sem cadastro
 * nao ha prontuario, e o medico so descobriria isso com a familia sentada na
 * frente. Assim o dado que a familia acabou de digitar ja vira cadastro, sem
 * depender de alguem lembrar de clicar num botao.
 *
 * Tres cuidados, porque o dado veio por mensagem e ninguem conferiu:
 *  - telefone ja conhecido nao vira cadastro novo, vira vinculo. Duplicar o
 *    paciente e pior do que nao criar: o historico se parte em dois;
 *  - sem nome nenhum nao cria. "Consulta de quem?" nao se responde chutando;
 *  - o que nasce aqui fica marcado como automatico ate alguem da equipe abrir,
 *    conferir e salvar.
 */
export async function cadastrarDaFicha(
  admin: Admin,
  clinicId: string,
  consulta: ConsultaParaCadastro,
): Promise<{ id: string; name: string; phone: string; whatsapp_opt_out_at: string | null } | null> {
  const telefone = (consulta.contact_phone ?? '').trim()

  // Ja existe alguem com este telefone? Entao a consulta e dessa pessoa, e o
  // que faltava era so o vinculo.
  if (telefone) {
    const { data: conhecido } = await admin
      .from('patients')
      .select('id,name,phone,whatsapp_opt_out_at')
      .eq('clinic_id', clinicId)
      .eq('phone', telefone)
      .is('archived_at', null)
      .limit(1)
      .maybeSingle()
    if (conhecido) {
      await admin.from('appointments').update({ patient_id: conhecido.id }).eq('id', consulta.id)
      return conhecido
    }
  }

  const nome = (consulta.intake_patient_name || consulta.contact_name || '').trim()
  if (nome.length < 2) return null

  // Data so quando e data. "marco de 2019" fica em branco e a equipe pergunta:
  // uma data inventada no prontuario e pior do que um campo vazio.
  const m = (consulta.intake_birth_date ?? '').trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
  const nascimento = m
    ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
    : null

  const unidade = Array.isArray(consulta.clinic_units)
    ? consulta.clinic_units[0]?.name ?? ''
    : consulta.clinic_units?.name ?? ''

  const { data: criado, error } = await admin
    .from('patients')
    .insert({
      clinic_id: clinicId,
      name: nome.slice(0, 200),
      guardian_name: (consulta.intake_guardian ?? '').slice(0, 200),
      birth_date: nascimento,
      phone: telefone.slice(0, 32),
      cpf: (consulta.intake_cpf ?? '').replace(/\D/g, '') || null,
      email: (consulta.intake_email ?? '') || null,
      unit: unidade.slice(0, 160),
      consultation_date: consulta.starts_at.slice(0, 10),
      notes: 'Cadastro criado pelo sistema a partir do agendamento no WhatsApp. Confira os dados com a família.',
      auto_created_at: new Date().toISOString(),
    })
    .select('id,name,phone,whatsapp_opt_out_at')
    .maybeSingle()

  if (error || !criado) {
    console.error('Falha ao criar cadastro automatico', { appointmentId: consulta.id, error })
    return null
  }

  await admin.from('appointments').update({ patient_id: criado.id }).eq('id', consulta.id)
  return criado
}

