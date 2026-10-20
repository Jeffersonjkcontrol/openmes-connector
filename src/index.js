import { setTimeout as esperar } from 'node:timers/promises';
import { carregarConfig } from './config.js';
import { JkControlClient } from './jkcontrol.js';
import { log } from './log.js';
import { OpenMesClient } from './openmes.js';
import { Estado } from './state.js';
import { executarCiclo } from './sync.js';

// .env é opcional (no Docker as variáveis já vêm do ambiente).
try {
    process.loadEnvFile?.('.env');
} catch {
    // sem .env
}

const umaVez = process.argv.includes('--once');

let config;
try {
    config = carregarConfig();
} catch (erro) {
    log.error(erro.message);
    process.exit(1);
}

const jk = new JkControlClient({ ...config.jkcontrol, porPagina: config.porPagina });
const mes = new OpenMesClient(config.openmes);
const estado = new Estado(config.arquivoEstado);

let parar = false;
const interromperEspera = new AbortController();
for (const sinal of ['SIGINT', 'SIGTERM']) {
    process.on(sinal, () => {
        log.info(`${sinal} recebido — encerrando após o ciclo atual.`);
        parar = true;
        interromperEspera.abort();
    });
}

log.info(`conector iniciado: ${config.maquinas.length} máquina(s), ciclo a cada ${config.intervaloMs / 1000}s, fuso ${config.fuso}.`);

let falhasSeguidas = 0;
while (!parar) {
    try {
        const r = await executarCiclo({ config, jk, mes, estado, log });
        if (r.sinais || r.ordem || r.operador || r.motivo || r.descartados) {
            log.info(`ciclo: ${r.sinais} sinal(is), ${r.ordem} OP(s), ${r.operador} cartão(ões), ${r.motivo} motivo(s), ${r.descartados} descartado(s).`);
        }
        falhasSeguidas = 0;
    } catch (erro) {
        falhasSeguidas += 1;
        log.error(`ciclo interrompido (${falhasSeguidas}ª falha seguida): ${erro.message}`);
    }

    if (umaVez) break;

    // Espera mais quando o OpenMES ou o jkcontrol estão fora (até 5 min).
    const espera = Math.min(config.intervaloMs * 2 ** Math.min(falhasSeguidas, 5), 300_000);
    await esperar(espera, undefined, { signal: interromperEspera.signal }).catch(() => {});
}

process.exit(umaVez && falhasSeguidas > 0 ? 1 : 0);
