import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizarMaquinas } from '../src/config.js';
import { ErroHttp } from '../src/http.js';
import { silencioso } from '../src/log.js';
import { Estado } from '../src/state.js';
import { LOTE_MAXIMO, executarCiclo } from '../src/sync.js';

const T = (hhmmss) => new Date(`2026-10-19T${hhmmss}.000Z`);

function configCom(maquinas) {
    return {
        fuso: 'America/Sao_Paulo',
        sobreposicaoMs: 15 * 60_000,
        retroativoInicialMs: 60 * 60_000,
        maquinas: normalizarMaquinas(maquinas),
    };
}

const injetora = {
    device: 'injetora01',
    workstation_id: 3,
    connection_id: 1,
    signals: ['estado', 'produzido'],
    operator_variable: 'operador',
    reason_variable: 'motivo_parada',
};

/** jkcontrol de mentira: séries em memória, filtradas pela janela pedida. */
class JkFalso {
    constructor(series) {
        this.series = series;
        this.pedidos = [];
    }

    adicionar(chave, item) {
        (this.series[chave] ??= []).push(item);
    }

    async leituras(dispositivo, variavel, desde, ate) {
        this.pedidos.push({ chave: `${dispositivo}/${variavel}`, desde, ate });
        const itens = this.series[`${dispositivo}/${variavel}`];
        if (!itens) throw new ErroHttp(404, { message: 'Device not found' }, 'jk');
        return itens
            .filter((i) => i.ts >= desde && i.ts <= ate)
            .map((i) => ({ context: {}, ...i }))
            .sort((a, b) => a.ts - b.ts);
    }
}

/** OpenMES de mentira: registra a ordem das chamadas e falha quando mandado. */
class MesFalso {
    constructor() {
        this.chamadas = [];
        this.falhas = { sinais: [], ordem: [], operador: [], motivo: [], qualidade: [] };
        this.respostasOrdem = {};
    }

    registrar(tipo, dados) {
        const falha = this.falhas[tipo].shift();
        if (falha) throw falha;
        this.chamadas.push({ tipo, ...dados });
    }

    async enviarSinais(conexaoId, leituras) {
        this.registrar('sinais', { conexaoId, leituras });
        return { accepted: leituras.length };
    }

    async eventoOperador(payload) {
        this.registrar('operador', payload);
        return { status: payload.action === 'login' ? 'logged_in' : 'logged_out' };
    }

    async iniciarOrdem(estacaoId, payload) {
        this.registrar('ordem', { estacaoId, ...payload });
        return this.respostasOrdem[payload.order_no] ?? { status: 'started' };
    }

    async registrarQualidade(estacaoId, payload) {
        this.registrar('qualidade', { estacaoId, ...payload });
        return { status: 'recorded', data: { order_no: '500101' } };
    }

    async motivoParada(estacaoId, payload) {
        this.registrar('motivo', { estacaoId, ...payload });
        return { data: { downtime_id: 7 } };
    }

    async heartbeat(conexaoId) {
        this.chamadas.push({ tipo: 'heartbeat', conexaoId });
    }

    entregas() {
        return this.chamadas.filter((c) => c.tipo !== 'heartbeat');
    }
}

function cenario(series, maquinas = [injetora]) {
    const jk = new JkFalso(series);
    const mes = new MesFalso();
    const estado = new Estado(null);
    const avisos = [];
    const log = { ...silencioso, warn: (m) => avisos.push(m), error: (m) => avisos.push(m) };
    const config = configCom(maquinas);
    const ciclo = (agora) => executarCiclo({ config, jk, mes, estado, log, agora });
    return { jk, mes, estado, avisos, ciclo };
}

test('entrega na ordem do horário; no mesmo instante o estado vem antes do motivo', async () => {
    const { mes, ciclo } = cenario({
        'injetora01/produzido': [{ id: 'p1', ts: T('09:58:00'), value: 100 }],
        'injetora01/operador': [{ id: 'o1', ts: T('09:59:00'), value: 1, context: { uid: '04A1B2C3' } }],
        'injetora01/estado': [
            { id: 'e1', ts: T('10:00:00'), value: 0 },
            { id: 'e2', ts: T('10:05:00'), value: 1 },
        ],
        'injetora01/motivo_parada': [{ id: 'm1', ts: T('10:00:00'), value: 12 }],
    });

    await ciclo(T('10:06:00'));

    assert.deepEqual(mes.entregas().map((c) => c.tipo), ['sinais', 'operador', 'sinais', 'motivo', 'sinais']);

    const [produzido, operador, parada, motivo, retomada] = mes.entregas();
    assert.deepEqual(produzido.leituras, [
        { node_id: 'injetora01/produzido', value: 100, ts: '2026-10-19T06:58:00.000-03:00', event_id: 'p1' },
    ]);
    assert.deepEqual(operador, {
        tipo: 'operador', card_uid: '04A1B2C3', action: 'login', workstation_id: 3, occurred_at: '2026-10-19T06:59:00.000-03:00',
    });
    assert.equal(parada.leituras[0].value, 0);
    assert.deepEqual(motivo, { tipo: 'motivo', estacaoId: 3, reason_code: '12', occurred_at: '2026-10-19T07:00:00.000-03:00' });
    assert.equal(retomada.leituras[0].event_id, 'e2');
});

