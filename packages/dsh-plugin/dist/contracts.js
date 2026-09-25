/** True only for ordinary object literals with a JSON object root. */
export function isJsonObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
/** Require a JSON object and return it without widening its identity. */
export function requireJsonObject(value, label) {
    if (!isJsonObject(value))
        throw new TypeError(`${label} must be a JSON object`);
    return value;
}
