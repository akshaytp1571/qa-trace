export const REQUEST_LIMITS = Object.freeze({
  native: Object.freeze({ timeoutSeconds: 90, maxOutputTokens: 16_384 }),
  gateway: Object.freeze({
    timeoutSeconds: Object.freeze({ default: 300, min: 30, max: 300 }),
    maxOutputTokens: Object.freeze({ default: 16_384, min: 1_024, max: 16_384 }),
  }),
});

export function requestSettings(provider, timeoutSeconds, maxOutputTokens) {
  if (provider !== 'gateway') return { ...REQUEST_LIMITS.native };
  const resolved = {};
  for (const [name, input] of Object.entries({ timeoutSeconds, maxOutputTokens })) {
    const limits = REQUEST_LIMITS.gateway[name];
    const value = input === undefined ? limits.default : input;
    if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
      throw new RangeError(name);
    }
    resolved[name] = value;
  }
  return resolved;
}