test('sinais seguidos da mesma conexão vão num lote só', async () => {
    const { mes, ciclo } = cenario({
        'injetora01/estado': [{ id: 'e1', ts: T('10:00:00'), value: 1 }],
        'injetora01/produzido': [
            { id: 'p1', ts: T('10:01:00'), value: 10 },
            { id: 'p2', ts: T('10:02:00'), value: 20 },
        ],
    }, [{ ...injetora, operator_variable: undefined, reason_variable: undefined }]);

    await ciclo(T('10:03:00'));

    assert.equal(mes.entregas().length, 1);
    assert.deepEqual(mes.entregas()[0].leituras.map((l) => l.event_id), ['e1', 'p1', 'p2']);
});

test('o que a janela de sobreposição relê não é reenviado', async () => {
    const { jk, mes, ciclo } = cenario({ 'injetora01/estado': [{ id: 'e1', ts: T('10:00:00'), value: 1 }] },
        [{ device: 'injetora01', connection_id: 1, signals: ['estado'] }]);

    await ciclo(T('10:01:00'));
    jk.adicionar('injetora01/estado', { id: 'e2', ts: T('10:01:10'), value: 0 });
    await ciclo(T('10:01:15'));

    const enviados = mes.entregas().flatMap((c) => c.leituras.map((l) => l.event_id));
    assert.deepEqual(enviados, ['e1', 'e2']);

    // O segundo ciclo releu a partir de cursor − sobreposição.
    assert.equal(jk.pedidos[1].desde.toISOString(), '2026-10-19T09:46:00.000Z');
});

test('o primeiro ciclo lê o período retroativo inicial', async () => {
    const { jk, ciclo } = cenario({ 'injetora01/estado': [] }, [{ device: 'injetora01', connection_id: 1, signals: ['estado'] }]);

    await ciclo(T('10:00:00'));

    assert.equal(jk.pedidos[0].desde.toISOString(), '2026-10-19T09:00:00.000Z');
    assert.equal(jk.pedidos[0].ate.toISOString(), '2026-10-19T10:00:00.000Z');
});

test('falha temporária interrompe o ciclo; na próxima vez só vai o que faltou', async () => {
    const { mes, estado, ciclo } = cenario({
        'injetora01/estado': [{ id: 'e1', ts: T('10:00:00'), value: 0 }],
        'injetora01/motivo_parada': [{ id: 'm1', ts: T('10:01:00'), value: 12 }],
    }, [{ ...injetora, operator_variable: undefined, signals: ['estado'] }]);

    mes.falhas.motivo.push(new ErroHttp(503, 'indisponível', 'mes'));

    await assert.rejects(ciclo(T('10:02:00')), /HTTP 503/);
    assert.equal(estado.serie('injetora01/estado').cursor, null, 'cursor não avança em ciclo interrompido');

    await ciclo(T('10:02:15'));

    assert.deepEqual(mes.entregas().map((c) => c.tipo), ['sinais', 'motivo']);
    assert.equal(estado.serie('injetora01/estado').cursor, '2026-10-19T10:02:15.000Z');
});

test('recusa definitiva (422) é descartada e não trava a fila', async () => {
    const { mes, avisos, ciclo } = cenario({
        'injetora01/operador': [{ id: 'o1', ts: T('10:00:00'), value: 1, context: { uid: 'DEADBEEF' } }],
        'injetora01/estado': [{ id: 'e1', ts: T('10:01:00'), value: 1 }],
    }, [{ ...injetora, reason_variable: undefined, signals: ['estado'] }]);

    mes.falhas.operador.push(new ErroHttp(422, { message: 'No active worker has this card.' }, 'mes'));

    const r = await ciclo(T('10:02:00'));
    await ciclo(T('10:02:15'));

    assert.deepEqual(mes.entregas().map((c) => c.tipo), ['sinais']);
    assert.equal(r.descartados, 1);
    assert.match(avisos.join('\n'), /No active worker has this card/);
});

