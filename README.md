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
   `{dispositivo}/{variável}`:
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
| `signals` | variáveis de estado/contador. O endereço da tag é `{device}/{variável}`; para outro, use `{"variable": "estado", "node_id": "INJ01.state"}` |
| `operator_variable` | variável do cartão RFID |
| `reason_variable` | variável do motivo de parada |

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
- **Recomeçar do zero**: apague `data/state.json`. O próximo ciclo relê `INITIAL_LOOKBACK_MINUTES`.

## Testes

```bash
npm test
```

São 25 testes, incluindo um ciclo completo por HTTP contra um jkcontrol e um OpenMES simulados (paginação, token
expirando, ordem de entrega e fuso). O fluxo também foi validado contra o OpenMES v0.27.0 real com PostgreSQL e o
módulo ativado:
- estados gravados na hora local;
- parada aberta e fechada pelo estado, com o motivo `12` aplicado;
- sessão do operador virando atividade no apontamento;
- contadores gerando eventos;
- segundo ciclo sem reenviar nada.
