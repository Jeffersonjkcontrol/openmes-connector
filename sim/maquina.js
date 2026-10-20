// Máquina simulada: publica no simulador o que o leitor da máquina publicaria
// no jkcontrol — estado, contadores acumulados, cartão RFID e motivo de parada.
//
//   node sim/maquina.js historico [minutos]   um turno de exemplo terminando agora (padrão 40 min)
//   node sim/maquina.js ao-vivo               continua produzindo, parando e retomando (Ctrl+C para)
//
// Variáveis: SIM_URL (http://localhost:8090), DISPOSITIVO (torno01),
// CARTAO (04:A1:B2:C3), MOTIVO (12), PASSO_SEGUNDOS (5, só no ao-vivo).

import { setTimeout as esperar } from 'node:timers/promises';

const SIM_URL = process.env.SIM_URL || 'http://localhost:8090';
const DISPOSITIVO = process.env.DISPOSITIVO || 'torno01';
const CARTAO = process.env.CARTAO || '04:A1:B2:C3';
const MOTIVO = Number(process.env.MOTIVO || 12);
const PASSO_MS = Number(process.env.PASSO_SEGUNDOS || 5) * 1000;

const PARADA = 0;
const RODANDO = 1;
const FALHA = 2;

/** O jkcontrol guarda só a última leitura de uma variável em 250 ms: o firmware espaça as publicações. */
const INTERVALO_ENTRE_PUBLICACOES_MS = 300;

async function chamar(metodo, caminho, corpo) {
    const resposta = await fetch(new URL(caminho, SIM_URL), {
        method: metodo,
        headers: corpo ? { 'Content-Type': 'application/json' } : {},
        body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const json = await resposta.json();
    if (!resposta.ok) throw new Error(`${metodo} ${caminho}: ${json.message}`);
    return json;
}

async function publicar(variable, value, { context, quando } = {}) {
    await chamar('POST', '/sim/publicar', {
        device: DISPOSITIVO,
        variable,
        value,
        context,
        timestamp: quando?.getTime(),
    });
    const hora = (quando ?? new Date()).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    console.log(`${hora}  ${DISPOSITIVO}/${variable} = ${value}${context ? ` ${JSON.stringify(context)}` : ''}`);
    await esperar(INTERVALO_ENTRE_PUBLICACOES_MS);
}

async function ultimoValor(variable) {
    const { data } = await chamar('GET', `/sim/ultimo?device=${DISPOSITIVO}&variable=${variable}`);
    return data;
}

/**
 * Um turno de exemplo, com cada evento no horário em que teria acontecido
 * (como o dispositivo que guarda eventos offline e manda com o timestamp real):
 * login, produção, uma parada com o motivo digitado, uma falha com motivo por
 * código de letras, logout e a máquina parada no fim.
 */
async function historico(minutos) {
    const existentes = (await chamar('GET', '/sim/series')).filter((s) => s.serie.startsWith(`${DISPOSITIVO}/`));
    if (existentes.length > 0) {
        throw new Error(`${DISPOSITIVO} já tem leituras no simulador; o histórico só vale para um dispositivo novo (use "ao-vivo").`);
    }

    const inicio = Date.now() - minutos * 60_000;
    const em = (fracao) => new Date(inicio + fracao * minutos * 60_000);

    const roteiro = [
        { em: 0, variavel: 'operador', valor: 1, context: { uid: CARTAO } },
        { em: 0, variavel: 'estado', valor: RODANDO },
        { em: 0.30, variavel: 'estado', valor: PARADA },
        { em: 0.33, variavel: 'motivo_parada', valor: MOTIVO },
        { em: 0.45, variavel: 'estado', valor: RODANDO },
        { em: 0.65, variavel: 'estado', valor: FALHA },
        { em: 0.68, variavel: 'motivo_parada', valor: 1, context: { reason_code: 'breakdown' } },
        { em: 0.78, variavel: 'estado', valor: RODANDO },
        { em: 0.95, variavel: 'estado', valor: PARADA },
        { em: 0.98, variavel: 'operador', valor: 0, context: { uid: CARTAO } },
    ];

    // Contadores: um total acumulado por minuto enquanto a máquina roda.
    let produzido = 0;
    let refugo = 0;
    let estado = PARADA;
    for (let m = 0; m < minutos; m += 1) {
        for (const e of roteiro.filter((r) => Math.round(r.em * minutos) === m)) {
            if (e.variavel === 'estado') estado = e.valor;
        }
        if (estado !== RODANDO) continue;
        produzido += 6 + (m % 3);
        roteiro.push({ em: (m + 0.5) / minutos, variavel: 'produzido', valor: produzido });
        if (m % 7 === 3) {
            refugo += 1;
            roteiro.push({ em: (m + 0.5) / minutos, variavel: 'refugo', valor: refugo });
        }
    }

    roteiro.sort((a, b) => a.em - b.em);
    for (const e of roteiro) {
        await publicar(e.variavel, e.valor, { context: e.context, quando: em(e.em) });
    }

    console.log(`\nturno de ${minutos} min publicado: ${produzido} peças boas, ${refugo} refugo.`);
}

/** Produção contínua: a cada passo produz, às vezes para; parada recebe o motivo e retoma. */
async function aoVivo() {
    let produzido = (await ultimoValor('produzido'))?.value ?? 0;
    let refugo = (await ultimoValor('refugo'))?.value ?? 0;
    const operador = await ultimoValor('operador');

    if (operador?.value !== 1) await publicar('operador', 1, { context: { uid: CARTAO } });
    await publicar('estado', RODANDO);

    let parada = null;
    let parar = false;
    for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => { parar = true; });

    while (!parar) {
        await esperar(PASSO_MS);

        if (parada) {
            parada.passos += 1;
            if (parada.passos === 2) await publicar('motivo_parada', MOTIVO);
            if (parada.passos === 4) {
                await publicar('estado', RODANDO);
                parada = null;
            }
            continue;
        }

        produzido += 1 + Math.floor(Math.random() * 3);
        await publicar('produzido', produzido);
        if (Math.random() < 0.1) await publicar('refugo', (refugo += 1));
        if (Math.random() < 0.08) {
            await publicar('estado', PARADA);
            parada = { passos: 0 };
        }
    }

    await publicar('estado', PARADA);
    await publicar('operador', 0, { context: { uid: CARTAO } });
}

const [modo = 'historico', argumento] = process.argv.slice(2);
try {
    if (modo === 'historico') await historico(Number(argumento || 40));
    else if (modo === 'ao-vivo') await aoVivo();
    else throw new Error(`modo "${modo}" desconhecido (use historico ou ao-vivo).`);
} catch (erro) {
    console.error(erro.message);
    process.exit(1);
}