test('leitura de sinal mais antiga que a última entregue é ignorada', async () => {
    const { jk, mes, avisos, ciclo } = cenario({ 'injetora01/estado': [{ id: 'e2', ts: T('10:05:00'), value: 1 }] },
        [{ device: 'injetora01', connection_id: 1, signals: ['estado'] }]);

    await ciclo(T('10:06:00'));
    // Chegou atrasada (dispositivo estava sem rede), com horário anterior.
    jk.adicionar('injetora01/estado', { id: 'e1', ts: T('10:01:00'), value: 0 });
    await ciclo(T('10:06:15'));

    assert.deepEqual(mes.entregas().flatMap((c) => c.leituras.map((l) => l.event_id)), ['e2']);
    assert.match(avisos.join('\n'), /injetora01\/estado: 1 leitura/);
});

test('motivo que chega atrasado ainda é entregue (o OpenMES acha a parada pelo horário)', async () => {
    const { jk, mes, ciclo } = cenario({ 'injetora01/motivo_parada': [{ id: 'm2', ts: T('10:05:00'), value: 15 }] },
        [{ device: 'injetora01', workstation_id: 3, reason_variable: 'motivo_parada' }]);

    await ciclo(T('10:06:00'));
    jk.adicionar('injetora01/motivo_parada', { id: 'm1', ts: T('10:01:00'), value: 12 });
    await ciclo(T('10:06:15'));

    assert.deepEqual(mes.entregas().map((c) => [c.reason_code, c.occurred_at]), [
        ['15', '2026-10-19T07:05:00.000-03:00'],
        ['12', '2026-10-19T07:01:00.000-03:00'],
    ]);
});

test('cartão sem UID, valor estranho e motivo 0 são ignorados com aviso', async () => {
    const { mes, avisos, ciclo } = cenario({
        'injetora01/operador': [
            { id: 'o1', ts: T('10:00:00'), value: 1 },
            { id: 'o2', ts: T('10:00:01'), value: 7, context: { uid: 'A1' } },
        ],
        'injetora01/motivo_parada': [{ id: 'm1', ts: T('10:00:02'), value: 0 }],
    }, [{ device: 'injetora01', workstation_id: 3, operator_variable: 'operador', reason_variable: 'motivo_parada' }]);

    const r = await ciclo(T('10:01:00'));

    assert.equal(mes.entregas().length, 0);
    assert.equal(r.descartados, 3);
    assert.match(avisos.join('\n'), /sem o UID/);
    assert.match(avisos.join('\n'), /valor 7/);
    assert.match(avisos.join('\n'), /motivo 0/);
});

test('motivo com letras pode vir em context.reason_code', async () => {
    const { mes, ciclo } = cenario({ 'injetora01/motivo_parada': [{ id: 'm1', ts: T('10:00:00'), value: 1, context: { reason_code: 'MAT-01' } }] },
        [{ device: 'injetora01', workstation_id: 3, reason_variable: 'motivo_parada' }]);

    await ciclo(T('10:01:00'));

    assert.equal(mes.entregas()[0].reason_code, 'MAT-01');
});

// Firmware que conta por período (zera a cada envio) e manda cartões com o
// código num campo próprio do context (fun_rfid / maq_rfid).
const porPeriodo = {
    device: 'injetora000',
    workstation_id: 9,
    connection_id: 2,
    signals: ['parada', { variable: 'injecao_hora', accumulate: 'sum' }],
    operator_variable: { variable: 'fun_rfid', card_field: 'fun_rfid' },
    reason_variable: { variable: 'maq_rfid', code_field: 'maq_rfid' },
};
// Firmware Nitron: injecao_hora é a contagem corrente da OP (republicada a cada
// 15 min, zera quando passa um cartão de OP), com a OP em context.op_rfid.
const nitron = {
    ...porPeriodo,
    signals: ['parada', { variable: 'injecao_hora', accumulate: 'running', reset_field: 'op_rfid' }],
};
const valoresContador = (mes) => mes.entregas()
    .flatMap((c) => c.leituras ?? [])
    .filter((l) => l.node_id === 'injetora000/injecao_hora')
    .map((l) => l.value);

