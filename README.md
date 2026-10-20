# openmes-connector

Serviço que lê os dados das máquinas na **API do jkcontrol.online** e alimenta o **OpenMES**:
estado da máquina, contadores, login/logout de operador por cartão RFID e motivo de parada.

```
dispositivo ──MQTT──▶ jkcontrol.online ──API REST (leitura)──▶ conector ──API REST──▶ OpenMES
```

O conector só **lê** o jkcontrol.online (token de leitura) — nada muda na plataforma em produção.

Repositórios do projeto:

| Repositório | Papel |
|---|---|
| [`openmes`](https://github.com/Jeffersonjkcontrol/openmes) | OpenMES (branch `jk`), quase sem alterações |
| [`openmes-jkcontrol`](https://github.com/Jeffersonjkcontrol/openmes-jkcontrol) | Módulo do OpenMES: cartão RFID e motivo de parada |
| `openmes-connector` (este) | Este serviço |

## Como funciona

A cada ciclo (15 s), para cada variável configurada:

1. Lê o histórico no jkcontrol desde o último ciclo, **menos uma janela de sobreposição** (15 min)
   que pega leituras que chegaram com atraso. A leitura é paginada e com janela fechada.
2. Descarta o que já foi entregue (pelo `_id` da leitura).
3. Junta tudo, **ordena pelo horário do dispositivo** e entrega ao OpenMES nessa ordem:
   - estado e contadores → endpoint nativo `POST /api/v1/machine-connections/{id}/signals`, em lote;
   - cartão → `POST /api/v1/jk/operator-events` (módulo JkControl);
   - motivo de parada → `POST /api/v1/jk/workstations/{id}/downtime-reason` (módulo JkControl).
4. Grava o progresso em `data/state.json` depois de cada entrega.

## O que o dispositivo publica

Tópico `v1.6/devices/{dispositivo}/{variável}` no jkcontrol.online:

| Variável (exemplo) | `value` | `context` |
|---|---|---|
| `estado` | 0 parada, 1 rodando, 2 falha | — |
| `produzido` / `refugo` | total **acumulado** | — |
| `operador` | 1 login, 0 logout | `{"uid": "04A1B2C3"}` |
| `motivo_parada` | código do motivo (0 = sem motivo) | opcional `{"reason_code": "MAT-01"}` para códigos com letras |

Regras para o firmware, que vêm da ingestão do jkcontrol e do OpenMES:

- **`value` sempre numérico.** O jkcontrol descarta texto; por isso o UID vai no `context`.
- **Contador acumulado e salvo em flash.** Se o total diminuir (reboot zerando), o OpenMES trava o contador até alguém
  refazer a base na tela dele.
- **`timestamp` no payload em epoch milissegundos.** Eventos guardados com o dispositivo offline mantêm a hora real.
- **Não publique a mesma variável duas vezes em menos de 250 ms.** O jkcontrol grava só a última.

## Preparar o OpenMES

1. **Fuso**: em *Configurações*, fuso horário `America/Sao_Paulo` — o mesmo de `OPENMES_TIMEZONE`.
2. **Módulo**: instale e ative o [`openmes-jkcontrol`](https://github.com/Jeffersonjkcontrol/openmes-jkcontrol)
   (*Admin → Modules*).
3. **Usuário do conector**: crie um usuário com papel **Supervisor**, entre uma vez pela interface e troque a senha.
   Enquanto a troca estiver pendente, o token dele só serve para trocar a senha e o conector avisa isso no log.
4. **Conectividade**: crie uma conexão do tipo **REST** e, para cada máquina, tags vinculadas à máquina com o endereço
   `{dispositivo}/{variável}`. A interface do OpenMES v0.27.0 só cria conexões Modbus, OPC UA e MQTT; a REST é
   criada pelos models do próprio OpenMES, como faz o `sim/preparar-openmes.php` (veja
   [Testar sem o jkcontrol](#testar-sem-o-jkcontrol-simulador)):
   - `injetora01/estado` — sinal *state*, mapa de valores `{"0":"STOPPED","1":"RUNNING","2":"FAULT"}`.
     A parada abre e fecha sozinha (STOPPED/FAULT = não planejada).
   - `injetora01/produzido` — *good_count*; `injetora01/refugo` — *reject_count*. A contagem vai para a ordem de
     produção ativa na máquina.
5. **Motivos de parada**: cadastre com o **código** igual ao que o operador digita na máquina (ex.: `12`).
6. **Funcionários**: preencha o campo **RFID card** de cada um com o UID do cartão (qualquer formato:
   `04:A1:B2:C3`, `04a1b2c3`…).

No jkcontrol.online: gere um token de API `ag_...` com papel **viewer** na organização do cliente.

## Configurar

```bash
cp .env.example .env                 # credenciais e intervalos
cp config.example.json config.json   # máquinas
```

`config.json` — uma entrada por máquina:

| Campo | |
|---|---|
| `device` | label do dispositivo no jkcontrol |
| `workstation_id` | id da máquina no OpenMES (obrigatório com `operator_variable`/`reason_variable`) |
| `connection_id` | id da conexão REST no OpenMES (obrigatório com `signals`) |
| `signals` | variáveis de estado/contador. O endereço da tag é `{device}/{variável}`; para outro, use `{"variable": "estado", "node_id": "INJ01.state"}`. Para uma variável que traz a **contagem do período** (zera a cada envio), use `{"variable": "injecao_hora", "accumulate": "sum"}`: o conector entrega o total acumulado, que é o que o contador do OpenMES espera |
| `operator_variable` | variável do cartão RFID. Se o UID vem em outro campo do `context`, use `{"variable": "fun_rfid", "card_field": "fun_rfid"}` |
| `reason_variable` | variável do motivo de parada. Se o código vem num campo do `context` (e o valor é sempre 1), use `{"variable": "maq_rfid", "code_field": "maq_rfid"}` |

Exemplo para o firmware Nitron v1.5 (injetora), que não segue o contrato acima:

```json
{
  "device": "injetora01",
  "workstation_id": 2,
  "connection_id": 2,
  "signals": ["parada", { "variable": "injecao_hora", "accumulate": "sum" }],
  "operator_variable": { "variable": "fun_rfid", "card_field": "fun_rfid" },
  "reason_variable": { "variable": "maq_rfid", "code_field": "maq_rfid" }
}
```

Com tags `injetora01/parada` (*state*, mapa `{"0":"RUNNING","1":"STOPPED"}`) e `injetora01/injecao_hora`
(*good_count*, escala = cavidades do molde, para contar peças e não injeções).

## Rodar

**Node 20.12 ou mais novo** (sem dependências para instalar):

```bash
npm start          # roda em ciclo
npm run once       # um ciclo só, útil para testar a configuração
```

**Docker:**

```bash
docker build -t openmes-connector .
docker run -d --name openmes-connector --restart unless-stopped \
  --env-file .env \
  -v "$PWD/config.json:/app/config.json:ro" \
  -v openmes-connector-data:/app/data \
  openmes-connector
```

Com o OpenMES no Docker Desktop da mesma máquina, use `OPENMES_URL=http://host.docker.internal:<porta do OpenMES>`.

## Comportamento

- **Sinal de máquina nunca anda para trás.** Uma leitura de estado ou contador mais antiga que a última entregue é
  ignorada (com aviso). Um estado velho entregue depois de um novo faria o OpenMES parar a máquina agora, e o
  contador do OpenMES recusa leitura fora de ordem.
- **Cartão e motivo atrasados são entregues.** O módulo acha a parada pelo horário, com 30 min de tolerância depois
  da retomada.
- **Atraso maior que `OVERLAP_MINUTES` não é lido.** Se os dispositivos ficam offline por mais tempo, aumente o valor.
- **Erros**:
  - Recusa definitiva do OpenMES (400/404/409/422 — cartão desconhecido, parada não encontrada, motivo já dado por
    uma pessoa) é descartada com aviso, para não travar a fila.
  - Rede, 5xx, 401, 403 e 429 interrompem o ciclo, e tudo é tentado de novo, com espera crescente até 5 min.
- **Token do OpenMES expira** (15 min por padrão): com usuário e senha, o conector faz login de novo sozinho.
- **Fuso**: o endpoint `/signals` do OpenMES grava o horário recebido sem converter. O conector envia sempre com o
  deslocamento do fuso da fábrica (`2026-10-19T08:00:00.000-03:00`); por isso `OPENMES_TIMEZONE` precisa ser igual
  ao fuso configurado no OpenMES.
- **Contagem acumulada** (`accumulate`): o total só cresce e fica no `data/state.json`. Contagem que chega atrasada
  ainda soma, com o horário da última entregue. Por causa do contador "legado" do OpenMES, que usa a primeira leitura
  como base (não a conta) e guarda o último total em cache por 1 dia:
  - a primeira entrega da série manda antes uma leitura base 0;
  - período sem produção (0) também é enviado, para o cache não expirar num fim de semana parado.
- **Lotes de 100 leituras e 60 s de espera** no OpenMES. O contador "legado" do OpenMES (sem ordem configurada) não
  ignora leitura repetida: se uma chamada estoura o tempo depois de o OpenMES gravar, o reenvio conta de novo.
  Lote pequeno mantém cada chamada longe do limite.
- **Recomeçar do zero**: apague `data/state.json`. O próximo ciclo relê `INITIAL_LOOKBACK_MINUTES`. Com
  `accumulate`, o total volta a zero e o OpenMES vê o contador "diminuir": limpe também o histórico daquela conexão
  no OpenMES ou comece por uma conexão nova.

## Testar sem o jkcontrol (simulador)

A pasta `sim/` tem um jkcontrol simulado para testar o conector ponta a ponta contra um OpenMES de teste, sem tocar
na produção:

- `sim/servidor.js`: responde a API de histórico como o jkcontrol (token, janela, paginação) e recebe as leituras por
  `POST /sim/publicar` no lugar do MQTT, com as mesmas regras (valor numérico, até 30 dias para trás e 5 min para
  frente, só a última leitura em 250 ms). `GET /sim/series` mostra o que está guardado.
- `sim/maquina.js`: publica o que o leitor da máquina publicaria.
  - `historico [minutos]`: grava um turno de exemplo terminando agora (login do cartão, produção, parada com motivo
    `12`, falha com `breakdown`, logout). Só para um dispositivo sem leituras.
  - `ao-vivo`: continua produzindo, parando e retomando até Ctrl+C.
- `sim/preparar-openmes.php`: cria no OpenMES de teste o usuário `conector` (Supervisor, sem troca de senha
  pendente), o funcionário `TESTE-01` com o cartão `04:A1:B2:C3`, o motivo `12`, a conexão REST e as tags
  `torno01/*` no posto `LATHE-01` (do exemplo *Precision machine shop*). Pode rodar de novo.

Com o OpenMES do `install.sh --dev` (containers `openmes-52q-*`), tudo em containers Node na rede dele:

```bash
# 1. OpenMES: imprime os ids para o config.json (device "torno01")
SENHA=$(head -c 48 /dev/urandom | base64 | tr -dc A-Za-z0-9 | cut -c1-32)
CONECTOR_SENHA="$SENHA" docker exec -i -e CONECTOR_SENHA openmes-52q-backend php < sim/preparar-openmes.php
#    .env: JKCONTROL_URL=http://jk-simulador:8090   JKCONTROL_TOKEN=ag_simulador
#          OPENMES_URL=http://openmes-52q-backend:8000   OPENMES_USERNAME=conector   OPENMES_PASSWORD=$SENHA

# 2. Simulador
docker run -d --name jk-simulador --user 1000:1000 --network openmes-52q_openmmes-network -p 8090:8090 \
  -v "$PWD:/app" -w /app -e SIM_ARQUIVO=/app/data/simulador.json node:20-alpine node sim/servidor.js

# 3. Um turno de 40 min e um ciclo do conector
docker run --rm --user 1000:1000 --network openmes-52q_openmmes-network -v "$PWD:/app" -w /app \
  -e SIM_URL=http://jk-simulador:8090 node:20-alpine node sim/maquina.js historico 40
docker run --rm --user 1000:1000 --network openmes-52q_openmmes-network -v "$PWD:/app" -w /app \
  node:20-alpine node src/index.js --once
```

Para ver a máquina andando nas telas do OpenMES, rode `sim/maquina.js ao-vivo` e o conector sem `--once`. Para
recomeçar: `docker rm -f jk-simulador` e apague `data/simulador.json` e `data/state.json`.

Validado assim em 19/10/2026 (turno de 40 min e mais ~1 min ao vivo): estados e paradas na hora local, motivos `12`
e `breakdown` aplicados pelo usuário `conector`, duas sessões do cartão virando atividade no apontamento, contadores
somando 218 boas e 7 refugos, e um segundo ciclo sem reenvio. Sem ordem de produção configurada no contador, a
contagem fica como eventos de contador da máquina (modo legado do OpenMES).

## Testes

```bash
npm test
```

São 38 testes, incluindo um ciclo completo por HTTP contra um jkcontrol e um OpenMES simulados (paginação, token
expirando, ordem de entrega e fuso) e o simulador lido pelo próprio cliente do conector. O fluxo também foi validado
contra o OpenMES v0.27.0 real com PostgreSQL e o módulo ativado:
- estados gravados na hora local;
- parada aberta e fechada pelo estado, com o motivo `12` aplicado;
- sessão do operador virando atividade no apontamento;
- contadores gerando eventos;
- segundo ciclo sem reenviar nada.
