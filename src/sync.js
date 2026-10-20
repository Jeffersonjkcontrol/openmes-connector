import { ErroHttp } from './http.js';
import { formatarNoFuso } from './time.js';

/**
 * No mesmo instante: estado e contagem primeiro (a contagem que fecha uma OP
 * fica com ela), depois a troca de OP, o cartão do operador e o motivo.
 */
const PRIORIDADE = { sinal: 0, ordem: 1, operador: 2, motivo: 3, troca: 3, qualidade: 4 };

/** Resultado do cartão de qualidade (campo do context) → aprovado? */
const RESULTADO_QUALIDADE = { aprovado: true, approved: true, ok: true, reprovado: false, rejected: false, nok: false };

/** Série que a fonte não tem (ex.: máquina sem regmolde_rfid): avisa uma vez, não a cada ciclo. */
const naoEncontradas = new Set();

/**
 * Leituras por chamada ao /signals (o OpenMES aceita até 1000). Lote pequeno
 * para cada chamada terminar bem antes do tempo limite: se o conector desiste e
 * o OpenMES termina de gravar, o lote volta no próximo ciclo, e o contador
 * "legado" do OpenMES não ignora leitura repetida — soma de novo. Visto numa
 * reexecução de 6 meses: 1000 leituras levaram mais de 15 s num notebook.
 */
export const LOTE_MAXIMO = 100;

/**
 * 4xx que não melhoram com nova tentativa (cartão desconhecido, parada não
 * encontrada, motivo já dado por uma pessoa…): o evento é descartado com aviso
 * para não travar a fila. Qualquer outro erro (rede, 5xx, 401, 403, 429)
 * interrompe o ciclo e tudo que não foi entregue é tentado de novo no próximo.
 */
const ehPermanente = (erro) => erro instanceof ErroHttp && [400, 404, 409, 422].includes(erro.status);

/**
 * OP do context que o OpenMES não pôde iniciar (não cadastrada, encerrada…): a
 * máquina fica sem OP e o conector tenta de novo a cada tanto, para a OP entrar
 * assim que for cadastrada.
 */
export const REPETIR_OP_BLOQUEADA_MS = 15 * 60_000;

/** OP comparada só por letras e números, como o módulo faz ("77770001@" = "77770001"). */
const normalizarOp = (codigo) => String(codigo).replace(/[^0-9a-z]/gi, '').toLowerCase();

/**
 * Um ciclo: lê do jkcontrol tudo que chegou desde o último cursor (menos a
 * sobreposição), descarta o que já foi entregue, ordena por horário e entrega
 * ao OpenMES na ordem — sinais em lote por conexão, eventos de cartão e motivo
 * um a um, sem nunca passar um evento à frente de outro mais antigo.
 */
