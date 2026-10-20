import { readFileSync } from 'node:fs';
import { validarFuso } from './time.js';

/**
 * Configuração: credenciais e intervalos vêm de variáveis de ambiente (.env);
 * o mapeamento máquina → OpenMES vem do config.json (ver config.example.json).
 */
export function carregarConfig(env = process.env) {
    const arquivoMapa = env.CONFIG_FILE || './config.json';

    let mapa;
    try {
        mapa = JSON.parse(readFileSync(arquivoMapa, 'utf8'));
    } catch (erro) {
        throw new Error(`Não consegui ler ${arquivoMapa}: ${erro.message}`);
    }

    const openmes = {
        baseUrl: obrigatoria(env, 'OPENMES_URL'),
        token: env.OPENMES_TOKEN || null,
        usuario: env.OPENMES_USERNAME || null,
        senha: env.OPENMES_PASSWORD || null,
    };
    if (!openmes.token && !(openmes.usuario && openmes.senha)) {
        throw new Error('Configure OPENMES_USERNAME e OPENMES_PASSWORD (ou OPENMES_TOKEN).');
    }

    return {
        fonte: carregarFonte(env),
        openmes,
        fuso: validarFuso(env.OPENMES_TIMEZONE || 'America/Sao_Paulo'),
        intervaloMs: inteiro(env.POLL_INTERVAL_SECONDS, 15, 'POLL_INTERVAL_SECONDS') * 1000,
        sobreposicaoMs: inteiro(env.OVERLAP_MINUTES, 15, 'OVERLAP_MINUTES') * 60_000,
        retroativoInicialMs: inteiro(env.INITIAL_LOOKBACK_MINUTES, 60, 'INITIAL_LOOKBACK_MINUTES') * 60_000,
        porPagina: inteiro(env.PAGE_SIZE, 500, 'PAGE_SIZE'),
        arquivoEstado: env.STATE_FILE || './data/state.json',
        maquinas: normalizarMaquinas(mapa?.machines),
    };
}

/**
 * De onde vêm as leituras: jkcontrol.online (padrão) ou Ubidots. As duas têm
 * dispositivo e variável com o mesmo papel, então o config.json não muda.
 */
function carregarFonte(env) {
    const tipo = env.SOURCE || 'jkcontrol';

    if (tipo === 'jkcontrol') {
        return {
            tipo,
            baseUrl: env.JKCONTROL_URL || 'https://jkcontrol.online',
            token: obrigatoria(env, 'JKCONTROL_TOKEN'),
        };
    }
    if (tipo === 'ubidots') {
        return {
            tipo,
            baseUrl: env.UBIDOTS_URL || 'https://industrial.api.ubidots.com',
            token: obrigatoria(env, 'UBIDOTS_TOKEN'),
        };
    }

    throw new Error(`SOURCE precisa ser "jkcontrol" ou "ubidots" (recebi "${tipo}").`);
}

/**
 * Cada máquina do config.json vira uma lista de séries (dispositivo/variável)
 * com o tipo de evento que cada uma gera.
 */
