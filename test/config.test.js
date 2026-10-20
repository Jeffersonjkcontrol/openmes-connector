import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { carregarConfig, normalizarMaquinas } from '../src/config.js';

test('cada variável vira uma série com o tipo certo', () => {
    const [m] = normalizarMaquinas([{
        device: 'injetora01',
        workstation_id: 3,
        connection_id: 1,
        signals: ['estado', { variable: 'produzido', node_id: 'INJ01.good' }],
        operator_variable: 'operador',
        reason_variable: 'motivo_parada',
    }]);

    assert.equal(m.dispositivo, 'injetora01');
    assert.deepEqual(m.series, [
        { variavel: 'estado', tipo: 'sinal', nodeId: 'injetora01/estado' },
        { variavel: 'produzido', tipo: 'sinal', nodeId: 'INJ01.good' },
        { variavel: 'operador', tipo: 'operador' },
        { variavel: 'motivo_parada', tipo: 'motivo' },
    ]);
});

test('contagem acumulada e campos de cartão/motivo no context', () => {
    const [m] = normalizarMaquinas([{
        device: 'injetora000',
        workstation_id: 9,
        connection_id: 2,
        signals: ['parada', { variable: 'injecao_hora', accumulate: 'sum' }],
        operator_variable: { variable: 'fun_rfid', card_field: 'fun_rfid' },
        reason_variable: { variable: 'maq_rfid' },
    }]);

    assert.deepEqual(m.series, [
        { variavel: 'parada', tipo: 'sinal', nodeId: 'injetora000/parada' },
        { variavel: 'injecao_hora', tipo: 'sinal', nodeId: 'injetora000/injecao_hora', acumular: 'soma' },
        { variavel: 'fun_rfid', tipo: 'operador', campo: 'fun_rfid' },
        { variavel: 'maq_rfid', tipo: 'motivo' },
    ]);

    const [comOp] = normalizarMaquinas([{
        device: 'injetora000', workstation_id: 9, order_variable: { variable: 'op_rfid', code_field: 'op_rfid' },
    }]);
    assert.deepEqual(comOp.series, [{ variavel: 'op_rfid', tipo: 'ordem', campo: 'op_rfid' }]);
    assert.throws(() => normalizarMaquinas([{ device: 'a', order_variable: 'op' }]), /workstation_id/);

    const base = { device: 'a', workstation_id: 1, connection_id: 1 };
    assert.throws(() => normalizarMaquinas([{ ...base, signals: [{ variable: 'x', accumulate: 'max' }] }]), /accumulate.*"sum" ou "running"/);

    const [corrente] = normalizarMaquinas([{ ...base, signals: [{ variable: 'injecao_hora', accumulate: 'running', reset_field: 'op_rfid' }] }]);
    assert.deepEqual(corrente.series, [
        { variavel: 'injecao_hora', tipo: 'sinal', nodeId: 'a/injecao_hora', acumular: 'corrente', campoZeramento: 'op_rfid' },
    ]);
    assert.throws(() => normalizarMaquinas([{ ...base, signals: [{ variable: 'x', accumulate: 'sum', reset_field: 'op_rfid' }] }]), /reset_field/);
    assert.throws(() => normalizarMaquinas([{ ...base, signals: [{ variable: 'x', accumulate: 'running', reset_field: '' }] }]), /reset_field/);
    assert.throws(() => normalizarMaquinas([{ ...base, operator_variable: { card_field: 'uid' } }]), /operator_variable.*precisa ser/);
    assert.throws(() => normalizarMaquinas([{ ...base, reason_variable: { variable: 'm', code_field: 7 } }]), /code_field/);
});