test('contagem por período vira total acumulado, com base 0, e continua no ciclo seguinte', async () => {
    const { jk, mes, estado, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/fun_rfid': [],
        'injetora000/maq_rfid': [],
        'injetora000/injecao_hora': [
            { id: 'h1', ts: T('10:00:00'), value: 5 },
            { id: 'h2', ts: T('10:15:00'), value: 0 },
            { id: 'h3', ts: T('10:30:00'), value: 7 },
        ],
    }, [porPeriodo]);

    await ciclo(T('10:31:00'));
    jk.adicionar('injetora000/injecao_hora', { id: 'h4', ts: T('10:45:00'), value: 3 });
    await ciclo(T('10:46:00'));

    // Base 0 antes da primeira parcela; o período parado (0) repete o total;
    // a sobreposição não soma de novo.
    assert.deepEqual(valoresContador(mes), [0, 5, 5, 12, 15]);
    assert.equal(estado.total('injetora000/injecao_hora'), 15);
});

test('primeira contagem 0 já serve de base', async () => {
    const { mes, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/fun_rfid': [],
        'injetora000/maq_rfid': [],
        'injetora000/injecao_hora': [
            { id: 'h1', ts: T('10:00:00'), value: 0 },
            { id: 'h2', ts: T('10:15:00'), value: 6 },
        ],
    }, [porPeriodo]);

    await ciclo(T('10:16:00'));

    assert.deepEqual(valoresContador(mes), [0, 6]);
});

test('contagem atrasada ainda soma, com o horário da última entregue', async () => {
    const { jk, mes, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/fun_rfid': [],
        'injetora000/maq_rfid': [],
        'injetora000/injecao_hora': [{ id: 'h2', ts: T('10:30:00'), value: 4 }],
    }, [porPeriodo]);

    await ciclo(T('10:31:00'));
    // Veio da fila offline do equipamento, com o horário em que foi contada.
    jk.adicionar('injetora000/injecao_hora', { id: 'h1', ts: T('10:20:00'), value: 2 });
    await ciclo(T('10:32:00'));

    const leituras = mes.entregas().flatMap((c) => c.leituras ?? []);
    assert.deepEqual(leituras.map((l) => [l.value, l.ts]), [
        [0, '2026-10-19T07:30:00.000-03:00'],
        [4, '2026-10-19T07:30:00.000-03:00'],
        [6, '2026-10-19T07:30:00.000-03:00'],
    ]);
});

test('falha temporária não perde nem duplica a contagem', async () => {
    const { mes, estado, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/fun_rfid': [],
        'injetora000/maq_rfid': [],
        'injetora000/injecao_hora': [{ id: 'h1', ts: T('10:00:00'), value: 5 }],
    }, [porPeriodo]);

    mes.falhas.sinais.push(new ErroHttp(503, 'indisponível', 'mes'));
    await assert.rejects(ciclo(T('10:01:00')), /HTTP 503/);
    assert.equal(estado.total('injetora000/injecao_hora'), 0, 'total só grava o que foi entregue');

    await ciclo(T('10:01:15'));
    assert.deepEqual(valoresContador(mes), [0, 5]);
    assert.equal(estado.total('injetora000/injecao_hora'), 5);
});

test('contagem negativa ou não numérica é ignorada com aviso', async () => {
    const { mes, avisos, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/fun_rfid': [],
        'injetora000/maq_rfid': [],
        'injetora000/injecao_hora': [
            { id: 'h1', ts: T('10:00:00'), value: -3 },
            { id: 'h2', ts: T('10:15:00'), value: 4 },
        ],
    }, [porPeriodo]);

    const r = await ciclo(T('10:16:00'));

    assert.deepEqual(valoresContador(mes), [0, 4]);
    assert.equal(r.descartados, 1);
    assert.match(avisos.join('\n'), /contagem -3 inválida/);
});

const semCartoes = { 'injetora000/parada': [], 'injetora000/fun_rfid': [], 'injetora000/maq_rfid': [] };
const op = (codigo) => ({ op_rfid: codigo });

test('contagem corrente: o total repetido não soma, só o que cresceu; a troca de OP zera', async () => {
    const { jk, mes, estado, ciclo } = cenario({
        ...semCartoes,
        'injetora000/injecao_hora': [
            { id: 'h1', ts: T('10:00:00'), value: 40, context: op('500101') }, // base: contado antes
            { id: 'h2', ts: T('10:15:00'), value: 40, context: op('500101') }, // máquina parada
            { id: 'h3', ts: T('10:30:00'), value: 55, context: op('500101') },
            { id: 'h4', ts: T('10:37:00'), value: 60, context: op('500101') }, // fecha a OP no cartão
            { id: 'h5', ts: T('10:45:00'), value: 12, context: op('500102') }, // nova OP, desde 0
        ],
    }, [nitron]);

    await ciclo(T('10:46:00'));
    jk.adicionar('injetora000/injecao_hora', { id: 'h6', ts: T('11:00:00'), value: 30, context: op('500102') });
    await ciclo(T('11:01:00'));

    assert.deepEqual(valoresContador(mes), [0, 0, 15, 20, 32, 50]);
    assert.equal(estado.total('injetora000/injecao_hora'), 50);
    assert.deepEqual(estado.corrente('injetora000/injecao_hora'), { valor: 30, marca: '500102' });
});