export function normalizarMaquinas(machines) {
    if (!Array.isArray(machines) || machines.length === 0) {
        throw new Error('config.json: "machines" precisa ser uma lista com pelo menos uma máquina.');
    }

    const chaves = new Set();

    return machines.map((m, i) => {
        const onde = `config.json machines[${i}]`;
        if (!m?.device || typeof m.device !== 'string') {
            throw new Error(`${onde}: "device" (label do dispositivo no jkcontrol ou na Ubidots) é obrigatório.`);
        }

        const series = [];
        const sinais = m.signals ?? [];
        if (!Array.isArray(sinais)) {
            throw new Error(`${onde}: "signals" precisa ser uma lista.`);
        }
        for (const s of sinais) {
            const variavel = typeof s === 'string' ? s : s?.variable;
            if (!variavel) throw new Error(`${onde}: item de "signals" sem nome de variável.`);

            // "accumulate" — a variável traz uma contagem que o contador do OpenMES
            // não entende direto (ele espera um total que só cresce):
            //  - "sum": contagem do período, que zera a cada envio → soma as parcelas;
            //  - "running": contagem corrente, que só zera num evento (troca de OP,
            //    reinício) e se repete enquanto a máquina está parada → soma só o
            //    que cresceu. "reset_field": campo do context cuja troca marca o zeramento.
            const acumular = typeof s === 'object' ? s.accumulate ?? null : null;
            if (acumular !== null && acumular !== 'sum' && acumular !== 'running') {
                throw new Error(`${onde}: "accumulate" de ${variavel} só aceita "sum" ou "running".`);
            }
            const campoZeramento = typeof s === 'object' ? s.reset_field ?? null : null;
            if (campoZeramento !== null && (acumular !== 'running' || typeof campoZeramento !== 'string' || !campoZeramento)) {
                throw new Error(`${onde}: "reset_field" de ${variavel} precisa ser o nome de um campo do context e só vale com "accumulate": "running".`);
            }

            series.push({
                variavel,
                tipo: 'sinal',
                nodeId: (typeof s === 'object' && s.node_id) || `${m.device}/${variavel}`,
                ...(acumular && { acumular: acumular === 'sum' ? 'soma' : 'corrente' }),
                ...(campoZeramento && { campoZeramento }),
            });
        }

        const ordem = variavelComCampo(m.order_variable, 'code_field', `${onde}: "order_variable"`);
        if (ordem) series.push({ ...ordem, tipo: 'ordem' });
        const operador = variavelComCampo(m.operator_variable, 'card_field', `${onde}: "operator_variable"`);
        if (operador) series.push({ ...operador, tipo: 'operador' });
        const motivo = variavelComCampo(m.reason_variable, 'code_field', `${onde}: "reason_variable"`);
        if (motivo) series.push({ ...motivo, tipo: 'motivo' });

        // Cartão de qualidade: o resultado vem num campo do context ("aprovado" / "reprovado").
        const qualidade = variavelComCampo(m.quality_variable, 'status_field', `${onde}: "quality_variable"`);
        if (qualidade) series.push({ ...qualidade, tipo: 'qualidade' });

        // Troca de molde/ferramenta: a parada daquele momento recebe um motivo fixo
        // e o crachá de quem trocou fica anotado nela.
        const troca = m.changeover_variable;
        if (troca) {
            const base = variavelComCampo(troca, 'card_field', `${onde}: "changeover_variable"`);
            if (typeof troca !== 'object' || typeof troca.reason_code !== 'string' || !troca.reason_code) {
                throw new Error(`${onde}: "changeover_variable" precisa de "reason_code" (código do motivo de parada da troca, ex.: "changeover").`);
            }
            series.push({ ...base, tipo: 'troca', codigoMotivo: troca.reason_code });
        }

        if (series.length === 0) {
            throw new Error(`${onde}: nada para ler — informe "signals", "operator_variable", "reason_variable" ou outra variável de cartão.`);
        }
        if (series.some((s) => s.tipo === 'sinal') && !Number.isInteger(m.connection_id)) {
            throw new Error(`${onde}: "connection_id" (conexão REST no OpenMES) é obrigatório quando há "signals".`);
        }
        if (series.some((s) => s.tipo !== 'sinal') && !Number.isInteger(m.workstation_id)) {
            throw new Error(`${onde}: "workstation_id" (máquina no OpenMES) é obrigatório para cartão e motivo de parada.`);
        }

        // "order_context_field": campo do context em que cada leitura de sinal
        // (ciclo, contagem) diz de qual OP ela é. Essa OP manda: o cartão de OP
        // pode se perder, o context de cada ciclo não.
        const campoOpContexto = m.order_context_field ?? null;
        if (campoOpContexto !== null) {
            if (typeof campoOpContexto !== 'string' || !campoOpContexto) {
                throw new Error(`${onde}: "order_context_field" precisa ser o nome de um campo do context (ex.: "op_rfid").`);
            }
            if (!Number.isInteger(m.workstation_id)) {
                throw new Error(`${onde}: "workstation_id" (máquina no OpenMES) é obrigatório com "order_context_field".`);
            }
        }

        for (const s of series) {
            const chave = `${m.device}/${s.variavel}`;
            if (chaves.has(chave)) throw new Error(`${onde}: ${chave} aparece mais de uma vez.`);
            chaves.add(chave);
        }

        return {
            dispositivo: m.device,
            estacaoId: m.workstation_id ?? null,
            conexaoId: m.connection_id ?? null,
            series,
            ...(campoOpContexto && { campoOpContexto }),
        };
    });
}

/**
 * Cartão e motivo: o nome da variável ("operador") ou um objeto que diz em qual
 * campo do context vem o UID/código, para firmwares que não seguem o contrato
 * padrão — ex.: {"variable": "fun_rfid", "card_field": "fun_rfid"}.
 */
function variavelComCampo(valor, nomeDoCampo, onde) {
    if (!valor) return null;
    if (typeof valor === 'string') return { variavel: valor };

    if (typeof valor !== 'object' || typeof valor.variable !== 'string' || !valor.variable) {
        throw new Error(`${onde} precisa ser o nome da variável ou {"variable": "...", "${nomeDoCampo}": "..."}.`);
    }
    const campo = valor[nomeDoCampo];
    if (campo !== undefined && (typeof campo !== 'string' || !campo)) {
        throw new Error(`${onde}: "${nomeDoCampo}" precisa ser o nome de um campo do context.`);
    }

    return { variavel: valor.variable, ...(campo && { campo }) };
}

function obrigatoria(env, nome) {
    const valor = env[nome];
    if (!valor) throw new Error(`Variável ${nome} não configurada (veja .env.example).`);
    return valor;
}

function inteiro(valor, padrao, nome) {
    if (valor === undefined || valor === '') return padrao;
    const n = Number(valor);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${nome} precisa ser um inteiro positivo (recebi "${valor}").`);
    return n;
}