export async function executarCiclo({ config, jk, mes, estado, log, agora = new Date() }) {
    const eventos = [];
    const lidas = [];
    const atrasados = new Map();
    let parcelasInvalidas = 0;

    for (const maquina of config.maquinas) {
        for (const serie of maquina.series) {
            const chave = `${maquina.dispositivo}/${serie.variavel}`;
            const { cursor } = estado.serie(chave);
            const desde = cursor
                ? new Date(Date.parse(cursor) - config.sobreposicaoMs)
                : new Date(agora.getTime() - config.retroativoInicialMs);

            let itens;
            try {
                itens = await jk.leituras(maquina.dispositivo, serie.variavel, desde, agora);
            } catch (erro) {
                if (erro instanceof ErroHttp && erro.status === 404) {
                    if (!naoEncontradas.has(chave)) {
                        log.error(`${chave} não encontrado na fonte para este token — confira o config.json (aviso só uma vez).`);
                        naoEncontradas.add(chave);
                    }
                    continue;
                }
                throw erro;
            }
            lidas.push(chave);

            const ultimo = estado.ultimoEntregue(chave);
            let total = estado.total(chave);
            let semEntregaAinda = ultimo === null && total === 0;
            let anterior = estado.corrente(chave);
            for (const item of itens) {
                if (estado.jaVisto(chave, item.id)) continue;

                // Contagem corrente (injecao_hora do firmware Nitron): o equipamento
                // republica o mesmo total enquanto a máquina está parada e só zera
                // na troca de OP. Vale só o que cresceu desde a leitura anterior.
                if (serie.acumular === 'corrente') {
                    const leitura = Number(item.value);
                    if (!Number.isFinite(leitura) || leitura < 0) {
                        log.warn(`${chave} (${item.ts.toISOString()}): contagem ${item.value} inválida, ignorada.`);
                        parcelasInvalidas += 1;
                        estado.marcarVisto(chave, item.id, item.ts);
                        continue;
                    }

                    // Leitura atrasada não traz nada: a seguinte já inclui o que ela contou.
                    if (ultimo !== null && item.ts.getTime() < ultimo) {
                        estado.marcarVisto(chave, item.id, item.ts);
                        atrasados.set(chave, (atrasados.get(chave) ?? 0) + 1);
                        continue;
                    }

                    // A primeira leitura só serve de base: o que ela já contou é do
                    // passado. Valor que cai ou OP que troca: zerou, e a leitura
                    // inteira é produção nova. Context sem o campo (ex.: o cartão de
                    // molde, que troca o context sem zerar a contagem) mantém a marca.
                    const lida = serie.campoZeramento ? item.context?.[serie.campoZeramento] : undefined;
                    const marca = serie.campoZeramento
                        ? (lida !== undefined && lida !== null && lida !== '' ? String(lida) : anterior?.marca ?? '')
                        : null;
                    let parcela = 0;
                    if (anterior !== null) {
                        const zerou = leitura < anterior.valor || (marca !== null && marca !== anterior.marca);
                        parcela = zerou ? leitura : leitura - anterior.valor;
                    }
                    total += parcela;
                    anterior = { valor: leitura, marca };

                    // Com a base já no estado (ex.: reexecutar o histórico desde a
                    // primeira leitura do equipamento, com {valor: 0}), a primeira
                    // entrega já traz produção: uma base 0 antes faz ela valer no
                    // contador "legado" do OpenMES, que não conta a primeira leitura.
                    if (semEntregaAinda && total > 0) {
                        eventos.push({ ...montarEvento(maquina, serie, chave, { ...item, id: `${item.id}:base`, value: 0 }), total: 0 });
                    }
                    semEntregaAinda = false;

                    eventos.push({ ...montarEvento(maquina, serie, chave, { ...item, value: total }), total, corrente: anterior });
                    continue;
                }

                // Contagem por período (zera a cada envio): vira um total que só
                // cresce, que é o que o contador do OpenMES espera. O total só é
                // gravado quando a leitura é entregue (enviarLote), então um ciclo
                // interrompido refaz a soma do mesmo ponto. Contagem atrasada ainda
                // soma, com o horário da última entregue: perder peças é pior que
                // lançá-las alguns minutos depois.
                if (serie.acumular === 'soma') {
                    const parcela = Number(item.value);
                    if (!Number.isFinite(parcela) || parcela < 0) {
                        log.warn(`${chave} (${item.ts.toISOString()}): contagem ${item.value} inválida, ignorada.`);
                        parcelasInvalidas += 1;
                        estado.marcarVisto(chave, item.id, item.ts);
                        continue;
                    }

                    const ts = ultimo !== null && item.ts.getTime() < ultimo ? new Date(ultimo) : item.ts;

                    // O contador "legado" do OpenMES usa a primeira leitura como
                    // base e não a conta: uma base 0 antes faz a primeira parcela valer.
                    if (semEntregaAinda && parcela > 0) {
                        eventos.push({ ...montarEvento(maquina, serie, chave, { ...item, id: `${item.id}:base`, ts, value: 0 }), total: 0 });
                    }
                    semEntregaAinda = false;

                    // Período sem produção (0) também vai: o OpenMES guarda o último
                    // total em cache por 1 dia, e sem leituras a primeira parcela
                    // depois de um fim de semana parado viraria base e se perderia.
                    total += parcela;
                    eventos.push({ ...montarEvento(maquina, serie, chave, { ...item, ts, value: total }), total });
                    continue;
                }

                // Sinal de máquina não anda para trás: um estado antigo entregue
                // depois de um mais novo faria o OpenMES "parar" a máquina agora,
                // e o contador recusa leitura fora de ordem. Leitura atrasada de
                // sinal é descartada; cartão e motivo atrasados ainda servem.
                if (serie.tipo === 'sinal' && ultimo !== null && item.ts.getTime() < ultimo) {
                    estado.marcarVisto(chave, item.id, item.ts);
                    atrasados.set(chave, (atrasados.get(chave) ?? 0) + 1);
                    continue;
                }

                eventos.push(montarEvento(maquina, serie, chave, item));
            }
        }
    }

    for (const [chave, n] of atrasados) {
        log.warn(`${chave}: ${n} leitura(s) mais antiga(s) que a última entregue foram ignoradas.`);
    }

    eventos.sort((a, b) => (a.ts - b.ts) || (PRIORIDADE[a.tipo] - PRIORIDADE[b.tipo]));
    const fila = comTrocasDeOpDoContexto(eventos, estado);

    const resumo = {
        sinais: 0,
        ordem: 0,
        operador: 0,
        motivo: 0,
        troca: 0,
        qualidade: 0,
        descartados: [...atrasados.values()].reduce((s, n) => s + n, 0) + parcelasInvalidas,
    };
    const ctx = { config, mes, estado, log, resumo };

    let lote = null;
    const despacharLote = async () => {
        if (!lote) return;
        const atual = lote;
        lote = null;
        await enviarLote(atual, ctx);
    };

    for (const evento of fila) {
        if (evento.tipo === 'sinal') {
            if (lote && (lote.conexaoId !== evento.conexaoId || lote.itens.length >= LOTE_MAXIMO)) {
                await despacharLote();
            }
            lote ??= { conexaoId: evento.conexaoId, itens: [] };
            lote.itens.push(evento);
            continue;
        }

        await despacharLote();
        await enviarEventoModulo(evento, ctx);
    }
    await despacharLote();

    // Só chega aqui se tudo foi entregue (ou descartado de propósito).
    const esquecerAntesDe = new Date(agora.getTime() - config.sobreposicaoMs - 3_600_000);
    for (const chave of lidas) {
        estado.avancarCursor(chave, agora);
        estado.podar(chave, esquecerAntesDe);
    }
    estado.salvar();

    // Mantém a conexão "viva" na tela do OpenMES mesmo sem sinais novos.
    const conexoes = new Set(config.maquinas.map((m) => m.conexaoId).filter((id) => id !== null));
    for (const conexaoId of conexoes) {
        try {
            await mes.heartbeat(conexaoId);
        } catch (erro) {
            log.warn(`heartbeat da conexão ${conexaoId} falhou: ${erro.message}`);
        }
    }

    return resumo;
}

