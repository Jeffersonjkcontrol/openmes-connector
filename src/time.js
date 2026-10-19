// Datas no fuso do OpenMES.
//
// O endpoint de sinais do OpenMES (/machine-connections/{id}/signals) grava o
// "relógio de parede" do timestamp recebido SEM converter para o fuso da
// aplicação. Mandar "11:00Z" para um OpenMES com APP_TIMEZONE=America/Sao_Paulo
// grava 11:00 — três horas no futuro. Por isso todo horário enviado sai com o
// deslocamento do fuso configurado: "2026-10-19T08:00:00.000-03:00".

const formatos = new Map();

function formatador(timeZone) {
    if (!formatos.has(timeZone)) {
        formatos.set(timeZone, new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZoneName: 'longOffset',
        }));
    }
    return formatos.get(timeZone);
}

/** Valida o nome do fuso logo na partida — erro de digitação aqui desloca tudo. */
export function validarFuso(timeZone) {
    formatador(timeZone);
    return timeZone;
}

export function formatarNoFuso(data, timeZone) {
    const partes = Object.fromEntries(
        formatador(timeZone).formatToParts(data).map((p) => [p.type, p.value]),
    );

    // "GMT-03:00", "GMT+05:30" ou só "GMT" (UTC)
    const nome = partes.timeZoneName.replace('GMT', '');
    const deslocamento = nome === '' ? '+00:00' : nome;
    const ms = String(data.getUTCMilliseconds()).padStart(3, '0');

    return `${partes.year}-${partes.month}-${partes.day}T${partes.hour}:${partes.minute}:${partes.second}.${ms}${deslocamento}`;
}
