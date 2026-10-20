<?php

// Prepara um OpenMES de TESTE para receber o simulador (sim/maquina.js):
// usuário de serviço do conector, funcionário com cartão RFID, motivo de parada
// com código numérico, conexão REST e as tags da máquina. Pode rodar de novo:
// só cria o que falta e realinha o resto.
//
// Roda dentro do container do backend, com o OpenMES e o módulo JkControl ativos:
//   CONECTOR_SENHA=... docker exec -i -e CONECTOR_SENHA <backend> php < sim/preparar-openmes.php
//
// Variáveis: CONECTOR_SENHA (obrigatória), DISPOSITIVO (torno01),
// POSTO (código da máquina no OpenMES, LATHE-01), CARTAO (04:A1:B2:C3).
// Imprime os ids em JSON (nunca a senha) para montar o config.json.

require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Models\DowntimeReason;
use App\Models\MachineConnection;
use App\Models\MachineTag;
use App\Models\User;
use App\Models\Worker;
use App\Models\Workstation;
use Illuminate\Support\Facades\DB;

$senha = getenv('CONECTOR_SENHA') ?: '';
if (strlen($senha) < 16) {
    fwrite(STDERR, "CONECTOR_SENHA precisa ter pelo menos 16 caracteres.\n");
    exit(1);
}
$dispositivo = getenv('DISPOSITIVO') ?: 'torno01';
$cartao = getenv('CARTAO') ?: '04:A1:B2:C3';
$posto = Workstation::where('code', getenv('POSTO') ?: 'LATHE-01')->firstOrFail();

$ids = DB::transaction(function () use ($senha, $dispositivo, $cartao, $posto) {
    // Usuário de serviço: Supervisor, sem troca de senha pendente (o conector
    // não consegue trocar a senha sozinho).
    $usuario = User::withTrashed()->firstOrNew(['username' => 'conector']);
    $usuario->fill([
        'name' => 'Conector jkcontrol',
        'email' => 'conector@jkcontrol.local',
        'password' => $senha,
        'force_password_change' => false,
    ]);
    $usuario->deleted_at = null;
    $usuario->save();
    $usuario->syncRoles(['Supervisor']);

    $funcionario = Worker::withTrashed()->firstOrNew(['code' => 'TESTE-01']);
    $funcionario->fill(['name' => 'Operador Teste', 'is_active' => true]);
    $funcionario->setCustomField(config('jkcontrol.card_custom_field', 'rfid_card'), $cartao);
    $funcionario->deleted_at = null;
    $funcionario->save();

    // O teclado da máquina só manda número: o motivo precisa de código numérico.
    $motivo = DowntimeReason::withTrashed()->firstOrNew(['code' => '12']);
    $motivo->fill(['name' => 'Troca de ferramenta', 'kind' => 'unplanned', 'is_active' => true]);
    $motivo->deleted_at = null;
    $motivo->save();

    $conexao = MachineConnection::withTrashed()->firstOrNew([
        'name' => "{$dispositivo} (jkcontrol)",
        'protocol' => MachineConnection::PROTOCOL_REST,
    ]);
    $conexao->fill([
        'description' => 'Alimentada pelo openmes-connector (API do jkcontrol.online).',
        'line_id' => $posto->line_id,
        'is_active' => true,
    ]);
    $conexao->deleted_at = null;
    $conexao->save();

    $tags = [
        'estado' => [MachineTag::SIGNAL_STATE, ['value_map' => ['0' => 'STOPPED', '1' => 'RUNNING', '2' => 'FAULT']]],
        'produzido' => [MachineTag::SIGNAL_GOOD_COUNT, null],
        'refugo' => [MachineTag::SIGNAL_REJECT_COUNT, null],
    ];
    foreach ($tags as $variavel => [$sinal, $transform]) {
        $tag = MachineTag::withTrashed()->firstOrNew([
            'machine_connection_id' => $conexao->id,
            'address' => "{$dispositivo}/{$variavel}",
        ]);
        $tag->fill([
            'workstation_id' => $posto->id,
            'name' => "{$posto->code} {$variavel}",
            'signal_type' => $sinal,
            'data_type' => 'int32',
            'transform' => $transform,
            'is_active' => true,
        ]);
        $tag->deleted_at = null;
        $tag->save();
    }

    return [
        'workstation_id' => $posto->id,
        'workstation' => $posto->name,
        'connection_id' => $conexao->id,
        'user_id' => $usuario->id,
        'worker_id' => $funcionario->id,
        'reason_id' => $motivo->id,
    ];
});

echo json_encode($ids, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), PHP_EOL;