test('contagem corrente: OP nova zera mesmo quando o valor não cai', async () => {
    const { mes, ciclo } = cenario({
        ...semCartoes,
        'injetora000/injecao_hora': [
            { id: 'h1', ts: T('10:00:00'), value: 50, context: op('500101') },
            { id: 'h2', ts: T('10:15:00'), value: 70, context: op('500102') },
        ],
    }, [nitron]);

    await ciclo(T('10:16:00'));

    assert.deepEqual(valoresContador(mes), [0, 70]);
});

test('contagem corrente: context sem a OP (cartão de molde) não é troca de OP', async () => {
    const { mes, estado, ciclo } = cenario({
        ...semCartoes,
        'injetora000/injecao_hora': [
            { id: 'h1', ts: T('10:05:00'), value: 20, context: op('500101') },
            { id: 'h2', ts: T('10:15:00'), value: 33, context: op('500101') },
            // Cartão de molde: o firmware troca o context e mantém a contagem.
            { id: 'h3', ts: T('10:30:00'), value: 33, context: { molde: 'MOLDE-TESTE' } },
            { id: 'h4', ts: T('10:45:00'), value: 0, context: {} },
            { id: 'h5', ts: T('11:00:00'), value: 4, context: op('500102') },
        ],
    }, [nitron]);

    await ciclo(T('11:01:00'));

    assert.deepEqual(valoresContador(mes), [0, 13, 13, 13, 17]);
    assert.deepEqual(estado.corrente('injetora000/injecao_hora'), { valor: 4, marca: '500102' });
});

test('contagem corrente sem reset_field: valor que cai é zeramento', async () => {
    const { mes, ciclo } = cenario({
        ...semCartoes,
        'injetora000/injecao_hora': [
            { id: 'h1', ts: T('10:00:00'), value: 30 },
            { id: 'h2', ts: T('10:15:00'), value: 35 },
            { id: 'h3', ts: T('10:30:00'), value: 4 },
        ],
    }, [{ ...nitron, signals: ['parada', { variable: 'injecao_hora', accumulate: 'running' }] }]);

    await ciclo(T('10:31:00'));

    assert.deepEqual(valoresContador(mes), [0, 5, 9]);
});

test('contagem corrente atrasada é ignorada: a leitura seguinte já a inclui', async () => {
    const { jk, mes, avisos, ciclo } = cenario({
        ...semCartoes,
        'injetora000/injecao_hora': [{ id: 'h2', ts: T('10:30:00'), value: 20, context: op('500101') }],
    }, [nitron]);

    await ciclo(T('10:31:00'));
    jk.adicionar('injetora000/injecao_hora', { id: 'h1', ts: T('10:20:00'), value: 15, context: op('500101') });
    const r = await ciclo(T('10:32:00'));

    assert.deepEqual(valoresContador(mes), [0]);
    assert.equal(r.descartados, 1);
    assert.match(avisos.join('\n'), /injecao_hora: 1 leitura\(s\) mais antiga/);
});

test('contagem corrente com a base no estado: a primeira leitura conta inteira, depois de uma base 0', async () => {
    const { mes, estado, ciclo } = cenario({
        ...semCartoes,
        'injetora000/injecao_hora': [
            { id: 'h1', ts: T('10:00:00'), value: 27, context: op('500101') },
            { id: 'h2', ts: T('10:15:00'), value: 27, context: op('500101') },
            { id: 'h3', ts: T('10:30:00'), value: 40, context: op('500101') },
        ],
    }, [nitron]);

    // Reexecução desde a primeira leitura do equipamento: antes dela, a contagem era 0.
    estado.definirCorrente('injetora000/injecao_hora', { valor: 0, marca: '' });
    await ciclo(T('10:31:00'));

    assert.deepEqual(valoresContador(mes), [0, 27, 27, 40]);
    assert.equal(estado.total('injetora000/injecao_hora'), 40);
});

