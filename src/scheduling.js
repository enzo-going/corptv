'use strict';

const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

function toMinutes(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function parseDays(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : String(value).split(',');
  return Array.from(new Set(values
    .map(item => Number.parseInt(item, 10))
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)));
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function scheduleFromBody(body) {
  return {
    starts_at: toIso(body.starts_at),
    expires_at: toIso(body.expires_at),
    days: parseDays(body.days),
    time_start: body.time_start || null,
    time_end: body.time_end || null
  };
}

function validarAgendamento(schedule, rawBody) {
  const raw = rawBody || schedule;
  if (raw.starts_at && !schedule.starts_at) return 'A data de início é inválida.';
  if (raw.expires_at && !schedule.expires_at) return 'A data de expiração é inválida.';

  if (schedule.starts_at && schedule.expires_at) {
    const start = new Date(schedule.starts_at);
    const end = new Date(schedule.expires_at);
    if (end < start) return 'A data de expiração é anterior à data de início.';
    if (end.getTime() === start.getTime()) {
      return 'O início e a expiração são iguais: o slide nunca apareceria.';
    }
  }

  if (schedule.time_start && !schedule.time_end) return 'Informe também o horário de fim.';
  if (schedule.time_end && !schedule.time_start) return 'Informe também o horário de início.';

  const startMinutes = toMinutes(schedule.time_start);
  const endMinutes = toMinutes(schedule.time_end);
  if (schedule.time_start && startMinutes === null) return 'O horário de início é inválido.';
  if (schedule.time_end && endMinutes === null) return 'O horário de fim é inválido.';
  if (startMinutes !== null && endMinutes !== null && startMinutes === endMinutes) {
    return 'O horário de início e de fim são iguais: o slide nunca apareceria.';
  }
  return null;
}

function effectiveScheduleDay(now, startMinutes, endMinutes) {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const crossesMidnight = startMinutes !== null && endMinutes !== null && endMinutes < startMinutes;
  if (crossesMidnight && currentMinutes <= endMinutes) return (now.getDay() + 6) % 7;
  return now.getDay();
}

function slideStatus(slide, now) {
  const current = now || new Date();

  if (slide.starts_at && current < new Date(slide.starts_at)) {
    return { active: false, reason: 'aguardando', detail: 'ainda não chegou a data de início' };
  }
  if (slide.expires_at && current > new Date(slide.expires_at)) {
    return { active: false, reason: 'expirado', detail: 'o prazo já passou' };
  }

  const startMinutes = toMinutes(slide.time_start);
  const endMinutes = toMinutes(slide.time_end);
  const scheduleDay = effectiveScheduleDay(current, startMinutes, endMinutes);
  if (Array.isArray(slide.days) && slide.days.length && !slide.days.includes(scheduleDay)) {
    const names = slide.days.slice().sort((a, b) => a - b).map(day => DIAS_CURTOS[day]).join('/');
    return { active: false, reason: 'fora_do_dia', detail: 'só toca ' + names };
  }

  if (startMinutes !== null && endMinutes !== null) {
    const currentMinutes = current.getHours() * 60 + current.getMinutes();
    const inside = startMinutes <= endMinutes
      ? currentMinutes >= startMinutes && currentMinutes <= endMinutes
      : currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    if (!inside) {
      return {
        active: false,
        reason: 'fora_do_horario',
        detail: 'só toca das ' + slide.time_start + ' às ' + slide.time_end
      };
    }
  }
  return { active: true, reason: null, detail: null };
}

function slideActive(slide, now) {
  return slideStatus(slide, now).active;
}

// Tempo pelo qual uma cópia offline ainda pode exibir este slide com segurança.
// null significa que não há uma transição de agenda conhecida no futuro.
function activeForMs(slide, now) {
  const current = now || new Date();
  if (!slideActive(slide, current)) return 0;

  const deadlines = [];
  if (slide.expires_at) deadlines.push(new Date(slide.expires_at).getTime() + 1000);

  const startMinutes = toMinutes(slide.time_start);
  const endMinutes = toMinutes(slide.time_end);
  if (startMinutes !== null && endMinutes !== null) {
    const currentMinutes = current.getHours() * 60 + current.getMinutes();
    const deadline = new Date(current);
    deadline.setSeconds(0, 0);
    deadline.setHours(Math.floor(endMinutes / 60), (endMinutes % 60) + 1, 0, 0);
    if (endMinutes < startMinutes && currentMinutes >= startMinutes) deadline.setDate(deadline.getDate() + 1);
    deadlines.push(deadline.getTime());
  } else if (Array.isArray(slide.days) && slide.days.length && slide.days.length < 7) {
    for (let offset = 1; offset <= 7; offset += 1) {
      const nextDay = (current.getDay() + offset) % 7;
      if (!slide.days.includes(nextDay)) {
        const deadline = new Date(current);
        deadline.setHours(0, 0, 0, 0);
        deadline.setDate(deadline.getDate() + offset);
        deadlines.push(deadline.getTime());
        break;
      }
    }
  }

  if (!deadlines.length) return null;
  return Math.max(0, Math.min(...deadlines) - current.getTime());
}

module.exports = {
  activeForMs,
  parseDays,
  scheduleFromBody,
  slideActive,
  slideStatus,
  toIso,
  toMinutes,
  validarAgendamento
};
