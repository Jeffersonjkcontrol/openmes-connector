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
        { variavel: 'injecao_hora', tipo: 'sinal', nodeId: 'injetora000/injecao_hora', acumular: true },
        { variavel: 'fun_rfid', tipo: 'operador', campo: 'fun_rfid' },
        { variavel: 'maq_rfid', tipo: 'motivo' },
    ]);

    const base = { device: 'a', workstation_id: 1, connection_id: 1 };
    assert.throws(() => normalizarMaquinas([{ ...base, signals: [{ variable: 'x', accumulate: 'max' }] }]), /accumulate.*"sum"/);
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

    assert.equal(config.jkcontrol.baseUrl, 'https://jkcontrol.online');
    assert.equal(config.fuso, 'America/Sao_Paulo');
    assert.equal(config.intervaloMs, 15_000);
    assert.equal(config.sobreposicaoMs, 15 * 60_000);
    assert.equal(config.maquinas.length, 1);
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