test('contagem corrente: falha temporária não avança a base', async () => {
    const { mes, estado, ciclo } = cenario({
        ...semCartoes,
        'injetora000/injecao_hora': [
            { id: 'h1', ts: T('10:00:00'), value: 10, context: op('500101') },
            { id: 'h2', ts: T('10:15:00'), value: 18, context: op('500101') },
        ],
    }, [nitron]);

    mes.falhas.sinais.push(new ErroHttp(503, 'indisponível', 'mes'));
    await assert.rejects(ciclo(T('10:16:00')), /HTTP 503/);
    assert.equal(estado.corrente('injetora000/injecao_hora'), null, 'a base só grava o que foi entregue');

    await ciclo(T('10:16:15'));
    assert.deepEqual(valoresContador(mes), [0, 8]);
});

test('cartão e código de motivo podem vir em campos próprios do context', async () => {
    const { mes, avisos, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/injecao_hora': [],
        'injetora000/fun_rfid': [
            { id: 'f1', ts: T('10:00:00'), value: 1, context: { fun_rfid: '7788' } },
            { id: 'f2', ts: T('10:00:30'), value: 1, context: { uid: '444' } },
        ],
        // O valor é sempre 1 no cartão MAQ: o código está só no context.
        'injetora000/maq_rfid': [{ id: 'q1', ts: T('10:01:00'), value: 1, context: { maq_rfid: '3101' } }],
    }, [nitron]);

    const r = await ciclo(T('10:02:00'));

    const [login, motivo] = mes.entregas();
    assert.equal(login.card_uid, '7788');
    assert.equal(login.action, 'login');
    assert.equal(motivo.reason_code, '3101');
    assert.equal(motivo.estacaoId, 9);
    assert.equal(r.descartados, 1);
    assert.match(avisos.join('\n'), /sem o UID do cartão em context\.fun_rfid/);
});

test('cartão de OP inicia a ordem no posto, depois da contagem que fecha a anterior', async () => {
    const { mes, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/fun_rfid': [],
        'injetora000/maq_rfid': [],
        // O firmware fecha a contagem da OP anterior e publica a nova OP em seguida.
        'injetora000/injecao_hora': [{ id: 'h1', ts: T('10:00:00'), value: 40, context: { op_rfid: '500101' } }],
        'injetora000/op_rfid': [
            { id: 'o1', ts: T('10:00:00'), value: 1, context: { op_rfid: '500102' } },
            { id: 'o2', ts: T('10:05:00'), value: 1, context: {} },
        ],
    }, [{ ...nitron, order_variable: { variable: 'op_rfid', code_field: 'op_rfid' } }]);

    const r = await ciclo(T('10:06:00'));

    assert.deepEqual(mes.entregas().map((c) => c.tipo), ['sinais', 'ordem']);
    const ordem = mes.entregas()[1];
    assert.deepEqual(ordem, { tipo: 'ordem', estacaoId: 9, order_no: '500102', occurred_at: '2026-10-19T07:00:00.000-03:00' });
    assert.equal(r.ordem, 1);
    assert.equal(r.descartados, 1, 'cartão de OP sem número é ignorado');
});

// Firmware que publica a OP no context de cada ciclo e de cada contagem.
const comOpDoContexto = {
    device: 'inj07',
    workstation_id: 7,
    connection_id: 4,
    signals: ['parada', { variable: 'injecao_hora', accumulate: 'running', reset_field: 'op_rfid' }, 'ciclo'],
    order_variable: { variable: 'op_rfid', code_field: 'op_rfid' },
    order_context_field: 'op_rfid',
};
const leitura = (id, hhmmss, value, codigo) => ({ id, ts: T(hhmmss), value, context: op(codigo) });
const ordens = (mes) => mes.entregas().filter((c) => c.tipo === 'ordem');