/**
 * OP pelo context: cada ciclo ou contagem diz de qual OP é. Quando a OP muda
 * (ou na primeira leitura da máquina), a troca entra na fila logo antes da
 * leitura, para a contagem dela já cair na OP certa. O cartão de OP também
 * conta como troca; o que vem depois com a mesma OP não chama o OpenMES de novo.
 */
export function comTrocasDeOpDoContexto(eventos, estado) {
    const naMaquina = new Map();
    const opDe = (dispositivo) => (naMaquina.has(dispositivo) ? naMaquina.get(dispositivo) : estado.opDaMaquina(dispositivo));
    const fila = [];

    for (const evento of eventos) {
        if (evento.opContexto !== undefined) {
            const atual = opDe(evento.dispositivo);
            const op = normalizarOp(evento.opContexto);
            const mesmaOp = atual?.op === op;
            const repetir = mesmaOp && atual.bloqueada && evento.ts.getTime() - atual.tentativa >= REPETIR_OP_BLOQUEADA_MS;

            if (!mesmaOp || repetir) {
                fila.push({
                    chave: `${evento.dispositivo} (OP do context)`,
                    id: `${evento.id}:op`,
                    ts: evento.ts,
                    tipo: 'ordem',
                    origem: 'context',
                    dispositivo: evento.dispositivo,
                    estacaoId: evento.estacaoId,
                    codigo: evento.opContexto,
                    quandoBloqueada: 'park',
                });
                naMaquina.set(evento.dispositivo, { op, bloqueada: repetir, tentativa: evento.ts.getTime() });
            }
        } else if (evento.tipo === 'ordem' && !evento.ignorar && evento.dispositivo) {
            naMaquina.set(evento.dispositivo, { op: normalizarOp(evento.codigo), bloqueada: false, tentativa: evento.ts.getTime() });
        }
        fila.push(evento);
    }

    return fila;
}

