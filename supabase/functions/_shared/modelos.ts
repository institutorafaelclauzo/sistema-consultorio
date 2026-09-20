/**
 * O texto dos modelos aprovados na Meta.
 *
 * Fora da janela de 24 horas o WhatsApp só aceita modelo aprovado, e a Meta
 * guarda o texto do lado dela: nós mandamos o nome do modelo e os parâmetros,
 * e ela monta a mensagem. O sistema, então, nunca via o que a família leu -
 * guardava um resumo ("Acompanhamento de 30 dias enviado para Fulano"), e a
 * equipe abria a conversa na plataforma sem saber o que tinha sido dito.
 *
 * Aqui ficam as mesmas frases, para o registro da conversa mostrar a mensagem
 * como ela chega no celular. Se um modelo for alterado na Meta, este arquivo
 * precisa acompanhar: por isso os textos estão juntos, curtos e comentados, e
 * não espalhados pelas funções.
 */

/** Modelos conhecidos, pelo nome cadastrado na Meta. */
const MODELOS: Record<string, { corpo: string; rodape?: string; botoes?: string[] }> = {
  acompanhamento_pos_consulta: {
    corpo:
      'Olá, {{1}}. A Instituto Clauzo está entrando em contato para acompanhar ' +
      'sua consulta realizada em {{2}}. Como você está? Responda esta mensagem caso ' +
      'precise falar com nossa equipe.',
    rodape: 'Para não receber novos acompanhamentos, responda SAIR.',
    botoes: ['Estou bem', 'Preciso de ajuda', 'Não quero receber'],
  },
  lembrete_consulta: {
    corpo:
      'Olá, {{1}}. Lembrete da sua consulta em {{2}} às {{3}}, na unidade {{4}}. ' +
      'Podemos confirmar sua presença?',
    botoes: ['Confirmar presença', 'Preciso remarcar'],
  },
  // A resposta da equipe fora da janela de 24 horas. O {{2}} é o texto que a
  // pessoa digitou na tela - por isso o registro precisa deste modelo aqui:
  // sem ele, a conversa guardaria "modelo enviado" e ninguém saberia o que a
  // família leu, que é justamente o conteúdo que importa.
  resposta_da_clinica: {
    corpo:
      'Olá, {{1}}. Aqui é o consultório do Dr. Rafael Clauzo.\n\n{{2}}\n\n' +
      'Se precisar, é só responder por aqui.',
  },
}

/**
 * A mensagem como a família recebe, com os parâmetros no lugar.
 *
 * Modelo desconhecido devolve null, e quem chamou usa o resumo de antes: um
 * modelo novo na Meta não pode impedir o envio nem apagar o registro.
 */
export function textoDoModelo(nome: string, parametros: string[]): string | null {
  const modelo = MODELOS[nome]
  if (!modelo) return null

  const corpo = modelo.corpo.replace(/\{\{(\d+)\}\}/g, (_, indice) => parametros[Number(indice) - 1] ?? '')

  return [
    corpo,
    modelo.rodape,
    // Os botões entram no texto porque são parte do que a pessoa vê, e porque
    // explicam as respostas curtas que voltam depois ("Estou bem") para quem
    // ler a conversa semanas mais tarde.
    modelo.botoes?.length ? `[${modelo.botoes.join(' · ')}]` : null,
  ]
    .filter(Boolean)
    .join('\n\n')
}