test('OP do context: a troca entra antes da leitura que traz a OP nova, mesmo sem cartão', async () => {
    const { jk, mes, estado, ciclo } = cenario({
        'inj07/parada': [],
        'inj07/op_rfid': [],
        'inj07/ciclo': [leitura('c1', '10:00:00', 25000, '500101'), leitura('c2', '10:05:00', 24000, '500102'), leitura('c3', '10:06:00', 24500, '500102')],
        'inj07/injecao_hora': [leitura('h1', '10:00:30', 100, '500101'), leitura('h2', '10:15:00', 12, '500102')],
    }, [comOpDoContexto]);

    await ciclo(T('10:16:00'));

    assert.deepEqual(mes.entregas().map((c) => c.tipo), ['ordem', 'sinais', 'ordem', 'sinais']);
    assert.deepEqual(ordens(mes), [
        { tipo: 'ordem', estacaoId: 7, order_no: '500101', occurred_at: '2026-10-19T07:00:00.000-03:00', when_blocked: 'park' },
        { tipo: 'ordem', estacaoId: 7, order_no: '500102', occurred_at: '2026-10-19T07:05:00.000-03:00', when_blocked: 'park' },
    ]);
    // A contagem das 10:15 (OP nova, desde 0) vai depois da troca.
    assert.deepEqual(mes.entregas()[3].leituras.map((l) => l.node_id), ['inj07/ciclo', 'inj07/ciclo', 'inj07/injecao_hora']);
    assert.deepEqual(estado.opDaMaquina('inj07'), { op: '500102', bloqueada: false, tentativa: T('10:05:00').getTime() });

    // Mais ciclos da mesma OP não chamam o OpenMES de novo.
    jk.adicionar('inj07/ciclo', leitura('c4', '10:16:30', 24800, '500102'));
    await ciclo(T('10:17:00'));
    assert.equal(ordens(mes).length, 2);
});

test('OP do context: o cartão de OP já conta como troca', async () => {
    const { mes, ciclo } = cenario({
        'inj07/parada': [],
        'inj07/injecao_hora': [],
        'inj07/op_rfid': [{ id: 'o1', ts: T('10:04:00'), value: 1, context: op('500102') }],
        'inj07/ciclo': [leitura('c1', '10:00:00', 25000, '500101'), leitura('c2', '10:05:00', 24000, '500102')],
    }, [comOpDoContexto]);

    await ciclo(T('10:06:00'));

    assert.deepEqual(ordens(mes).map((o) => [o.order_no, o.occurred_at, o.when_blocked]), [
        ['500101', '2026-10-19T07:00:00.000-03:00', 'park'],
        ['500102', '2026-10-19T07:04:00.000-03:00', 'park'],
    ]);
});

test('OP do context que o OpenMES não tem: a máquina fica sem OP, avisa e tenta de novo 15 min depois', async () => {
    const { jk, mes, estado, avisos, ciclo } = cenario({
        'inj07/parada': [],
        'inj07/injecao_hora': [],
        'inj07/op_rfid': [],
        'inj07/ciclo': [leitura('c1', '10:00:00', 25000, '999'), leitura('c2', '10:05:00', 25000, '999')],
    }, [comOpDoContexto]);
    mes.respostasOrdem['999'] = { status: 'parked', reason: 'No work order has this number.' };

    await ciclo(T('10:06:00'));
    jk.adicionar('inj07/ciclo', leitura('c3', '10:10:00', 25000, '999'));
    await ciclo(T('10:11:00'));
    jk.adicionar('inj07/ciclo', leitura('c4', '10:16:00', 25000, '999'));
    await ciclo(T('10:17:00'));

    assert.deepEqual(ordens(mes).map((o) => o.occurred_at), ['2026-10-19T07:00:00.000-03:00', '2026-10-19T07:16:00.000-03:00']);
    assert.match(avisos.join('\n'), /OP 999 não pode rodar no OpenMES \(No work order has this number\.\)/);
    assert.deepEqual(estado.opDaMaquina('inj07'), { op: '999', bloqueada: true, tentativa: T('10:16:00').getTime() });
});

const comCartoesExtras = {
    device: 'inj07',
    workstation_id: 7,
    quality_variable: { variable: 'quali_rfid', status_field: 'status' },
    changeover_variable: { variable: 'regmolde_rfid', card_field: 'regmolde_rfid', reason_code: 'changeover' },
};

test('cartão de qualidade vira inspeção na OP que roda; resultado desconhecido é ignorado com aviso', async () => {
    const { mes, avisos, ciclo } = cenario({
        'inj07/regmolde_rfid': [],
        'inj07/quali_rfid': [
            { id: 'q1', ts: T('10:00:00'), value: 1, context: { status: 'aprovado' } },
            { id: 'q2', ts: T('10:05:00'), value: 1, context: { status: 'Reprovado' } },
            { id: 'q3', ts: T('10:06:00'), value: 1, context: { status: 'talvez' } },
        ],
    }, [comCartoesExtras]);

    const r = await ciclo(T('10:10:00'));

    assert.deepEqual(mes.entregas(), [
        { tipo: 'qualidade', estacaoId: 7, passed: true, occurred_at: '2026-10-19T07:00:00.000-03:00' },
        { tipo: 'qualidade', estacaoId: 7, passed: false, occurred_at: '2026-10-19T07:05:00.000-03:00' },
    ]);
    assert.equal(r.qualidade, 2);
    assert.equal(r.descartados, 1);
    assert.match(avisos.join('\n'), /resultado de qualidade "talvez" desconhecido/);
});