export function montarEvento(maquina, serie, chave, item) {
    const base = { chave, id: item.id, ts: item.ts, tipo: serie.tipo };

    if (serie.tipo === 'sinal') {
        const evento = { ...base, conexaoId: maquina.conexaoId, nodeId: serie.nodeId, valor: item.value };
        const op = maquina.campoOpContexto ? item.context?.[maquina.campoOpContexto] : undefined;
        if (op !== undefined && op !== null && op !== '') {
            Object.assign(evento, { opContexto: String(op), dispositivo: maquina.dispositivo, estacaoId: maquina.estacaoId });
        }
        return evento;
    }

    // Com a OP pelo context, OP que não pode rodar tira a anterior da máquina.
    const daOrdem = serie.tipo === 'ordem'
        ? { dispositivo: maquina.dispositivo, ...(maquina.campoOpContexto && { quandoBloqueada: 'park' }) }
        : {};

    if (serie.tipo === 'operador') {
        const valor = Number(item.value);
        const acao = valor === 1 ? 'login' : valor === 0 ? 'logout' : null;
        const uid = serie.campo
            ? item.context?.[serie.campo] ?? null
            : item.context?.uid ?? item.context?.card_uid ?? item.context?.cartao ?? null;

        if (!acao) return { ...base, ignorar: `valor ${item.value} não é 1 (login) nem 0 (logout)` };
        if (!uid) return { ...base, ignorar: `sem o UID do cartão em context.${serie.campo ?? 'uid'}` };

        return { ...base, estacaoId: maquina.estacaoId, acao, uid: String(uid) };
    }

    if (serie.tipo === 'qualidade') {
        const status = String(item.context?.[serie.campo ?? 'status'] ?? '').trim().toLowerCase();
        const aprovado = RESULTADO_QUALIDADE[status];
        if (aprovado === undefined) return { ...base, ignorar: `resultado de qualidade "${status}" desconhecido` };
        return { ...base, estacaoId: maquina.estacaoId, aprovado, status };
    }

    if (serie.tipo === 'troca') {
        const cartao = serie.campo ? item.context?.[serie.campo] : item.context?.uid;
        return {
            ...base,
            estacaoId: maquina.estacaoId,
            codigo: serie.codigoMotivo,
            ...(cartao !== undefined && cartao !== null && cartao !== '' && { cartao: String(cartao) }),
        };
    }

    // Motivo de parada e OP: o código vem no valor (o jkcontrol só guarda número);
    // context.reason_code / context.order_no permitem códigos com letras; 0 = nada.
    // Com "code_field", o código vem só daquele campo do context (o valor é ignorado).
    if (serie.campo) {
        const doCartao = item.context?.[serie.campo];
        if (!doCartao) return { ...base, ignorar: `sem código em context.${serie.campo}` };
        return { ...base, ...daOrdem, estacaoId: maquina.estacaoId, codigo: String(doCartao) };
    }
    const doContext = serie.tipo === 'ordem' ? item.context?.order_no : item.context?.reason_code;
    const codigo = doContext ?? (Number(item.value) > 0 ? String(item.value) : null);
    if (!codigo) return { ...base, ignorar: serie.tipo === 'ordem' ? 'OP 0 (sem OP)' : 'motivo 0 (sem motivo)' };

    return { ...base, ...daOrdem, estacaoId: maquina.estacaoId, codigo: String(codigo) };
}

async function enviarLote(lote, { config, mes, estado, log, resumo }) {
    const leituras = lote.itens.map((e) => ({
        node_id: e.nodeId,
        value: e.valor,
        ts: formatarNoFuso(e.ts, config.fuso),
        event_id: e.id,
    }));

    try {
        const corpo = await mes.enviarSinais(lote.conexaoId, leituras);
        const aceitos = Number(corpo?.accepted ?? leituras.length);
        if (aceitos < leituras.length) {
            const tags = [...new Set(leituras.map((l) => l.node_id))].join(', ');
            log.warn(`conexão ${lote.conexaoId}: OpenMES aceitou ${aceitos} de ${leituras.length} leituras — confira se existem tags ativas com estes endereços: ${tags}`);
        }
        resumo.sinais += aceitos;
    } catch (erro) {
        if (!ehPermanente(erro)) throw erro;
        log.error(`conexão ${lote.conexaoId}: ${leituras.length} leitura(s) recusadas — ${erro.message}`);
        resumo.descartados += leituras.length;
    }

    // Recusa definitiva também grava o total: a próxima leitura leva o OpenMES ao
    // total certo (ele conta a diferença desde a última que aceitou).
    for (const e of lote.itens) {
        estado.marcarEntregue(e.chave, e.id, e.ts);
        if (e.total !== undefined) estado.definirTotal(e.chave, e.total);
        if (e.corrente !== undefined) estado.definirCorrente(e.chave, e.corrente);
    }
    estado.salvar();
}

