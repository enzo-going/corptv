'use strict';

const SLIDE_TYPES = new Set(['txt', 'img', 'vid']);
const VIDEO_TEXT_MODES = new Set(['none', 'fixed', 'timed']);
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function normalizeText(value, field, maxLength, required) {
  if (value === undefined || value === null) {
    if (required) return { error: `${field} é obrigatório.` };
    return { value: '' };
  }
  if (typeof value !== 'string') return { error: `${field} deve ser texto.` };
  const normalized = value.trim();
  if (required && !normalized) return { error: `${field} é obrigatório.` };
  if (normalized.length > maxLength) {
    return { error: `${field} deve ter no máximo ${maxLength} caracteres.` };
  }
  return { value: normalized };
}

function normalizeColor(value, fallback) {
  const color = value || fallback;
  if (!COLOR_PATTERN.test(color)) return { error: 'Cor inválida.' };
  return { value: color.toLowerCase() };
}

function normalizeDuration(value, type) {
  if (type === 'vid') return { value: 0 };
  const duration = Number.parseInt(value, 10);
  if (!Number.isInteger(duration) || duration < 3 || duration > 300) {
    return { error: 'A duração deve estar entre 3 e 300 segundos.' };
  }
  return { value: duration };
}

function normalizeVideoText(body, type, options) {
  const settings = options || {};
  const current = settings.current || {};
  if (type !== 'vid') return { value: { video_text_mode: 'none', video_text_seconds: 0 } };

  const rawMode = body.video_text_mode === undefined
    ? (current.video_text_mode || 'fixed')
    : body.video_text_mode;
  if (typeof rawMode !== 'string' || !VIDEO_TEXT_MODES.has(rawMode)) {
    return { error: 'Modo do texto do vídeo inválido.' };
  }

  if (rawMode !== 'timed') {
    return { value: { video_text_mode: rawMode, video_text_seconds: 0 } };
  }

  const rawSeconds = body.video_text_seconds === undefined
    ? (current.video_text_seconds || 5)
    : body.video_text_seconds;
  const seconds = Number.parseInt(rawSeconds, 10);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
    return { error: 'O texto temporário deve ficar entre 1 e 300 segundos.' };
  }
  return { value: { video_text_mode: rawMode, video_text_seconds: seconds } };
}

function validateSlideInput(body = {}, options) {
  const settings = options || {};
  const partial = settings.partial === true;
  const hasFile = settings.hasFile === true;
  const fileType = settings.fileType || null;
  const value = {};

  if (!partial || body.title !== undefined) {
    const title = normalizeText(body.title, 'Título', 120, false);
    if (title.error) return title;
    value.title = title.value;
  }
  if (!partial || body.body !== undefined) {
    const text = normalizeText(body.body, 'Texto', 500, false);
    if (text.error) return text;
    value.body = text.value;
  }

  const currentType = settings.current && settings.current.type;
  const type = fileType || body.type || currentType || 'txt';
  if ((!partial || fileType || body.type !== undefined) && !SLIDE_TYPES.has(type)) {
    return { error: 'Tipo de slide inválido.' };
  }
  if (!partial || body.type !== undefined || fileType) value.type = type;

  if (!partial || body.duration !== undefined || fileType) {
    const duration = normalizeDuration(body.duration === undefined ? '8' : body.duration, type);
    if (duration.error) return duration;
    value.duration = duration.value;
  }
  if (!partial || body.bg !== undefined) {
    const color = normalizeColor(body.bg, '#111111');
    if (color.error) return color;
    value.bg = color.value;
  }

  const shouldNormalizeVideoText = !partial || fileType ||
    body.video_text_mode !== undefined || body.video_text_seconds !== undefined;
  if (shouldNormalizeVideoText) {
    const videoText = normalizeVideoText(body, type, { current: settings.current });
    if (videoText.error) return videoText;
    Object.assign(value, videoText.value);
  }

  if (!partial && !value.title && !hasFile) {
    return { error: 'Título ou arquivo obrigatório.' };
  }
  return { value };
}

function validateGroupInput(body = {}) {
  const name = normalizeText(body.name, 'Nome', 80, true);
  if (name.error) return name;
  const color = normalizeColor(body.color, '#378ADD');
  if (color.error) return color;
  return { value: { name: name.value, color: color.value } };
}

function validateScreenInput(body = {}) {
  const name = normalizeText(body.name, 'Nome', 80, true);
  if (name.error) return name;
  const groupId = normalizeText(body.group_id, 'Grupo', 80, true);
  if (groupId.error) return groupId;
  return { value: { name: name.value, group_id: groupId.value } };
}

module.exports = {
  normalizeColor,
  normalizeDuration,
  normalizeText,
  normalizeVideoText,
  validateGroupInput,
  validateScreenInput,
  validateSlideInput
};