test('troca de molde: a parada recebe o motivo fixo e o crachá de quem trocou', async () => {
    const { mes, ciclo } = cenario({
        'inj07/quali_rfid': [],
        'inj07/regmolde_rfid': [
            { id: 'm1', ts: T('10:00:00'), value: 1, context: { regmolde_rfid: '75' } },
            { id: 'm2', ts: T('10:30:00'), value: 1, context: {} },
        ],
    }, [comCartoesExtras]);

    const r = await ciclo(T('10:31:00'));

    assert.deepEqual(mes.entregas(), [
        { tipo: 'motivo', estacaoId: 7, reason_code: 'changeover', occurred_at: '2026-10-19T07:00:00.000-03:00', worker_card: '75' },
        { tipo: 'motivo', estacaoId: 7, reason_code: 'changeover', occurred_at: '2026-10-19T07:30:00.000-03:00' },
    ]);
    assert.equal(r.troca, 2);
});

test('série que a fonte não tem é avisada uma vez só', async () => {
    const { avisos, ciclo } = cenario({ 'inj07/quali_rfid': [] }, [comCartoesExtras]);

    await ciclo(T('10:00:00'));
    await ciclo(T('10:01:00'));

    assert.equal(avisos.filter((a) => a.includes('inj07/regmolde_rfid não encontrado')).length, 1);
});

test('OP que o OpenMES não conhece é descartada com aviso e não trava a fila', async () => {
    const { mes, avisos, ciclo } = cenario({
        'injetora01/op': [{ id: 'o1', ts: T('10:00:00'), value: 555 }],
        'injetora01/estado': [{ id: 'e1', ts: T('10:01:00'), value: 1 }],
    }, [{ device: 'injetora01', workstation_id: 3, connection_id: 1, signals: ['estado'], order_variable: 'op' }]);

    mes.falhas.ordem.push(new ErroHttp(422, { message: 'No work order has this number.' }, 'mes'));
    const r = await ciclo(T('10:02:00'));

    assert.deepEqual(mes.entregas().map((c) => c.tipo), ['sinais']);
    assert.equal(r.descartados, 1);
    assert.match(avisos.join('\n'), /No work order has this number/);
});

test('muitas leituras de sinal vão em lotes pequenos, na ordem', async () => {
    const leituras = Array.from({ length: LOTE_MAXIMO * 2 + 50 }, (_, i) => ({
        id: `p${i}`, ts: new Date(T('09:30:00').getTime() + i * 1000), value: i + 1,
    }));
    const { mes, ciclo } = cenario({ 'injetora01/produzido': leituras },
        [{ device: 'injetora01', connection_id: 1, signals: ['produzido'] }]);

    await ciclo(T('10:00:00'));

    const lotes = mes.entregas().map((c) => c.leituras);
    assert.deepEqual(lotes.map((l) => l.length), [LOTE_MAXIMO, LOTE_MAXIMO, 50]);
    assert.deepEqual(lotes.flat().map((l) => l.value), leituras.map((l) => l.value));
});

test('dispositivo inexistente no jkcontrol não impede os outros', async () => {
    const { mes, avisos, ciclo } = cenario({ 'injetora01/estado': [{ id: 'e1', ts: T('10:00:00'), value: 1 }] }, [
        { device: 'fantasma', connection_id: 1, signals: ['estado'] },
        { device: 'injetora01', connection_id: 1, signals: ['estado'] },
    ]);

    await ciclo(T('10:01:00'));

    assert.equal(mes.entregas().length, 1);
    assert.match(avisos.join('\n'), /fantasma\/estado não encontrado/);
});

test('cada conexão recebe heartbeat no fim do ciclo', async () => {
    const { mes, ciclo } = cenario({ 'a/estado': [], 'b/estado': [], 'c/estado': [] }, [
        { device: 'a', connection_id: 1, signals: ['estado'] },
        { device: 'b', connection_id: 1, signals: ['estado'] },
        { device: 'c', connection_id: 2, signals: ['estado'] },
    ]);

    await ciclo(T('10:00:00'));

    assert.deepEqual(mes.chamadas.filter((c) => c.tipo === 'heartbeat').map((c) => c.conexaoId), [1, 2]);
});