test('erros de configuração dizem onde está o problema', () => {
    assert.throws(() => normalizarMaquinas([]), /machines/);
    assert.throws(() => normalizarMaquinas([{ signals: ['estado'] }]), /machines\[0\].*device/);
    assert.throws(() => normalizarMaquinas([{ device: 'a', signals: ['estado'] }]), /connection_id/);
    assert.throws(() => normalizarMaquinas([{ device: 'a', operator_variable: 'operador' }]), /workstation_id/);
    assert.throws(() => normalizarMaquinas([{ device: 'a' }]), /nada para ler/);
    assert.throws(
        () => normalizarMaquinas([{ device: 'a', connection_id: 1, signals: ['ciclo'], order_context_field: 'op_rfid' }]),
        /workstation_id.*order_context_field/,
    );
    assert.throws(
        () => normalizarMaquinas([{ device: 'a', workstation_id: 1, connection_id: 1, signals: ['ciclo'], order_context_field: '' }]),
        /order_context_field/,
    );
    const [comOp] = normalizarMaquinas([{ device: 'a', workstation_id: 1, connection_id: 1, signals: ['ciclo'], order_context_field: 'op_rfid' }]);
    assert.equal(comOp.campoOpContexto, 'op_rfid');

    const [cartoes] = normalizarMaquinas([{
        device: 'a',
        workstation_id: 1,
        quality_variable: { variable: 'quali_rfid', status_field: 'status' },
        changeover_variable: { variable: 'regmolde_rfid', card_field: 'regmolde_rfid', reason_code: 'changeover' },
    }]);
    assert.deepEqual(cartoes.series, [
        { variavel: 'quali_rfid', tipo: 'qualidade', campo: 'status' },
        { variavel: 'regmolde_rfid', tipo: 'troca', campo: 'regmolde_rfid', codigoMotivo: 'changeover' },
    ]);
    assert.throws(() => normalizarMaquinas([{ device: 'a', workstation_id: 1, changeover_variable: { variable: 'regmolde_rfid' } }]), /reason_code/);
    assert.throws(() => normalizarMaquinas([{ device: 'a', quality_variable: 'quali_rfid' }]), /workstation_id/);
    assert.throws(
        () => normalizarMaquinas([{ device: 'a', connection_id: 1, signals: ['estado', 'estado'] }]),
        /a\/estado aparece mais de uma vez/,
    );
});

test('carrega .env + config.json com padrões', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conector-'));
    const arquivo = join(dir, 'config.json');
    writeFileSync(arquivo, JSON.stringify({ machines: [{ device: 'a', connection_id: 1, signals: ['estado'] }] }));

    const config = carregarConfig({
        CONFIG_FILE: arquivo,
        JKCONTROL_TOKEN: 'ag_x',
        OPENMES_URL: 'http://localhost:8080',
        OPENMES_USERNAME: 'conector',
        OPENMES_PASSWORD: 'segredo',
    });

    assert.deepEqual(config.fonte, { tipo: 'jkcontrol', baseUrl: 'https://jkcontrol.online', token: 'ag_x' });
    assert.equal(config.fuso, 'America/Sao_Paulo');
    assert.equal(config.intervaloMs, 15_000);
    assert.equal(config.sobreposicaoMs, 15 * 60_000);
    assert.equal(config.maquinas.length, 1);
});

test('SOURCE=ubidots lê da Ubidots com o token dela', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conector-'));
    const arquivo = join(dir, 'config.json');
    writeFileSync(arquivo, JSON.stringify({ machines: [{ device: 'a', connection_id: 1, signals: ['estado'] }] }));
    const base = { CONFIG_FILE: arquivo, OPENMES_URL: 'http://x', OPENMES_TOKEN: 't', SOURCE: 'ubidots' };

    const config = carregarConfig({ ...base, UBIDOTS_TOKEN: 'BBUS-x' });
    assert.deepEqual(config.fonte, { tipo: 'ubidots', baseUrl: 'https://industrial.api.ubidots.com', token: 'BBUS-x' });

    // O token do jkcontrol não serve no lugar do da Ubidots.
    assert.throws(() => carregarConfig({ ...base, JKCONTROL_TOKEN: 'ag_x' }), /UBIDOTS_TOKEN/);
    assert.throws(() => carregarConfig({ ...base, SOURCE: 'thingsboard', UBIDOTS_TOKEN: 'BBUS-x' }), /SOURCE/);
});

test('sem credenciais do OpenMES ou com número inválido não sobe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conector-'));
    const arquivo = join(dir, 'config.json');
    writeFileSync(arquivo, JSON.stringify({ machines: [{ device: 'a', connection_id: 1, signals: ['estado'] }] }));
    const base = { CONFIG_FILE: arquivo, JKCONTROL_TOKEN: 'ag_x', OPENMES_URL: 'http://x' };

    assert.throws(() => carregarConfig(base), /OPENMES_USERNAME/);
    assert.throws(() => carregarConfig({ ...base, OPENMES_TOKEN: 't', POLL_INTERVAL_SECONDS: '0' }), /POLL_INTERVAL_SECONDS/);
    assert.throws(() => carregarConfig({ ...base, OPENMES_TOKEN: 't', OPENMES_TIMEZONE: 'Brasil/Atibaia' }));
});
