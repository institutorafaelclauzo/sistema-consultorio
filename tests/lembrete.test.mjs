// Bateria da resposta ao lembrete de consulta.
//
// Esta parte do sistema nao tinha teste nenhum ate 31/08/2026, e o preco
// apareceu num caso real: o Wagner confirmou a consulta, a confirmacao nao
// chegou na plataforma, e a causa so foi encontrada garimpando o banco de
// producao. Cada caso abaixo existe para que um erro desses falhe aqui, em dois
// segundos, e nao la, em silencio.
import {
  avisoDaResposta,
  respostaAoAcompanhamento,
  equipeFalouRecentemente,
  interpretarResposta,
  mudancaDaConsulta,
  respondendoEnvioNosso,
} from './lembrete.build.mjs'

let passou = 0
const falhas = []

function conferir(titulo, condicao, detalhe = '') {
  if (condicao) passou++
  else falhas.push(`${titulo}${detalhe ? ` | ${detalhe}` : ''}`)
}

const AGORA = new Date('2026-08-31T20:00:00Z').getTime()
const HORA = 3600 * 1000
const quando = (horasAtras) => new Date(AGORA - horasAtras * HORA).toISOString()

// ---------------------------------------------------------------------------
// A janela: quando "1" quer dizer "confirmo" e quando quer dizer "menu"
// ---------------------------------------------------------------------------

conferir(
  'Lembrete de duas horas atrás ainda está na janela',
  respondendoEnvioNosso({ created_at: quando(2), appointment_id: 'a1' }, AGORA) === true,
)

conferir(
  'Lembrete de três dias atrás já saiu da janela',
  respondendoEnvioNosso({ created_at: quando(72), appointment_id: 'a1' }, AGORA) === false,
)

conferir(
  'Mensagem nossa sem consulta nem acompanhamento não abre janela',
  respondendoEnvioNosso({ created_at: quando(1), appointment_id: null, followup_id: null }, AGORA) ===
    false,
)

conferir(
  'Acompanhamento também abre a janela, não só a consulta',
  respondendoEnvioNosso({ created_at: quando(5), followup_id: 'f1' }, AGORA) === true,
)

conferir('Conversa sem nenhuma mensagem nossa não abre janela', respondendoEnvioNosso(null, AGORA) === false)

// ---------------------------------------------------------------------------
// O robô calado enquanto gente conversa
// ---------------------------------------------------------------------------

conferir(
  'Equipe escreveu há uma hora: o robô não interrompe',
  equipeFalouRecentemente({ created_at: quando(1) }, AGORA) === true,
)

conferir(
  'Equipe escreveu ontem: o robô volta a atender',
  equipeFalouRecentemente({ created_at: quando(20) }, AGORA) === false,
)

conferir(
  'Ninguém da equipe escreveu: o robô atende',
  equipeFalouRecentemente(null, AGORA) === false,
)

// ---------------------------------------------------------------------------
// O que a pessoa quis dizer
// ---------------------------------------------------------------------------

const casos = [
  // [texto, dentroDaJanela, campo esperado]
  ['CONFIRMAR', true, 'confirma'],
  ['confirmar', true, 'confirma'],
  ['Confirmo', true, 'confirma'],
  ['1', true, 'confirma'],
  ['REMARCAR', true, 'remarca'],
  ['reagendar', true, 'remarca'],
  ['2', true, 'remarca'],
  ['CANCELAR', true, 'cancela'],
  ['cancelar consulta', true, 'cancela'],
  ['3', true, 'cancela'],
]

for (const [texto, janela, campo] of casos) {
  const r = interpretarResposta(texto, janela)
  conferir(`"${texto}" dentro da janela é ${campo}`, r[campo] === true && r.respondeuLembrete === true)
}

// O ponto mais importante da bateria: o mesmo "1" fora da janela NAO pode ser
// confirmacao, senao quem digita 1 no menu confirma uma consulta sem querer.
for (const numero of ['1', '2', '3']) {
  const r = interpretarResposta(numero, false)
  conferir(
    `"${numero}" fora da janela é opção de menu, não resposta ao lembrete`,
    r.respondeuLembrete === false,
  )
}

// A palavra escrita tambem so vale na janela: quem digita CANCELAR no meio de
// um agendamento esta desistindo do agendamento, nao cancelando consulta.
conferir(
  'CANCELAR fora da janela não desmarca consulta',
  interpretarResposta('CANCELAR', false).respondeuLembrete === false,
)

conferir(
  'Acentos e espaços não atrapalham',
  interpretarResposta('  Confirmar  ', true).confirma === true,
)

conferir(
  'Texto qualquer não vira resposta ao lembrete',
  interpretarResposta('bom dia, tudo bem?', true).respondeuLembrete === false,
)

// Cumprimento nao e resposta ao acompanhamento: "tudo bem?" e pergunta, e
// trata-la como "estou bem" faria o robo se calar diante de um bom dia.
conferir(
  '"bom dia, tudo bem?" não é a resposta "Estou bem"',
  interpretarResposta('bom dia, tudo bem?', true).isWell === false,
)

// ---------------------------------------------------------------------------
// O rótulo do botão mora na Meta, não aqui
// ---------------------------------------------------------------------------
//
// O modelo aprovado manda de volta o proprio texto do botao. Enquanto a
// comparacao era exata, um botao escrito "Confirmar presenca" nao batia com
// nada: o paciente tocava em confirmar e a consulta continuava nao confirmada,
// sem erro nenhum na tela. Estes casos existem para que trocar o texto do botao
// na Meta nunca mais quebre o sistema em silencio.

