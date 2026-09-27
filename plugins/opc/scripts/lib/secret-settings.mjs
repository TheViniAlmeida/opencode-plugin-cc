// Shared classification for config warnings and all output redaction.
const SECRET_WORD = /(token|password|passwd|secret|apikey|credential|authorization|headers)/i;

export function isSecretLikeSetting(setting) {
  const segment = String(setting).split('.').at(-1) ?? '';
  return segment.toLowerCase() === 'key'
    || (segment.length > 3 && segment.slice(-3).toLowerCase() === 'key' && segment.at(-3) === 'K')
    || /[_-]key$/i.test(segment)
    || SECRET_WORD.test(segment);
}