async function enviarEventoModulo(evento, { config, mes, estado, log, resumo }) {
    if (evento.ignorar) {
        log.warn(`${evento.chave} (${evento.ts.toISOString()}): ignorado — ${evento.ignorar}.`);
        resumo.descartados += 1;
        estado.marcarVisto(evento.chave, evento.id, evento.ts);
        estado.salvar();
        return;
    }

    const quando = formatarNoFuso(evento.ts, config.fuso);

    try {
        if (evento.tipo === 'operador') {
            const r = await mes.eventoOperador({
                card_uid: evento.uid,
                action: evento.acao,
                workstation_id: evento.estacaoId,
                occurred_at: quando,
            });
            log.info(`${evento.chave}: cartão ${evento.uid} ${evento.acao} → ${r?.status ?? 'ok'}`);
            resumo.operador += 1;
        } else if (evento.tipo === 'ordem') {
            const r = await mes.iniciarOrdem(evento.estacaoId, {
                order_no: evento.codigo,
                occurred_at: quando,
                ...(evento.quandoBloqueada && { when_blocked: evento.quandoBloqueada }),
            });
            const parada = r?.status === 'parked';
            if (parada) {
                log.warn(`${evento.chave}: OP ${evento.codigo} não pode rodar no OpenMES (${r.reason ?? 'sem motivo'}); a máquina ficou sem OP e a contagem fica só nela até a OP ser cadastrada.`);
            } else {
                log.info(`${evento.chave}: OP ${evento.codigo} → ${r?.status ?? 'ok'}`);
            }
            if (evento.dispositivo) lembrarOp(estado, evento, parada);
            resumo.ordem += 1;
        } else if (evento.tipo === 'qualidade') {
            const r = await mes.registrarQualidade(evento.estacaoId, { passed: evento.aprovado, occurred_at: quando });
            log.info(`${evento.chave}: qualidade ${evento.status} → ${r?.status ?? 'ok'} (OP ${r?.data?.order_no ?? '?'})`);
            resumo.qualidade += 1;
        } else if (evento.tipo === 'troca') {
            const r = await mes.motivoParada(evento.estacaoId, {
                reason_code: evento.codigo,
                occurred_at: quando,
                ...(evento.cartao && { worker_card: evento.cartao }),
            });
            log.info(`${evento.chave}: troca de molde (cartão ${evento.cartao ?? '—'}) → parada ${r?.data?.downtime_id ?? '?'}`);
            resumo.troca += 1;
        } else {
            const r = await mes.motivoParada(evento.estacaoId, { reason_code: evento.codigo, occurred_at: quando });
            log.info(`${evento.chave}: motivo ${evento.codigo} → parada ${r?.data?.downtime_id ?? '?'}`);
            resumo.motivo += 1;
        }
    } catch (erro) {
        if (!ehPermanente(erro)) throw erro;
        log.warn(`${evento.chave} (${quando}): recusado pelo OpenMES — ${erro.message}`);
        resumo.descartados += 1;
        if (evento.tipo === 'ordem' && evento.dispositivo) lembrarOp(estado, evento, true);
    }

    // A troca pela OP do context não é uma leitura: não há o que marcar como visto.
    if (evento.origem !== 'context') estado.marcarVisto(evento.chave, evento.id, evento.ts);
    estado.salvar();
}

function lembrarOp(estado, evento, bloqueada) {
    estado.definirOpDaMaquina(evento.dispositivo, { op: normalizarOp(evento.codigo), bloqueada, tentativa: evento.ts.getTime() });
}