for (const rotulo of ['Confirmar presença', 'Confirmar presenca', 'CONFIRMAR PRESENÇA', 'quero confirmar minha consulta']) {
  conferir(`"${rotulo}" confirma a consulta`, interpretarResposta(rotulo, true).confirma === true)
}

for (const rotulo of ['Preciso remarcar', 'quero remarcar', 'Reagendar consulta', 'preciso de outro horario']) {
  conferir(`"${rotulo}" pede remarcação`, interpretarResposta(rotulo, true).remarca === true)
}

for (const rotulo of ['Cancelar consulta', 'preciso cancelar', 'quero desmarcar']) {
  conferir(`"${rotulo}" cancela`, interpretarResposta(rotulo, true).cancela === true)
}

// A negacao inverte a frase inteira: melhor cair no atendimento humano do que
// confirmar a presenca de quem acabou de dizer que nao vai.
for (const frase of ['não posso confirmar', 'não vou poder confirmar', 'não quero cancelar']) {
  const r = interpretarResposta(frase, true)
  conferir(`"${frase}" não é tratada como resposta ao lembrete`, r.respondeuLembrete === false)
}

conferir(
  '"Preciso de ajuda" continua chamando a equipe',
  interpretarResposta('Preciso de ajuda', false).pediuAjuda === true,
)

conferir(
  '"vou sair de viagem" não descadastra ninguém',
  interpretarResposta('vou sair de viagem', false).optedOut === false,
)

conferir(
  '"Não quero receber" descadastra',
  interpretarResposta('Não quero receber', false).optedOut === true,
)

// ---------------------------------------------------------------------------
// Quem precisa aparecer para a equipe
// ---------------------------------------------------------------------------

conferir(
  'Confirmar não incomoda a equipe',
  interpretarResposta('CONFIRMAR', true).motivoAtencao === null,
)
conferir(
  'Remarcar chama a equipe',
  interpretarResposta('REMARCAR', true).motivoAtencao === 'remarcacao',
)
conferir(
  'Cancelar chama a equipe',
  interpretarResposta('CANCELAR', true).motivoAtencao === 'cancelamento',
)
conferir(
  'Pedido de ajuda chama a equipe mesmo fora da janela',
  interpretarResposta('preciso de ajuda', false).motivoAtencao === 'ajuda',
)
conferir('SAIR é descadastro, não resposta', interpretarResposta('sair', true).optedOut === true)

// ---------------------------------------------------------------------------
// O que é gravado na consulta
// ---------------------------------------------------------------------------

const AGORA_ISO = new Date(AGORA).toISOString()

const gravaConfirmar = mudancaDaConsulta(interpretarResposta('CONFIRMAR', true), AGORA_ISO)
conferir(
  'Confirmar grava a data e limpa pedido de remarcação anterior',
  gravaConfirmar.confirmed_at === AGORA_ISO && gravaConfirmar.reschedule_requested_at === null,
  JSON.stringify(gravaConfirmar),
)

const gravaCancelar = mudancaDaConsulta(interpretarResposta('CANCELAR', true), AGORA_ISO)
conferir(
  'Cancelar muda o status para liberar a vaga',
  gravaCancelar.status === 'cancelled' && gravaCancelar.cancelled_at === AGORA_ISO,
  JSON.stringify(gravaCancelar),
)

const gravaRemarcar = mudancaDaConsulta(interpretarResposta('REMARCAR', true), AGORA_ISO)
conferir(
  'Remarcar anota o pedido sem cancelar nada',
  gravaRemarcar.reschedule_requested_at === AGORA_ISO && gravaRemarcar.status === undefined,
  JSON.stringify(gravaRemarcar),
)

// ---------------------------------------------------------------------------
// O que a pessoa recebe de volta
// ---------------------------------------------------------------------------

for (const [texto, trecho] of [
  ['CONFIRMAR', 'confirmada'],
  ['CANCELAR', 'cancelada'],
  ['REMARCAR', 'remarcar'],
]) {
  const aviso = avisoDaResposta(interpretarResposta(texto, true))
  conferir(`Resposta a ${texto} confirma o que aconteceu`, aviso.toLowerCase().includes(trecho), aviso)
  // Nenhuma mensagem pode terminar sem dizer o proximo passo.
  conferir(`Resposta a ${texto} não deixa no vácuo`, aviso.includes('0'), aviso)
}

// ---------------------------------------------------------------------------

console.log('\n===== RESPOSTA AO LEMBRETE =====')
// ---- Botoes do acompanhamento ----
{
  const base = { confirma: false, remarca: false, cancela: false, respondeuLembrete: false, optedOut: false, isWell: false, pediuAjuda: false, motivoAtencao: null }
  conferir('estou bem recebe resposta', /Que bom/.test(respostaAoAcompanhamento({ ...base, isWell: true }) ?? ''))
  conferir('preciso de ajuda avisa a equipe', /equipe/.test(respostaAoAcompanhamento({ ...base, pediuAjuda: true, motivoAtencao: 'ajuda' }) ?? ''))
  conferir('nao quero receber confirma', /não enviaremos/.test(respostaAoAcompanhamento({ ...base, optedOut: true }) ?? ''))
  conferir('sem botao, sem resposta', respostaAoAcompanhamento(base) === null)
}

console.log(`VERIFICAÇÕES QUE PASSARAM: ${passou}`)
console.log(`FALHAS: ${falhas.length}`)
if (falhas.length) {
  console.log('')
  for (const f of falhas) console.log(`✗ ${f}`)
  process.exit(1)
}

