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
        jkcontrol: {
            baseUrl: env.JKCONTROL_URL || 'https://jkcontrol.online',
            token: obrigatoria(env, 'JKCONTROL_TOKEN'),
        },
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
            throw new Error(`${onde}: "device" (label do dispositivo no jkcontrol) é obrigatório.`);
        }

        const series = [];
        const sinais = m.signals ?? [];
        if (!Array.isArray(sinais)) {
            throw new Error(`${onde}: "signals" precisa ser uma lista.`);
        }
        for (const s of sinais) {
            const variavel = typeof s === 'string' ? s : s?.variable;
            if (!variavel) throw new Error(`${onde}: item de "signals" sem nome de variável.`);
            series.push({ variavel, tipo: 'sinal', nodeId: (typeof s === 'object' && s.node_id) || `${m.device}/${variavel}` });
        }
        if (m.operator_variable) series.push({ variavel: m.operator_variable, tipo: 'operador' });
        if (m.reason_variable) series.push({ variavel: m.reason_variable, tipo: 'motivo' });

        if (series.length === 0) {
            throw new Error(`${onde}: nada para ler — informe "signals", "operator_variable" ou "reason_variable".`);
        }
        if (series.some((s) => s.tipo === 'sinal') && !Number.isInteger(m.connection_id)) {
            throw new Error(`${onde}: "connection_id" (conexão REST no OpenMES) é obrigatório quando há "signals".`);
        }
        if (series.some((s) => s.tipo !== 'sinal') && !Number.isInteger(m.workstation_id)) {
            throw new Error(`${onde}: "workstation_id" (máquina no OpenMES) é obrigatório para cartão e motivo de parada.`);
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
        };
    });
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
